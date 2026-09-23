import * as fs from 'fs';
import * as path from 'path';
import { EXIT_CODES, ExitCode } from '../../core/constants';
import { CampaignState } from '../../core/types';
import { getCampaignPaths, isCampaignInitialized } from '../../core/storage/layout';
import { readJson, atomicWriteJson } from '../../core/storage/atomic';
import { canAddModel } from '../../core/lifecycle/guards';
import { validateModelDefinition } from '../../core/validation/model';
import { withCampaignLock, LockContentionError } from '../../core/concurrency/lock';

export function handleAddModel(modelJsonPath?: string, cwd: string = process.cwd()): ExitCode {
  if (!modelJsonPath || modelJsonPath.trim() === '') {
    process.stderr.write('Error: Missing model configuration file path.\nUsage: evalcampaign add-model <model_json_path>\n');
    return EXIT_CODES.USAGE_ERROR;
  }

  const resolvedPath = path.isAbsolute(modelJsonPath)
    ? modelJsonPath
    : path.resolve(cwd, modelJsonPath);

  if (!fs.existsSync(resolvedPath)) {
    process.stderr.write(`Error: Model configuration file not found at "${resolvedPath}".\n`);
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

      if (!canAddModel(state.lifecycle_state)) {
        process.stderr.write(`Error: Cannot add model while campaign is in "${state.lifecycle_state}" state.\n`);
        return EXIT_CODES.INVALID_STATE;
      }

      let rawContent: string;
      try {
        rawContent = fs.readFileSync(resolvedPath, 'utf8');
      } catch (err) {
        process.stderr.write(`Error reading model configuration file: ${(err as Error).message}\n`);
        return EXIT_CODES.USAGE_ERROR;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawContent);
      } catch (err) {
        process.stderr.write(`Error: Malformed JSON in model configuration file: ${(err as Error).message}\n`);
        return EXIT_CODES.VALIDATION_ERROR;
      }

      const validation = validateModelDefinition(parsed);
      if (!validation.valid || !validation.model) {
        process.stderr.write(`Error: Invalid model configuration:\n${validation.errors.map(e => `  - ${e}`).join('\n')}\n`);
        return EXIT_CODES.VALIDATION_ERROR;
      }

      const model = validation.model;
      const targetModelPath = path.join(paths.modelsDir, `${model.model_id}.json`);

      if (fs.existsSync(targetModelPath)) {
        process.stderr.write(`Error: Model with ID "${model.model_id}" is already registered in this campaign.\n`);
        return EXIT_CODES.VALIDATION_ERROR;
      }

      try {
        atomicWriteJson(targetModelPath, model);
        process.stdout.write(`Registered model "${model.model_id}" in campaign "${state.campaign_id}"\n`);
        return EXIT_CODES.SUCCESS;
      } catch (err) {
        process.stderr.write(`Fatal error persisting model definition: ${(err as Error).message}\n`);
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
