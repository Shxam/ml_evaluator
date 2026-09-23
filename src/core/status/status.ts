import * as fs from 'fs';
import * as path from 'path';
import { getCampaignPaths, isCampaignInitialized } from '../storage/layout';
import { readJson } from '../storage/atomic';
import { CampaignConfig, CampaignState } from '../types';
import { LifecycleState } from '../constants';
import { getCampaignSchedule, ScheduledRun } from '../scheduler/scheduler';
import { scanRunManifests, UnrecoverableCorruptionError } from '../execution/recovery';
import { toDeterministicJson } from '../storage/json';

export interface BudgetConsumption {
  attempts_consumed: number;
  max_output_bytes: number;
  max_total_attempts: number;
  max_wall_time_seconds: number;
}

export interface CampaignStatus {
  active_revision: number;
  budget: BudgetConsumption;
  budget_consumption: BudgetConsumption;
  campaign_id: string;
  campaign_rev: number;
  completed_logical_runs: number;
  completed_runs: number;
  cumulative_attempt_count: number;
  cumulative_attempts: number;
  lifecycle_state: LifecycleState;
  remaining_logical_runs: number;
  remaining_runs: number;
  total_attempts: number;
  total_logical_runs: number;
}

/**
 * Computes authoritative logical status of the campaign.
 * Derived directly from configuration, state.json, and run manifests.
 */
export function getCampaignStatus(cwd: string = process.cwd()): CampaignStatus {
  if (!isCampaignInitialized(cwd)) {
    throw new Error('Campaign is not initialized in this directory. Run "evalcampaign init" first.');
  }

  const paths = getCampaignPaths(cwd);
  let campaign: CampaignConfig;
  let state: CampaignState;

  try {
    campaign = readJson<CampaignConfig>(paths.campaignJson);
  } catch (err) {
    throw new UnrecoverableCorruptionError(`Cannot read campaign.json: ${(err as Error).message}`);
  }

  try {
    state = readJson<CampaignState>(paths.stateJson);
  } catch (err) {
    throw new UnrecoverableCorruptionError(`Cannot read state.json: ${(err as Error).message}`);
  }

  let taskFiles: string[] = [];
  let modelFiles: string[] = [];
  if (fs.existsSync(paths.tasksDir)) {
    taskFiles = fs.readdirSync(paths.tasksDir).filter(f => f.endsWith('.json'));
  }
  if (fs.existsSync(paths.modelsDir)) {
    modelFiles = fs.readdirSync(paths.modelsDir).filter(f => f.endsWith('.json'));
  }

  let schedule: ScheduledRun[] = [];
  if (taskFiles.length > 0 && modelFiles.length > 0) {
    try {
      const reps = (campaign as any).repetitions || 1;
      schedule = getCampaignSchedule(cwd, reps);
    } catch {
      // If schedule cannot be constructed yet, treat as empty
      schedule = [];
    }
  }

  let completedLogicalRuns = 0;
  let totalDispatchedAttempts = 0;

  if (schedule.length > 0) {
    const { report } = scanRunManifests(cwd, schedule);
    completedLogicalRuns = report.completedLogicalRuns;
    totalDispatchedAttempts = report.totalDispatchedAttempts;
  }

  const totalLogicalRuns = schedule.length;
  const remainingLogicalRuns = Math.max(0, totalLogicalRuns - completedLogicalRuns);
  const cumulativeAttempts = Math.max((state as any).total_attempts || 0, totalDispatchedAttempts);

  const budgetConsumption: BudgetConsumption = {
    attempts_consumed: cumulativeAttempts,
    max_output_bytes: campaign.budget.max_output_bytes,
    max_total_attempts: campaign.budget.max_total_attempts,
    max_wall_time_seconds: campaign.budget.max_wall_time_seconds
  };

  return {
    active_revision: state.campaign_rev,
    budget: budgetConsumption,
    budget_consumption: budgetConsumption,
    campaign_id: campaign.campaign_id,
    campaign_rev: state.campaign_rev,
    completed_logical_runs: completedLogicalRuns,
    completed_runs: completedLogicalRuns,
    cumulative_attempt_count: cumulativeAttempts,
    cumulative_attempts: cumulativeAttempts,
    lifecycle_state: state.lifecycle_state,
    remaining_logical_runs: remainingLogicalRuns,
    remaining_runs: remainingLogicalRuns,
    total_attempts: cumulativeAttempts,
    total_logical_runs: totalLogicalRuns
  };
}

/**
 * Emits stable, deterministic plaintext status report.
 */
export function formatPlaintextStatus(status: CampaignStatus): string {
  return [
    `Campaign ID:            ${status.campaign_id}`,
    `Lifecycle State:        ${status.lifecycle_state}`,
    `Active Revision:        ${status.active_revision}`,
    `Completed Logical Runs: ${status.completed_logical_runs} / ${status.total_logical_runs}`,
    `Remaining Logical Runs: ${status.remaining_logical_runs}`,
    `Total Logical Runs:     ${status.total_logical_runs}`,
    `Cumulative Attempts:    ${status.cumulative_attempt_count}`,
    `Budget Consumption:     ${status.budget_consumption.attempts_consumed} / ${status.budget_consumption.max_total_attempts} attempts, max wall time ${status.budget_consumption.max_wall_time_seconds}s`
  ].join('\n') + '\n';
}

/**
 * Emits canonical, deterministic JSON status report with sorted keys and no wall-clock drift.
 */
export function formatJsonStatus(status: CampaignStatus): string {
  return toDeterministicJson(status);
}
