import * as fs from 'fs';
import * as path from 'path';
import { computeRunId } from '../identity/runId';
import { getCampaignPaths, isCampaignInitialized } from '../storage/layout';
import { readJson } from '../storage/atomic';
import { CampaignState, TaskDefinition, ModelDefinition } from '../types';

export interface ScheduledRun {
  run_id: string;
  campaign_id: string;
  campaign_rev: number;
  model_id: string;
  task_id: string;
  repetition: number;
}

/**
 * Builds deterministic Cartesian schedule:
 * sorted(model_id) x sorted(task_id) x repetition 1..R
 */
export function buildSchedule(
  campaignId: string,
  campaignRev: number,
  modelIds: string[],
  taskIds: string[],
  repetitions: number = 1
): ScheduledRun[] {
  const sortedModels = [...modelIds].sort();
  const sortedTasks = [...taskIds].sort();
  const schedule: ScheduledRun[] = [];

  for (const modelId of sortedModels) {
    for (const taskId of sortedTasks) {
      for (let rep = 1; rep <= repetitions; rep++) {
        const runId = computeRunId({
          campaign_id: campaignId,
          campaign_rev: campaignRev,
          model_id: modelId,
          task_id: taskId,
          repetition: rep
        });

        schedule.push({
          run_id: runId,
          campaign_id: campaignId,
          campaign_rev: campaignRev,
          model_id: modelId,
          task_id: taskId,
          repetition: rep
        });
      }
    }
  }

  return schedule;
}

/**
 * Loads registered tasks and models from .evalcampaign/ and generates deterministic schedule.
 */
export function getCampaignSchedule(cwd: string = process.cwd(), repetitions: number = 1): ScheduledRun[] {
  if (!isCampaignInitialized(cwd)) {
    throw new Error('Campaign is not initialized in current directory.');
  }

  const paths = getCampaignPaths(cwd);
  const state = readJson<CampaignState>(paths.stateJson);

  const modelFiles = fs.readdirSync(paths.modelsDir).filter(f => f.endsWith('.json'));
  const taskFiles = fs.readdirSync(paths.tasksDir).filter(f => f.endsWith('.json'));

  const modelIds: string[] = [];
  for (const file of modelFiles) {
    const model = readJson<ModelDefinition>(path.join(paths.modelsDir, file));
    if (model && model.model_id) {
      modelIds.push(model.model_id);
    }
  }

  const taskIds: string[] = [];
  for (const file of taskFiles) {
    const task = readJson<TaskDefinition>(path.join(paths.tasksDir, file));
    if (task && task.task_id) {
      taskIds.push(task.task_id);
    }
  }

  return buildSchedule(state.campaign_id, state.campaign_rev, modelIds, taskIds, repetitions);
}
