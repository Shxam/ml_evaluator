import * as fs from 'fs';
import * as path from 'path';
import { EXIT_CODES, LIFECYCLE_STATES, ExitCode } from '../../core/constants';
import { CampaignState } from '../../core/types';
import { validateCampaignConfig } from '../../core/validation/campaign';
import { getCampaignPaths, createDirectoryLayout, isCampaignInitialized } from '../../core/storage/layout';
import { atomicWriteJson } from '../../core/storage/atomic';

export function handleInit(campaignJsonPath?: string, cwd: string = process.cwd()): ExitCode {
  if (!campaignJsonPath || campaignJsonPath.trim() === '') {
    process.stderr.write('Error: Missing campaign configuration file path.\nUsage: evalcampaign init <campaign_json_path>\n');
    return EXIT_CODES.USAGE_ERROR;
  }

  const resolvedPath = path.isAbsolute(campaignJsonPath)
    ? campaignJsonPath
    : path.resolve(cwd, campaignJsonPath);

  if (!fs.existsSync(resolvedPath)) {
    process.stderr.write(`Error: Configuration file not found at "${resolvedPath}".\n`);
    return EXIT_CODES.USAGE_ERROR;
  }

  if (isCampaignInitialized(cwd)) {
    process.stderr.write('Error: Campaign already initialized in this directory (.evalcampaign exists).\n');
    return EXIT_CODES.USAGE_ERROR;
  }

  let rawContent: string;
  try {
    rawContent = fs.readFileSync(resolvedPath, 'utf8');
  } catch (err) {
    process.stderr.write(`Error reading configuration file: ${(err as Error).message}\n`);
    return EXIT_CODES.USAGE_ERROR;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContent);
  } catch (err) {
    process.stderr.write(`Error: Malformed JSON in configuration file: ${(err as Error).message}\n`);
    return EXIT_CODES.VALIDATION_ERROR;
  }

  const validation = validateCampaignConfig(parsed);
  if (!validation.valid || !validation.config) {
    process.stderr.write(`Error: Invalid campaign configuration:\n${validation.errors.map(e => `  - ${e}`).join('\n')}\n`);
    return EXIT_CODES.VALIDATION_ERROR;
  }

  const config = validation.config;
  const now = Date.now();

  try {
    const paths = createDirectoryLayout(cwd);

    atomicWriteJson(paths.campaignJson, config);

    const initialState: CampaignState = {
      campaign_id: config.campaign_id,
      campaign_rev: 1,
      lifecycle_state: LIFECYCLE_STATES.CREATED,
      budget: config.budget,
      scoring: config.scoring,
      created_at: now,
      updated_at: now
    };

    atomicWriteJson(paths.stateJson, initialState);

    process.stdout.write(`Initialized campaign "${config.campaign_id}" in ${paths.root}\n`);
    return EXIT_CODES.SUCCESS;
  } catch (err) {
    process.stderr.write(`Fatal error during campaign initialization: ${(err as Error).message}\n`);
    return EXIT_CODES.UNRECOVERABLE_CORRUPTION;
  }
}
