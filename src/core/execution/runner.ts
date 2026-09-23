import * as fs from 'fs';
import * as path from 'path';
import { EXIT_CODES, ExitCode, LIFECYCLE_STATES } from '../constants';
import { CampaignConfig, CampaignState, TaskDefinition } from '../types';
import { getCampaignPaths, isCampaignInitialized } from '../storage/layout';
import { readJson, atomicWriteJson } from '../storage/atomic';
import { withCampaignLock, LockContentionError } from '../concurrency/lock';
import { captureTaskBaselines, assertTaskProvenance, ProvenanceDriftError } from '../provenance/provenance';
import { getCampaignSchedule, ScheduledRun } from '../scheduler/scheduler';
import { executeEvaluator } from './driver';
import { classifyExecution } from './classifier';
import { shouldRetry } from './retry';
import { persistAttemptManifest } from './manifest';
import { AttemptManifest } from './types';

export interface RunCampaignResult {
  exitCode: ExitCode;
  totalAttempts: number;
  completedRuns: number;
  error?: string;
}

/**
 * Orchestrates campaign execution:
 * 1. Acquires campaign advisory lock.
 * 2. Validates lifecycle state.
 * 3. Captures task provenance baselines if not already captured.
 * 4. Iterates through deterministic schedule.
 * 5. Audits task provenance before EVERY attempt.
 * 6. Enforces global attempt and wall-clock budgets.
 * 7. Dispatches evaluator subprocesses with environment protocol.
 * 8. Persists atomic attempt manifests.
 * 9. Transitions campaign lifecycle state.
 */
export async function runCampaign(cwd: string = process.cwd()): Promise<RunCampaignResult> {
  if (!isCampaignInitialized(cwd)) {
    process.stderr.write('Error: Campaign is not initialized in this directory. Run "evalcampaign init" first.\n');
    return { exitCode: EXIT_CODES.USAGE_ERROR, totalAttempts: 0, completedRuns: 0, error: 'Campaign not initialized' };
  }

  try {
    return withCampaignLock(async () => {
      const paths = getCampaignPaths(cwd);
      let campaign: CampaignConfig;
      let state: CampaignState;

      try {
        campaign = readJson<CampaignConfig>(paths.campaignJson);
        state = readJson<CampaignState>(paths.stateJson);
      } catch (err) {
        process.stderr.write(`Error reading campaign state: ${(err as Error).message}\n`);
        return { exitCode: EXIT_CODES.UNRECOVERABLE_CORRUPTION, totalAttempts: 0, completedRuns: 0, error: (err as Error).message };
      }

      // Lifecycle guard: execution cannot start if already completed, failed, or paused
      if (
        state.lifecycle_state === LIFECYCLE_STATES.COMPLETED ||
        state.lifecycle_state === LIFECYCLE_STATES.FAILED ||
        state.lifecycle_state === LIFECYCLE_STATES.PAUSED
      ) {
        process.stderr.write(`Error: Cannot run campaign in "${state.lifecycle_state}" state.\n`);
        return { exitCode: EXIT_CODES.INVALID_STATE, totalAttempts: 0, completedRuns: 0, error: `Invalid state: ${state.lifecycle_state}` };
      }

      const taskFiles = fs.readdirSync(paths.tasksDir).filter(f => f.endsWith('.json'));
      const modelFiles = fs.readdirSync(paths.modelsDir).filter(f => f.endsWith('.json'));

      if (taskFiles.length === 0) {
        process.stderr.write('Error: No tasks registered in campaign. Run "evalcampaign add-task" first.\n');
        return { exitCode: EXIT_CODES.USAGE_ERROR, totalAttempts: 0, completedRuns: 0, error: 'No tasks registered' };
      }

      if (modelFiles.length === 0) {
        process.stderr.write('Error: No models registered in campaign. Run "evalcampaign add-model" first.\n');
        return { exitCode: EXIT_CODES.USAGE_ERROR, totalAttempts: 0, completedRuns: 0, error: 'No models registered' };
      }

      // Capture provenance baselines if not already captured
      const provenancePath = path.join(paths.root, 'provenance.json');
      if (!fs.existsSync(provenancePath)) {
        captureTaskBaselines(cwd);
      }

      // Transition to running state
      state.lifecycle_state = LIFECYCLE_STATES.RUNNING;
      state.updated_at = Date.now();
      atomicWriteJson(paths.stateJson, state);

      const repetitions = (campaign as any).repetitions || 1;
      const schedule: ScheduledRun[] = getCampaignSchedule(cwd, repetitions);

      let totalAttempts = (state as any).total_attempts || 0;
      let completedRuns = (state as any).completed_runs || 0;
      const campaignStartTime = Date.now();

      const maxAttempts = campaign.budget.max_total_attempts;
      const maxWallTimeSec = campaign.budget.max_wall_time_seconds;
      const maxOutputBytes = campaign.budget.max_output_bytes;

      for (const item of schedule) {
        const taskPath = path.join(paths.tasksDir, `${item.task_id}.json`);
        let taskDef: TaskDefinition;
        try {
          taskDef = readJson<TaskDefinition>(taskPath);
        } catch (err) {
          process.stderr.write(`Error reading task definition "${item.task_id}": ${(err as Error).message}\n`);
          return { exitCode: EXIT_CODES.UNRECOVERABLE_CORRUPTION, totalAttempts, completedRuns, error: (err as Error).message };
        }

        let attempt = 1;

        while (true) {
          // 1. Check Global Attempt Budget before dispatching
          if (totalAttempts >= maxAttempts) {
            process.stderr.write(`Campaign stopped: Maximum total attempts budget (${maxAttempts}) reached.\n`);
            (state as any).total_attempts = totalAttempts;
            (state as any).completed_runs = completedRuns;
            state.updated_at = Date.now();
            atomicWriteJson(paths.stateJson, state);
            return { exitCode: EXIT_CODES.BUDGET_EXCEEDED, totalAttempts, completedRuns, error: 'Attempt budget reached' };
          }

          // 2. Check Global Wall-Clock Budget before dispatching
          const elapsedSec = (Date.now() - campaignStartTime) / 1000;
          if (elapsedSec >= maxWallTimeSec) {
            process.stderr.write(`Campaign stopped: Maximum wall-time budget (${maxWallTimeSec}s) reached.\n`);
            (state as any).total_attempts = totalAttempts;
            (state as any).completed_runs = completedRuns;
            state.updated_at = Date.now();
            atomicWriteJson(paths.stateJson, state);
            return { exitCode: EXIT_CODES.BUDGET_EXCEEDED, totalAttempts, completedRuns, error: 'Wall-time budget reached' };
          }

          // 3. Verify task provenance before EVERY attempt (including retries)
          try {
            assertTaskProvenance(cwd);
          } catch (err) {
            if (err instanceof ProvenanceDriftError) {
              process.stderr.write(`Error: ${err.message}\n`);
              return { exitCode: EXIT_CODES.PROVENANCE_DRIFT, totalAttempts, completedRuns, error: err.message };
            }
            throw err;
          }

          // 4. Dispatch attempt
          totalAttempts++;

          const execResult = await executeEvaluator({
            command: taskDef.command,
            taskId: item.task_id,
            modelId: item.model_id,
            repetition: item.repetition,
            attempt,
            timeoutSeconds: taskDef.timeout_seconds,
            maxOutputBytes,
            cwd
          });

          // 5. Classify execution result
          const classification = classifyExecution(execResult);

          // 6. Persist attempt manifest atomically
          persistAttemptManifest(
            {
              runId: item.run_id,
              attempt,
              campaignId: item.campaign_id,
              campaignRev: item.campaign_rev,
              modelId: item.model_id,
              taskId: item.task_id,
              repetition: item.repetition,
              status: classification.status,
              rawScore: classification.rawScore,
              exitCode: execResult.exitCode,
              executionTimeMs: execResult.executionTimeMs,
              stdout: execResult.stdout,
              stderr: execResult.stderr
            },
            cwd
          );

          // 7. Persist updated total attempts in state.json
          (state as any).total_attempts = totalAttempts;
          state.updated_at = Date.now();
          atomicWriteJson(paths.stateJson, state);

          // 8. Determine retry
          if (shouldRetry(classification.status, attempt, taskDef.retry_policy)) {
            attempt++;
            continue;
          } else {
            completedRuns++;
            (state as any).completed_runs = completedRuns;
            state.updated_at = Date.now();
            atomicWriteJson(paths.stateJson, state);
            break;
          }
        }
      }

      // All scheduled runs finished
      state.lifecycle_state = LIFECYCLE_STATES.COMPLETED;
      state.updated_at = Date.now();
      atomicWriteJson(paths.stateJson, state);

      process.stdout.write(`Campaign "${state.campaign_id}" completed successfully. Total attempts: ${totalAttempts}, completed runs: ${completedRuns}.\n`);
      return { exitCode: EXIT_CODES.SUCCESS, totalAttempts, completedRuns };
    }, cwd);
  } catch (err) {
    if (err instanceof LockContentionError) {
      process.stderr.write(`Error: ${err.message}\n`);
      return { exitCode: EXIT_CODES.LOCK_CONTENTION, totalAttempts: 0, completedRuns: 0, error: err.message };
    }
    if (err instanceof ProvenanceDriftError) {
      process.stderr.write(`Error: ${err.message}\n`);
      return { exitCode: EXIT_CODES.PROVENANCE_DRIFT, totalAttempts: 0, completedRuns: 0, error: err.message };
    }
    process.stderr.write(`Fatal execution error: ${(err as Error).message}\n`);
    return { exitCode: EXIT_CODES.UNRECOVERABLE_CORRUPTION, totalAttempts: 0, completedRuns: 0, error: (err as Error).message };
  }
}
