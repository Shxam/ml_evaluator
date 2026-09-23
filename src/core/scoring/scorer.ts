import * as fs from 'fs';
import * as path from 'path';
import { getCampaignPaths, isCampaignInitialized } from '../storage/layout';
import { readJson } from '../storage/atomic';
import { CampaignConfig, CampaignState, TaskDefinition, ModelDefinition } from '../types';
import { getCampaignSchedule, ScheduledRun } from '../scheduler/scheduler';
import { scanRunManifests, UnrecoverableCorruptionError } from '../execution/recovery';
import { EXECUTION_STATUSES } from '../execution/types';
import { toDeterministicJson } from '../storage/json';
import { EXIT_CODES, ExitCode } from '../constants';

export class IncompleteCampaignError extends Error {
  public readonly exitCode: ExitCode = EXIT_CODES.INVALID_STATE; // Exit code 4
  constructor(message: string = 'Campaign runs are incomplete or campaign is in a broken state.') {
    super(message);
    this.name = 'IncompleteCampaignError';
  }
}

export interface ScoredModelSummary {
  model_id: string;
  normalized_score: number;
  rank: number;
  score: number;
  task_scores: Record<string, number>;
  weighted_mean: number;
}

export interface ModelRanking {
  model_id: string;
  normalized_score: number;
  rank: number;
  score: number;
}

export interface ScoredRunSummary {
  attempt: number;
  model_id: string;
  raw_score: number;
  repetition: number;
  run_id: string;
  score: number;
  status: string;
  task_id: string;
}

export interface ScoringReport {
  aggregation: string;
  campaign_id: string;
  campaign_rev: number;
  missing_policy: string;
  models: Record<string, ScoredModelSummary>;
  rankings: ModelRanking[];
  runs: ScoredRunSummary[];
  task_weights: Record<string, number>;
  total_completed_runs: number;
  total_logical_runs: number;
}

function roundScore(value: number): number {
  return Math.round((value + Number.EPSILON) * 1e6) / 1e6;
}

/**
 * Computes deterministic score aggregation and model rankings across completed run manifests.
 * Fails closed with exit code 4 if required runs are incomplete or state is broken.
 */
export function computeCampaignScores(cwd: string = process.cwd()): ScoringReport {
  if (!isCampaignInitialized(cwd)) {
    throw new Error('Campaign is not initialized in this directory. Run "evalcampaign init" first.');
  }

  const paths = getCampaignPaths(cwd);
  let campaign: CampaignConfig;
  let state: CampaignState;

  try {
    campaign = readJson<CampaignConfig>(paths.campaignJson);
    state = readJson<CampaignState>(paths.stateJson);
  } catch (err) {
    throw new IncompleteCampaignError(`Cannot read campaign configuration or state: ${(err as Error).message}`);
  }

  if (campaign.scoring.aggregation !== 'weighted_mean') {
    throw new IncompleteCampaignError(`Unsupported scoring aggregation policy: "${campaign.scoring.aggregation}"`);
  }
  if (campaign.scoring.missing_policy !== 'zero') {
    throw new IncompleteCampaignError(`Unsupported scoring missing policy: "${campaign.scoring.missing_policy}"`);
  }

  // Read task definitions
  if (!fs.existsSync(paths.tasksDir)) {
    throw new IncompleteCampaignError('No tasks directory found in campaign.');
  }
  const taskFiles = fs.readdirSync(paths.tasksDir).filter(f => f.endsWith('.json')).sort();
  if (taskFiles.length === 0) {
    throw new IncompleteCampaignError('No tasks registered in campaign.');
  }

  const taskDefs = new Map<string, TaskDefinition>();
  const taskWeights: Record<string, number> = {};
  let totalWeight = 0;

  for (const file of taskFiles) {
    const fullPath = path.join(paths.tasksDir, file);
    let task: TaskDefinition;
    try {
      task = readJson<TaskDefinition>(fullPath);
    } catch (err) {
      throw new IncompleteCampaignError(`Corrupted task file "${file}": ${(err as Error).message}`);
    }
    if (!task || typeof task.weight !== 'number' || task.weight <= 0) {
      throw new IncompleteCampaignError(`Invalid weight for task "${task ? task.task_id : file}". Weight must be > 0.`);
    }
    taskDefs.set(task.task_id, task);
    taskWeights[task.task_id] = task.weight;
    totalWeight += task.weight;
  }

  // Read model definitions
  if (!fs.existsSync(paths.modelsDir)) {
    throw new IncompleteCampaignError('No models directory found in campaign.');
  }
  const modelFiles = fs.readdirSync(paths.modelsDir).filter(f => f.endsWith('.json')).sort();
  if (modelFiles.length === 0) {
    throw new IncompleteCampaignError('No models registered in campaign.');
  }

  const modelIds: string[] = [];
  for (const file of modelFiles) {
    const fullPath = path.join(paths.modelsDir, file);
    let model: ModelDefinition;
    try {
      model = readJson<ModelDefinition>(fullPath);
    } catch (err) {
      throw new IncompleteCampaignError(`Corrupted model file "${file}": ${(err as Error).message}`);
    }
    modelIds.push(model.model_id);
  }
  modelIds.sort();

  const repetitions = (campaign as any).repetitions || 1;
  let schedule: ScheduledRun[];
  try {
    schedule = getCampaignSchedule(cwd, repetitions);
  } catch (err) {
    throw new IncompleteCampaignError(`Cannot compute schedule: ${(err as Error).message}`);
  }

  if (schedule.length === 0) {
    throw new IncompleteCampaignError('Campaign schedule is empty.');
  }

  // Validate manifests integrity and completion status
  let report;
  try {
    const scan = scanRunManifests(cwd, schedule);
    report = scan.report;
  } catch (err) {
    throw new IncompleteCampaignError(`Manifest integrity violation: ${(err as Error).message}`);
  }

  // Incomplete campaign guard: ALL scheduled logical runs must have reached a terminal outcome
  if (report.completedLogicalRuns < schedule.length) {
    throw new IncompleteCampaignError(
      `Required runs are incomplete: ${report.completedLogicalRuns} of ${schedule.length} logical runs completed.`
    );
  }

  // Group run results by model and task
  // modelId -> taskId -> array of repetition scores
  const modelTaskScores = new Map<string, Map<string, number[]>>();
  for (const mId of modelIds) {
    const taskMap = new Map<string, number[]>();
    for (const tId of taskDefs.keys()) {
      taskMap.set(tId, []);
    }
    modelTaskScores.set(mId, taskMap);
  }

  const runsSummary: ScoredRunSummary[] = [];

  for (const scheduled of schedule) {
    const runInfo = report.runs.get(scheduled.run_id);
    if (!runInfo || runInfo.manifests.length === 0) {
      throw new IncompleteCampaignError(`Missing manifest for run "${scheduled.run_id}".`);
    }

    const latest = runInfo.manifests[runInfo.manifests.length - 1];

    // Manifest sanity checks
    if (
      latest.model_id !== scheduled.model_id ||
      latest.task_id !== scheduled.task_id ||
      latest.repetition !== scheduled.repetition
    ) {
      throw new IncompleteCampaignError(`Manifest identity mismatch for run "${scheduled.run_id}".`);
    }

    let runScore: number;
    let rawScoreValue: number;

    if (latest.status === EXECUTION_STATUSES.COMPLETED) {
      if (typeof latest.raw_score !== 'number' || isNaN(latest.raw_score)) {
        throw new IncompleteCampaignError(
          `Manifest for completed run "${scheduled.run_id}" contains invalid raw_score: ${latest.raw_score}`
        );
      }
      rawScoreValue = latest.raw_score;
      runScore = latest.raw_score;
    } else {
      // Terminal error (e.g. TIMEOUT, EVALUATOR_CRASH after retry exhaustion)
      // Under missing_policy: "zero", missing or failed results contribute 0.0
      rawScoreValue = 0.0;
      runScore = 0.0;
    }

    const taskMap = modelTaskScores.get(scheduled.model_id);
    if (taskMap) {
      const repList = taskMap.get(scheduled.task_id);
      if (repList) {
        repList.push(runScore);
      }
    }

    runsSummary.push({
      attempt: latest.attempt,
      model_id: scheduled.model_id,
      raw_score: rawScoreValue,
      repetition: scheduled.repetition,
      run_id: scheduled.run_id,
      score: runScore,
      status: latest.status,
      task_id: scheduled.task_id
    });
  }

  // Compute model-level task averages and weighted mean
  const modelSummaries: Record<string, ScoredModelSummary> = {};
  const modelScoresList: { model_id: string; score: number }[] = [];

  for (const mId of modelIds) {
    const taskMap = modelTaskScores.get(mId)!;
    const taskScoreMap: Record<string, number> = {};
    let weightedSum = 0;

    for (const [tId, tDef] of taskDefs.entries()) {
      const scores = taskMap.get(tId) || [];
      const meanScore = scores.length > 0
        ? scores.reduce((sum, val) => sum + val, 0) / scores.length
        : 0.0;
      
      const roundedTaskScore = roundScore(meanScore);
      taskScoreMap[tId] = roundedTaskScore;
      weightedSum += tDef.weight * roundedTaskScore;
    }

    const modelScore = roundScore(weightedSum / totalWeight);

    modelSummaries[mId] = {
      model_id: mId,
      normalized_score: modelScore,
      rank: 0, // Assigned after sorting
      score: modelScore,
      task_scores: taskScoreMap,
      weighted_mean: modelScore
    };

    modelScoresList.push({ model_id: mId, score: modelScore });
  }

  // Sort models for deterministic rankings:
  // 1. Score descending
  // 2. Tie-breaker: model_id ascending
  modelScoresList.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }
    return a.model_id.localeCompare(b.model_id);
  });

  const rankings: ModelRanking[] = [];
  for (let i = 0; i < modelScoresList.length; i++) {
    const item = modelScoresList[i];
    const rank = i + 1;
    modelSummaries[item.model_id].rank = rank;

    rankings.push({
      model_id: item.model_id,
      normalized_score: item.score,
      rank,
      score: item.score
    });
  }

  return {
    aggregation: campaign.scoring.aggregation,
    campaign_id: campaign.campaign_id,
    campaign_rev: state.campaign_rev,
    missing_policy: campaign.scoring.missing_policy,
    models: modelSummaries,
    rankings,
    runs: runsSummary,
    task_weights: taskWeights,
    total_completed_runs: report.completedLogicalRuns,
    total_logical_runs: schedule.length
  };
}

/**
 * Emits canonical deterministic JSON string for scoring report.
 */
export function formatDeterministicScores(report: ScoringReport): string {
  return toDeterministicJson(report);
}
