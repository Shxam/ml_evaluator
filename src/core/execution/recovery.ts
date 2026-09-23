import * as fs from 'fs';
import * as path from 'path';
import { getCampaignPaths, isCampaignInitialized } from '../storage/layout';
import { readJson, atomicWriteJson } from '../storage/atomic';
import { CampaignState, TaskDefinition } from '../types';
import { ScheduledRun } from '../scheduler/scheduler';
import { shouldRetry } from './retry';
import { AttemptManifest, EXECUTION_STATUSES } from './types';
import { EXIT_CODES, ExitCode } from '../constants';

export class UnrecoverableCorruptionError extends Error {
  public readonly exitCode: ExitCode = EXIT_CODES.UNRECOVERABLE_CORRUPTION;
  constructor(message: string) {
    super(message);
    this.name = 'UnrecoverableCorruptionError';
  }
}

export interface LogicalRunRecoveryInfo {
  runId: string;
  taskId: string;
  modelId: string;
  repetition: number;
  manifests: AttemptManifest[];
  highestAttempt: number;
  isCompleted: boolean;
  nextAttempt: number | null; // null if completed
}

export interface RecoveryReport {
  totalDispatchedAttempts: number;
  completedLogicalRuns: number;
  runs: Map<string, LogicalRunRecoveryInfo>;
  staleTempFilesCleaned: string[];
}

/**
 * Scans directory recursively and safely removes any lingering .tmp files left by interrupted atomic writes.
 */
export function cleanupStaleTempFiles(cwd: string = process.cwd()): string[] {
  if (!isCampaignInitialized(cwd)) {
    return [];
  }

  const paths = getCampaignPaths(cwd);
  const targetDirs = [paths.root, paths.runsDir, paths.tasksDir, paths.modelsDir, paths.registersDir, paths.locksDir];
  const cleaned: string[] = [];

  for (const dir of targetDirs) {
    if (!fs.existsSync(dir)) continue;

    try {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        if (entry.endsWith('.tmp') || entry.includes('.tmp.')) {
          const fullPath = path.join(dir, entry);
          try {
            fs.unlinkSync(fullPath);
            cleaned.push(fullPath);
          } catch {
            // ignore unlink errors
          }
        }
      }
    } catch {
      // ignore readdir errors
    }
  }

  return cleaned;
}

/**
 * Scans .evalcampaign/runs/ manifests, groups by run_id, validates attempt sequence integrity,
 * and determines remaining work for each scheduled logical run.
 */
export function scanRunManifests(
  cwd: string = process.cwd(),
  schedule: ScheduledRun[]
): { report: RecoveryReport } {
  const paths = getCampaignPaths(cwd);
  const cleaned = cleanupStaleTempFiles(cwd);

  if (!fs.existsSync(paths.runsDir)) {
    fs.mkdirSync(paths.runsDir, { recursive: true });
  }

  const runFiles = fs.readdirSync(paths.runsDir).filter(f => f.endsWith('.json'));
  const manifestsByRunId = new Map<string, AttemptManifest[]>();
  const seenFilenames = new Set<string>();

  for (const file of runFiles) {
    if (seenFilenames.has(file)) {
      throw new UnrecoverableCorruptionError(`Duplicate manifest file detected on disk: ${file}`);
    }
    seenFilenames.add(file);

    const fullPath = path.join(paths.runsDir, file);
    let manifest: AttemptManifest;
    try {
      manifest = readJson<AttemptManifest>(fullPath);
    } catch (err) {
      throw new UnrecoverableCorruptionError(`Corrupt or unparseable attempt manifest: "${file}": ${(err as Error).message}`);
    }

    if (!manifest || typeof manifest !== 'object' || !manifest.run_id || typeof manifest.attempt !== 'number') {
      throw new UnrecoverableCorruptionError(`Attempt manifest "${file}" has invalid schema or missing run_id/attempt.`);
    }

    const list = manifestsByRunId.get(manifest.run_id) || [];
    list.push(manifest);
    manifestsByRunId.set(manifest.run_id, list);
  }

  let totalDispatchedAttempts = 0;
  let completedLogicalRuns = 0;
  const runsInfo = new Map<string, LogicalRunRecoveryInfo>();

  for (const scheduled of schedule) {
    const taskPath = path.join(paths.tasksDir, `${scheduled.task_id}.json`);
    let taskDef: TaskDefinition | undefined;
    if (fs.existsSync(taskPath)) {
      try {
        taskDef = readJson<TaskDefinition>(taskPath);
      } catch {
        // task def error handled by caller
      }
    }

    const manifests = manifestsByRunId.get(scheduled.run_id) || [];
    // Sort manifests by attempt number ascending
    manifests.sort((a, b) => a.attempt - b.attempt);

    // Consistency check: attempts must be strictly consecutive 1..N with no duplicates or skipped numbers
    for (let i = 0; i < manifests.length; i++) {
      const expectedAttempt = i + 1;
      if (manifests[i].attempt !== expectedAttempt) {
        throw new UnrecoverableCorruptionError(
          `Manifest consistency violation for run "${scheduled.run_id}": expected attempt ${expectedAttempt} but found ${manifests[i].attempt}.`
        );
      }
    }

    totalDispatchedAttempts += manifests.length;

    let isCompleted = false;
    let nextAttempt: number | null = null;
    const highestAttempt = manifests.length > 0 ? manifests[manifests.length - 1].attempt : 0;

    if (manifests.length === 0) {
      // Never executed or interrupted prior to any manifest persistence
      isCompleted = false;
      nextAttempt = 1;
    } else {
      const latest = manifests[manifests.length - 1];
      if (latest.status === EXECUTION_STATUSES.COMPLETED) {
        isCompleted = true;
        nextAttempt = null;
      } else {
        // Check if retryable based on task policy
        const retryable = taskDef ? shouldRetry(latest.status, latest.attempt, taskDef.retry_policy) : false;
        if (retryable) {
          isCompleted = false;
          nextAttempt = latest.attempt + 1;
        } else {
          // Terminal failure (e.g. non-retryable status or reached max_attempts)
          isCompleted = true;
          nextAttempt = null;
        }
      }
    }

    if (isCompleted) {
      completedLogicalRuns++;
    }

    runsInfo.set(scheduled.run_id, {
      runId: scheduled.run_id,
      taskId: scheduled.task_id,
      modelId: scheduled.model_id,
      repetition: scheduled.repetition,
      manifests,
      highestAttempt,
      isCompleted,
      nextAttempt
    });
  }

  return {
    report: {
      totalDispatchedAttempts,
      completedLogicalRuns,
      runs: runsInfo,
      staleTempFilesCleaned: cleaned
    }
  };
}

/**
 * Reconciles campaign state on disk with surviving manifests.
 * Repairs derived counters and persists state atomically.
 */
export function reconcileCampaignState(
  cwd: string = process.cwd(),
  schedule: ScheduledRun[]
): { state: CampaignState; report: RecoveryReport } {
  const paths = getCampaignPaths(cwd);
  let state: CampaignState;

  try {
    state = readJson<CampaignState>(paths.stateJson);
  } catch (err) {
    throw new UnrecoverableCorruptionError(`Cannot read campaign state.json: ${(err as Error).message}`);
  }

  const { report } = scanRunManifests(cwd, schedule);

  // Reconcile counters: state.total_attempts must reflect actual dispatched attempts
  (state as any).total_attempts = Math.max((state as any).total_attempts || 0, report.totalDispatchedAttempts);
  (state as any).completed_runs = report.completedLogicalRuns;
  state.updated_at = Date.now();

  atomicWriteJson(paths.stateJson, state);

  return { state, report };
}
