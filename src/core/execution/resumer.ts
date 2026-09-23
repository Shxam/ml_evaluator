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
import { reconcileCampaignState, UnrecoverableCorruptionError } from './recovery';
import { RunCampaignResult } from './runner';

/**
 * Resumes an interrupted or incomplete campaign:
 * 1. Acquires campaign advisory lock.
 * 2. Rejects completed or failed states with exit code 4.
 * 3. Validates task provenance before resuming work.
 * 4. Cleans stale temporary files and reconciles state with surviving manifests on disk.
 * 5. Skips completed logical runs and resumes remaining unfinished work.
 * 6. Preserves logical run IDs and advances attempt numbers from existing manifests.
 * 7. Audits task provenance before EVERY resumed attempt (including retries).
 * 8. Enforces cumulative attempt budget and invocation wall-clock budget.
 */
export async function resumeCampaign(cwd: string = process.cwd()): Promise<RunCampaignResult> {
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

      // 1. Lifecycle Guards: completed or failed cannot be resumed
      if (state.lifecycle_state === LIFECYCLE_STATES.COMPLETED) {
        process.stderr.write('Error: Cannot resume campaign in "completed" state.\n');
        return { exitCode: EXIT_CODES.INVALID_STATE, totalAttempts: 0, completedRuns: 0, error: 'Cannot resume completed campaign' };
      }

      if (state.lifecycle_state === LIFECYCLE_STATES.FAILED) {
        process.stderr.write('Error: Cannot resume campaign in "failed" state.\n');
        return { exitCode: EXIT_CODES.INVALID_STATE, totalAttempts: 0, completedRuns: 0, error: 'Cannot resume failed campaign' };
      }

      const taskFiles = fs.readdirSync(paths.tasksDir).filter(f => f.endsWith('.json'));
      const modelFiles = fs.readdirSync(paths.modelsDir).filter(f => f.endsWith('.json'));

      if (taskFiles.length === 0 || modelFiles.length === 0) {
        process.stderr.write('Error: Incomplete campaign setup. Tasks or models missing.\n');
        return { exitCode: EXIT_CODES.USAGE_ERROR, totalAttempts: 0, completedRuns: 0, error: 'Tasks or models missing' };
      }

      // 2. Provenance Audit: Validate baseline before inspecting or scheduling
      const provenancePath = path.join(paths.root, 'provenance.json');
      if (fs.existsSync(provenancePath)) {
        try {
          assertTaskProvenance(cwd);
        } catch (err) {
          if (err instanceof ProvenanceDriftError) {
            process.stderr.write(`Error: ${err.message}\n`);
            return { exitCode: EXIT_CODES.PROVENANCE_DRIFT, totalAttempts: 0, completedRuns: 0, error: err.message };
          }
          throw err;
        }
      } else {
        captureTaskBaselines(cwd);
      }

      // Transition to running state
      state.lifecycle_state = LIFECYCLE_STATES.RUNNING;
      state.updated_at = Date.now();
      atomicWriteJson(paths.stateJson, state);

      const repetitions = (campaign as any).repetitions || 1;
      const schedule: ScheduledRun[] = getCampaignSchedule(cwd, repetitions);

      // 3. State Reconciliation & Manifest Discovery
      let recoveryResult: { state: CampaignState; report: any };
      try {
        recoveryResult = reconcileCampaignState(cwd, schedule);
      } catch (err) {
        if (err instanceof UnrecoverableCorruptionError) {
          process.stderr.write(`Error: ${err.message}\n`);
          return { exitCode: EXIT_CODES.UNRECOVERABLE_CORRUPTION, totalAttempts: 0, completedRuns: 0, error: err.message };
        }
        throw err;
      }

      state = recoveryResult.state;
      const report = recoveryResult.report;

      // Check if all runs are already complete
      if (report.completedLogicalRuns === schedule.length) {
        state.lifecycle_state = LIFECYCLE_STATES.COMPLETED;
        state.updated_at = Date.now();
        atomicWriteJson(paths.stateJson, state);
        process.stdout.write(`Campaign "${state.campaign_id}" is already completed. Total attempts: ${state.total_attempts}, completed runs: ${state.completed_runs}.\n`);
        return { exitCode: EXIT_CODES.SUCCESS, totalAttempts: (state as any).total_attempts || 0, completedRuns: (state as any).completed_runs || 0 };
      }

      // 4. Execution of remaining work
      const resumeStartTime = Date.now();
      let totalAttempts = (state as any).total_attempts || 0;
      let completedRuns = (state as any).completed_runs || 0;

      const maxAttempts = campaign.budget.max_total_attempts;
      const maxWallTimeSec = campaign.budget.max_wall_time_seconds;
      const maxOutputBytes = campaign.budget.max_output_bytes;

      for (const item of schedule) {
        const runInfo = report.runs.get(item.run_id);
        if (runInfo && runInfo.isCompleted) {
          // Already completed logical run - skip execution
          continue;
        }

        const taskPath = path.join(paths.tasksDir, `${item.task_id}.json`);
        let taskDef: TaskDefinition;
        try {
          taskDef = readJson<TaskDefinition>(taskPath);
        } catch (err) {
          process.stderr.write(`Error reading task definition "${item.task_id}": ${(err as Error).message}\n`);
          return { exitCode: EXIT_CODES.UNRECOVERABLE_CORRUPTION, totalAttempts, completedRuns, error: (err as Error).message };
        }

        let attempt = runInfo && runInfo.nextAttempt ? runInfo.nextAttempt : 1;

        while (true) {
          // Check Global Attempt Budget before dispatching
          if (totalAttempts >= maxAttempts) {
            process.stderr.write(`Campaign stopped: Maximum total attempts budget (${maxAttempts}) reached.\n`);
            (state as any).total_attempts = totalAttempts;
            (state as any).completed_runs = completedRuns;
            state.updated_at = Date.now();
            atomicWriteJson(paths.stateJson, state);
            return { exitCode: EXIT_CODES.BUDGET_EXCEEDED, totalAttempts, completedRuns, error: 'Attempt budget reached' };
          }

          // Check Wall-Clock Budget (measured from start of this resume invocation)
          const elapsedSec = (Date.now() - resumeStartTime) / 1000;
          if (elapsedSec >= maxWallTimeSec) {
            process.stderr.write(`Campaign stopped: Maximum wall-time budget (${maxWallTimeSec}s) reached.\n`);
            (state as any).total_attempts = totalAttempts;
            (state as any).completed_runs = completedRuns;
            state.updated_at = Date.now();
            atomicWriteJson(paths.stateJson, state);
            return { exitCode: EXIT_CODES.BUDGET_EXCEEDED, totalAttempts, completedRuns, error: 'Wall-time budget reached' };
          }

          // Verify task provenance before EVERY resumed attempt (including retries)
          try {
            assertTaskProvenance(cwd);
          } catch (err) {
            if (err instanceof ProvenanceDriftError) {
              process.stderr.write(`Error: ${err.message}\n`);
              return { exitCode: EXIT_CODES.PROVENANCE_DRIFT, totalAttempts, completedRuns, error: err.message };
            }
            throw err;
          }

          // Dispatch attempt
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

          // Classify execution result
          const classification = classifyExecution(execResult);

          // Persist attempt manifest atomically
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

          // Persist updated total attempts in state.json
          (state as any).total_attempts = totalAttempts;
          state.updated_at = Date.now();
          atomicWriteJson(paths.stateJson, state);

          // Determine retry
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

      process.stdout.write(`Campaign "${state.campaign_id}" resumed and completed successfully. Total attempts: ${totalAttempts}, completed runs: ${completedRuns}.\n`);
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
    if (err instanceof UnrecoverableCorruptionError) {
      process.stderr.write(`Error: ${err.message}\n`);
      return { exitCode: EXIT_CODES.UNRECOVERABLE_CORRUPTION, totalAttempts: 0, completedRuns: 0, error: err.message };
    }
    process.stderr.write(`Fatal execution error: ${(err as Error).message}\n`);
    return { exitCode: EXIT_CODES.UNRECOVERABLE_CORRUPTION, totalAttempts: 0, completedRuns: 0, error: (err as Error).message };
  }
}
