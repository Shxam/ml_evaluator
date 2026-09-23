import * as fs from 'fs';
import * as path from 'path';
import { getCampaignPaths, isCampaignInitialized } from '../storage/layout';
import { readJson } from '../storage/atomic';
import { CampaignConfig, CampaignState, TaskDefinition, ModelDefinition } from '../types';
import { getCampaignSchedule, ScheduledRun } from '../scheduler/scheduler';
import { scanRunManifests, UnrecoverableCorruptionError } from '../execution/recovery';
import { assertTaskProvenance, TaskProvenanceMap } from '../provenance/provenance';
import { computeCampaignScores } from '../scoring/scorer';
import { toDeterministicJson } from '../storage/json';
import { EXIT_CODES, ExitCode } from '../constants';

export class ExportError extends Error {
  public readonly exitCode: ExitCode;
  constructor(message: string, exitCode: ExitCode = EXIT_CODES.USAGE_ERROR) {
    super(message);
    this.name = 'ExportError';
    this.exitCode = exitCode;
  }
}

export interface ExportAttemptSummary {
  attempt: number;
  completed_at: number;
  execution_time_ms: number;
  exit_code: number | null;
  normalized_score: number;
  raw_score: number | null;
  status: string;
  stderr_hash: string;
  stdout_hash: string;
}

export interface ExportRunSummary {
  attempts: ExportAttemptSummary[];
  highest_attempt: number;
  is_completed: boolean;
  model_id: string;
  repetition: number;
  run_id: string;
  status: string;
  task_id: string;
}

export interface ExportReport {
  campaign: {
    budget: {
      max_output_bytes: number;
      max_total_attempts: number;
      max_wall_time_seconds: number;
    };
    campaign_id: string;
    name: string;
    repetitions: number;
    scoring: {
      aggregation: string;
      missing_policy: string;
    };
  };
  campaign_id: string;
  campaign_rev: number;
  lifecycle_state: string;
  models: {
    model_id: string;
    name?: string;
  }[];
  provenance: Record<string, string>;
  rankings: {
    model_id: string;
    normalized_score: number;
    rank: number;
    score: number;
  }[];
  runs: ExportRunSummary[];
  scoring?: {
    aggregation: string;
    missing_policy: string;
    models: Record<string, any>;
    task_weights: Record<string, number>;
  };
  status: {
    completed_logical_runs: number;
    cumulative_attempt_count: number;
    remaining_logical_runs: number;
    total_logical_runs: number;
  };
  tasks: {
    command: string;
    retry_policy: {
      max_attempts: number;
      retry_on: string[];
    };
    task_id: string;
    timeout_seconds: number;
    weight: number;
  }[];
}

/**
 * Reconstructs an authoritative, deterministic evaluation report for the campaign.
 * Emits canonical JSON with sorted keys, deterministic ordering, and no host paths/PIDs.
 */
export function generateCampaignExport(cwd: string = process.cwd()): ExportReport {
  if (!isCampaignInitialized(cwd)) {
    throw new ExportError('Campaign is not initialized in this directory. Run "evalcampaign init" first.', EXIT_CODES.USAGE_ERROR);
  }

  const paths = getCampaignPaths(cwd);

  // 1. Audit provenance baselines if present (fail-closed on drift: Exit 5)
  const provFile = path.join(paths.root, 'provenance.json');
  let baselineHashes: Record<string, string> = {};
  if (fs.existsSync(provFile)) {
    assertTaskProvenance(cwd);
    try {
      const provData = readJson<any>(provFile);
      if (provData && typeof provData === 'object') {
        if ('tasks' in provData && provData.tasks && typeof provData.tasks === 'object') {
          baselineHashes = provData.tasks;
        } else {
          baselineHashes = provData;
        }
      }
    } catch {
      // ignore
    }
  }

  // 2. Read campaign configuration and state
  let campaign: CampaignConfig;
  let state: CampaignState;
  try {
    campaign = readJson<CampaignConfig>(paths.campaignJson);
    state = readJson<CampaignState>(paths.stateJson);
  } catch (err) {
    throw new ExportError(`Cannot read campaign configuration or state: ${(err as Error).message}`, EXIT_CODES.UNRECOVERABLE_CORRUPTION);
  }

  // 3. Read registered models (sorted by model_id)
  const modelsList: { model_id: string; name?: string }[] = [];
  if (fs.existsSync(paths.modelsDir)) {
    const modelFiles = fs.readdirSync(paths.modelsDir).filter(f => f.endsWith('.json')).sort();
    for (const f of modelFiles) {
      try {
        const m = readJson<ModelDefinition>(path.join(paths.modelsDir, f));
        modelsList.push({
          model_id: m.model_id,
          name: m.name
        });
      } catch (err) {
        throw new ExportError(`Corrupted model file "${f}": ${(err as Error).message}`, EXIT_CODES.UNRECOVERABLE_CORRUPTION);
      }
    }
  }
  modelsList.sort((a, b) => a.model_id.localeCompare(b.model_id));

  // 4. Read registered tasks (sorted by task_id)
  const tasksList: {
    command: string;
    retry_policy: { max_attempts: number; retry_on: string[] };
    task_id: string;
    timeout_seconds: number;
    weight: number;
  }[] = [];
  if (fs.existsSync(paths.tasksDir)) {
    const taskFiles = fs.readdirSync(paths.tasksDir).filter(f => f.endsWith('.json')).sort();
    for (const f of taskFiles) {
      try {
        const t = readJson<TaskDefinition>(path.join(paths.tasksDir, f));
        tasksList.push({
          command: t.command,
          retry_policy: {
            max_attempts: t.retry_policy.max_attempts,
            retry_on: [...t.retry_policy.retry_on].sort()
          },
          task_id: t.task_id,
          timeout_seconds: t.timeout_seconds,
          weight: t.weight
        });
      } catch (err) {
        throw new ExportError(`Corrupted task file "${f}": ${(err as Error).message}`, EXIT_CODES.UNRECOVERABLE_CORRUPTION);
      }
    }
  }
  tasksList.sort((a, b) => a.task_id.localeCompare(b.task_id));

  // 5. Build schedule and collect runs
  const repetitions = (campaign as any).repetitions || 1;
  let schedule: ScheduledRun[] = [];
  try {
    if (modelsList.length > 0 && tasksList.length > 0) {
      schedule = getCampaignSchedule(cwd, repetitions);
    }
  } catch (err) {
    throw new ExportError(`Failed to construct schedule: ${(err as Error).message}`, EXIT_CODES.UNRECOVERABLE_CORRUPTION);
  }

  // 6. Scan run manifests
  const { report } = scanRunManifests(cwd, schedule);
  const runsSummary: ExportRunSummary[] = [];

  for (const item of schedule) {
    const runInfo = report.runs.get(item.run_id);
    const manifests = runInfo ? [...runInfo.manifests].sort((a, b) => a.attempt - b.attempt) : [];
    const latest = manifests.length > 0 ? manifests[manifests.length - 1] : null;

    const attemptsList: ExportAttemptSummary[] = manifests.map(m => ({
      attempt: m.attempt,
      completed_at: m.completed_at || 0,
      execution_time_ms: m.execution_time_ms || 0,
      exit_code: m.exit_code,
      normalized_score: typeof m.normalized_score === 'number' ? m.normalized_score : 0.0,
      raw_score: m.raw_score,
      status: m.status,
      stderr_hash: m.stderr_hash || '',
      stdout_hash: m.stdout_hash || ''
    }));

    runsSummary.push({
      attempts: attemptsList,
      highest_attempt: runInfo ? runInfo.highestAttempt : 0,
      is_completed: runInfo ? runInfo.isCompleted : false,
      model_id: item.model_id,
      repetition: item.repetition,
      run_id: item.run_id,
      status: latest ? latest.status : 'UNATTEMPTED',
      task_id: item.task_id
    });
  }

  // 7. Compute scoring & rankings if all runs are complete
  let rankings: { model_id: string; normalized_score: number; rank: number; score: number }[] = [];
  let scoringSection: any = undefined;

  if (schedule.length > 0 && report.completedLogicalRuns === schedule.length) {
    try {
      const scoringReport = computeCampaignScores(cwd);
      rankings = scoringReport.rankings;
      scoringSection = {
        aggregation: scoringReport.aggregation,
        missing_policy: scoringReport.missing_policy,
        models: scoringReport.models,
        task_weights: scoringReport.task_weights
      };
    } catch {
      // If scoring fails, rankings remain empty
    }
  }

  const cumulativeAttempts = Math.max((state as any).total_attempts || 0, report.totalDispatchedAttempts);

  return {
    campaign: {
      budget: {
        max_output_bytes: campaign.budget.max_output_bytes,
        max_total_attempts: campaign.budget.max_total_attempts,
        max_wall_time_seconds: campaign.budget.max_wall_time_seconds
      },
      campaign_id: campaign.campaign_id,
      name: campaign.name,
      repetitions,
      scoring: {
        aggregation: campaign.scoring.aggregation,
        missing_policy: campaign.scoring.missing_policy
      }
    },
    campaign_id: campaign.campaign_id,
    campaign_rev: state.campaign_rev,
    lifecycle_state: state.lifecycle_state,
    models: modelsList,
    provenance: baselineHashes,
    rankings,
    runs: runsSummary,
    scoring: scoringSection,
    status: {
      completed_logical_runs: report.completedLogicalRuns,
      cumulative_attempt_count: cumulativeAttempts,
      remaining_logical_runs: Math.max(0, schedule.length - report.completedLogicalRuns),
      total_logical_runs: schedule.length
    },
    tasks: tasksList
  };
}

/**
 * Emits canonical deterministic JSON string for campaign export.
 */
export function formatDeterministicExport(report: ExportReport): string {
  return toDeterministicJson(report);
}
