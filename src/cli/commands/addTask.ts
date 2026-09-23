import * as fs from 'fs';
import * as path from 'path';
import { EXIT_CODES, ExitCode } from '../../core/constants';
import { CampaignState } from '../../core/types';
import { getCampaignPaths, isCampaignInitialized } from '../../core/storage/layout';
import { readJson, atomicWriteJson } from '../../core/storage/atomic';
import { canAddTask } from '../../core/lifecycle/guards';
import { validateTaskDefinition } from '../../core/validation/task';
import { withCampaignLock, LockContentionError } from '../../core/concurrency/lock';

export function handleAddTask(taskJsonPath?: string, cwd: string = process.cwd()): ExitCode {
  if (!taskJsonPath || taskJsonPath.trim() === '') {
    process.stderr.write('Error: Missing task configuration file path.\nUsage: evalcampaign add-task <task_json_path>\n');
    return EXIT_CODES.USAGE_ERROR;
  }

  const resolvedPath = path.isAbsolute(taskJsonPath)
    ? taskJsonPath
    : path.resolve(cwd, taskJsonPath);

  if (!fs.existsSync(resolvedPath)) {
    process.stderr.write(`Error: Task configuration file not found at "${resolvedPath}".\n`);
    return EXIT_CODES.USAGE_ERROR;
  }

  if (!isCampaignInitialized(cwd)) {
    process.stderr.write('Error: Campaign is not initialized in this directory. Run "evalcampaign init" first.\n');
    return EXIT_CODES.USAGE_ERROR;
  }

  try {
    return withCampaignLock(() => {
      const paths = getCampaignPaths(cwd);
      let state: CampaignState;
      try {
        state = readJson<CampaignState>(paths.stateJson);
      } catch (err) {
        process.stderr.write(`Error reading campaign state: ${(err as Error).message}\n`);
        return EXIT_CODES.UNRECOVERABLE_CORRUPTION;
      }

      if (!canAddTask(state.lifecycle_state)) {
        process.stderr.write(`Error: Cannot add task while campaign is in "${state.lifecycle_state}" state.\n`);
        return EXIT_CODES.INVALID_STATE;
      }

      let rawContent: string;
      try {
        rawContent = fs.readFileSync(resolvedPath, 'utf8');
      } catch (err) {
        process.stderr.write(`Error reading task configuration file: ${(err as Error).message}\n`);
        return EXIT_CODES.USAGE_ERROR;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawContent);
      } catch (err) {
        process.stderr.write(`Error: Malformed JSON in task configuration file: ${(err as Error).message}\n`);
        return EXIT_CODES.VALIDATION_ERROR;
      }

      const validation = validateTaskDefinition(parsed);
      if (!validation.valid || !validation.task) {
        process.stderr.write(`Error: Invalid task configuration:\n${validation.errors.map(e => `  - ${e}`).join('\n')}\n`);
        return EXIT_CODES.VALIDATION_ERROR;
      }

      const task = validation.task;
      const targetTaskPath = path.join(paths.tasksDir, `${task.task_id}.json`);

      if (fs.existsSync(targetTaskPath)) {
        process.stderr.write(`Error: Task with ID "${task.task_id}" is already registered in this campaign.\n`);
        return EXIT_CODES.VALIDATION_ERROR;
      }

      try {
        atomicWriteJson(targetTaskPath, task);
        process.stdout.write(`Registered task "${task.task_id}" in campaign "${state.campaign_id}"\n`);
        return EXIT_CODES.SUCCESS;
      } catch (err) {
        process.stderr.write(`Fatal error persisting task definition: ${(err as Error).message}\n`);
        return EXIT_CODES.UNRECOVERABLE_CORRUPTION;
      }
    }, cwd);
  } catch (err) {
    if (err instanceof LockContentionError) {
      process.stderr.write(`Error: ${err.message}\n`);
      return EXIT_CODES.LOCK_CONTENTION;
    }
    process.stderr.write(`Unexpected error: ${(err as Error).message}\n`);
    return EXIT_CODES.UNRECOVERABLE_CORRUPTION;
  }
}
