import * as fs from 'fs';
import * as path from 'path';
import { getCampaignPaths, isCampaignInitialized } from '../storage/layout';
import { readJson, atomicWriteJson } from '../storage/atomic';
import { CampaignConfig, CampaignState } from '../types';
import { getCampaignSchedule, ScheduledRun } from '../scheduler/scheduler';
import { scanRunManifests, reconcileCampaignState, cleanupStaleTempFiles } from '../execution/recovery';
import { EXIT_CODES, ExitCode, LIFECYCLE_STATES } from '../constants';

export class RollbackError extends Error {
  public readonly exitCode: ExitCode;
  constructor(message: string, exitCode: ExitCode = EXIT_CODES.INVALID_STATE) {
    super(message);
    this.name = 'RollbackError';
    this.exitCode = exitCode;
  }
}

export interface RollbackResult {
  revertedBatches: number;
  remainingCompletedRuns: number;
  totalLogicalRuns: number;
  revertedRunIds: string[];
}

/**
 * Reverts the campaign state by n completed attempt batches.
 * Restores previous run counters and state, and cleans result manifests of reverted runs.
 */
export function rollbackCampaign(n: number = 1, cwd: string = process.cwd()): RollbackResult {
  if (!isCampaignInitialized(cwd)) {
    throw new RollbackError('Campaign is not initialized in this directory. Run "evalcampaign init" first.', EXIT_CODES.USAGE_ERROR);
  }

  if (typeof n !== 'number' || isNaN(n) || !Number.isInteger(n) || n < 1) {
    throw new RollbackError(`Invalid rollback count "${n}". Must be a positive integer >= 1.`, EXIT_CODES.USAGE_ERROR);
  }

  const paths = getCampaignPaths(cwd);
  let campaign: CampaignConfig;
  let state: CampaignState;

  try {
    campaign = readJson<CampaignConfig>(paths.campaignJson);
    state = readJson<CampaignState>(paths.stateJson);
  } catch (err) {
    throw new RollbackError(`Cannot read campaign state: ${(err as Error).message}`, EXIT_CODES.INVALID_STATE);
  }

  const repetitions = (campaign as any).repetitions || 1;
  let schedule: ScheduledRun[] = [];
  try {
    schedule = getCampaignSchedule(cwd, repetitions);
  } catch {
    schedule = [];
  }

  if (schedule.length === 0) {
    throw new RollbackError('Cannot rollback campaign with no scheduled tasks or models.', EXIT_CODES.INVALID_STATE);
  }

  // Scan manifests to find completed logical runs
  const { report } = scanRunManifests(cwd, schedule);
  const completedRunsInfo: {
    runId: string;
    completedAt: number;
    scheduleIndex: number;
    manifestFiles: string[];
  }[] = [];

  for (let i = 0; i < schedule.length; i++) {
    const s = schedule[i];
    const info = report.runs.get(s.run_id);
    if (info && info.isCompleted && info.manifests.length > 0) {
      const latest = info.manifests[info.manifests.length - 1];
      const manifestFiles = info.manifests.map(m => `${s.run_id}_att${m.attempt}.json`);
      completedRunsInfo.push({
        runId: s.run_id,
        completedAt: latest.completed_at || 0,
        scheduleIndex: i,
        manifestFiles
      });
    }
  }

  if (completedRunsInfo.length === 0) {
    throw new RollbackError('Cannot rollback past initial configured revision: no completed run batches exist to undo.', EXIT_CODES.INVALID_STATE);
  }

  if (n > completedRunsInfo.length) {
    throw new RollbackError(
      `Cannot rollback ${n} batches: only ${completedRunsInfo.length} completed run batches exist. Cannot rollback past initial configured revision.`,
      EXIT_CODES.INVALID_STATE
    );
  }

  // Sort completed runs to determine rollback order:
  // Most recent completion time first. Ties broken by scheduleIndex descending.
  completedRunsInfo.sort((a, b) => {
    if (b.completedAt !== a.completedAt) {
      return b.completedAt - a.completedAt;
    }
    return b.scheduleIndex - a.scheduleIndex;
  });

  const batchesToRevert = completedRunsInfo.slice(0, n);
  const revertedRunIds: string[] = [];

  // Remove manifest files of the reverted runs
  for (const item of batchesToRevert) {
    revertedRunIds.push(item.runId);
    for (const mf of item.manifestFiles) {
      const fullPath = path.join(paths.runsDir, mf);
      if (fs.existsSync(fullPath)) {
        try {
          fs.unlinkSync(fullPath);
        } catch {
          // ignore
        }
      }
    }
  }

  cleanupStaleTempFiles(cwd);

  // Reconcile surviving state
  const { state: reconciledState, report: postReport } = reconcileCampaignState(cwd, schedule);

  // If campaign was completed, transition back to running (or configured if 0 completed)
  if (postReport.completedLogicalRuns < schedule.length) {
    if (reconciledState.lifecycle_state === LIFECYCLE_STATES.COMPLETED) {
      reconciledState.lifecycle_state = postReport.completedLogicalRuns === 0
        ? LIFECYCLE_STATES.CONFIGURED
        : LIFECYCLE_STATES.RUNNING;
    }
    reconciledState.updated_at = Date.now();
    atomicWriteJson(paths.stateJson, reconciledState);
  }

  return {
    revertedBatches: n,
    remainingCompletedRuns: postReport.completedLogicalRuns,
    totalLogicalRuns: schedule.length,
    revertedRunIds
  };
}
