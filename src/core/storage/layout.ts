import * as fs from 'fs';
import * as path from 'path';
import { DIRECTORY_NAMES, FILE_NAMES } from '../constants';

export interface CampaignPaths {
  root: string;
  campaignJson: string;
  stateJson: string;
  lockFile: string;
  tasksDir: string;
  modelsDir: string;
  runsDir: string;
  registersDir: string;
  locksDir: string;
}

export function getCampaignPaths(cwd: string = process.cwd()): CampaignPaths {
  const root = path.join(cwd, DIRECTORY_NAMES.ROOT);
  return {
    root,
    campaignJson: path.join(root, FILE_NAMES.CAMPAIGN),
    stateJson: path.join(root, FILE_NAMES.STATE),
    lockFile: path.join(root, DIRECTORY_NAMES.LOCKS, FILE_NAMES.LOCK),
    tasksDir: path.join(root, DIRECTORY_NAMES.TASKS),
    modelsDir: path.join(root, DIRECTORY_NAMES.MODELS),
    runsDir: path.join(root, DIRECTORY_NAMES.RUNS),
    registersDir: path.join(root, DIRECTORY_NAMES.REGISTERS),
    locksDir: path.join(root, DIRECTORY_NAMES.LOCKS)
  };
}

export function isCampaignInitialized(cwd: string = process.cwd()): boolean {
  const paths = getCampaignPaths(cwd);
  return fs.existsSync(paths.root);
}

export function createDirectoryLayout(cwd: string = process.cwd()): CampaignPaths {
  const paths = getCampaignPaths(cwd);

  fs.mkdirSync(paths.root, { recursive: true });
  fs.mkdirSync(paths.tasksDir, { recursive: true });
  fs.mkdirSync(paths.modelsDir, { recursive: true });
  fs.mkdirSync(paths.runsDir, { recursive: true });
  fs.mkdirSync(paths.registersDir, { recursive: true });
  fs.mkdirSync(paths.locksDir, { recursive: true });

  return paths;
}
