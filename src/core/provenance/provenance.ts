import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { EXIT_CODES, ExitCode } from '../constants';
import { getCampaignPaths, isCampaignInitialized } from '../storage/layout';
import { readJson, atomicWriteJson } from '../storage/atomic';
import { TaskDefinition } from '../types';

export interface TaskProvenanceMap {
  [taskId: string]: string; // taskId -> SHA-256 hex digest
}

export interface ProvenanceVerificationResult {
  valid: boolean;
  driftedTask?: string;
  expectedHash?: string;
  actualHash?: string;
  error?: string;
}

export class ProvenanceDriftError extends Error {
  public readonly exitCode: ExitCode = EXIT_CODES.PROVENANCE_DRIFT;
  public readonly taskId?: string;

  constructor(message: string, taskId?: string) {
    super(message);
    this.name = 'ProvenanceDriftError';
    this.taskId = taskId;
  }
}

export function getProvenanceFilePath(cwd: string = process.cwd()): string {
  const paths = getCampaignPaths(cwd);
  return path.join(paths.root, 'provenance.json');
}

/**
 * Computes SHA-256 digest in lowercase hexadecimal for a file on disk.
 */
export function computeFileSha256(filePath: string): string {
  const fileBytes = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(fileBytes).digest('hex');
}

/**
 * Captures baseline SHA-256 hashes for all registered tasks in .evalcampaign/tasks/
 * and durably stores them in .evalcampaign/provenance.json.
 */
export function captureTaskBaselines(cwd: string = process.cwd()): TaskProvenanceMap {
  if (!isCampaignInitialized(cwd)) {
    throw new Error('Campaign is not initialized in current directory.');
  }

  const paths = getCampaignPaths(cwd);
  const taskFiles = fs.readdirSync(paths.tasksDir).filter(f => f.endsWith('.json')).sort();
  const baseline: TaskProvenanceMap = {};

  for (const file of taskFiles) {
    const taskPath = path.join(paths.tasksDir, file);
    const task = readJson<TaskDefinition>(taskPath);
    if (task && task.task_id) {
      const hash = computeFileSha256(taskPath);
      baseline[task.task_id] = hash;
    }
  }

  const provenancePath = getProvenanceFilePath(cwd);
  atomicWriteJson(provenancePath, baseline);

  return baseline;
}

/**
 * Verifies registered task files against their recorded baseline SHA-256 digests.
 * Fails closed if baseline is missing, a task file is deleted, or any task file was modified.
 */
export function verifyTaskProvenance(cwd: string = process.cwd()): ProvenanceVerificationResult {
  const provenancePath = getProvenanceFilePath(cwd);
  if (!fs.existsSync(provenancePath)) {
    return {
      valid: false,
      error: 'Provenance baseline has not been captured yet (provenance.json missing).'
    };
  }

  const baseline = readJson<TaskProvenanceMap>(provenancePath);
  const paths = getCampaignPaths(cwd);

  for (const [taskId, expectedHash] of Object.entries(baseline)) {
    const taskPath = path.join(paths.tasksDir, `${taskId}.json`);
    if (!fs.existsSync(taskPath)) {
      return {
        valid: false,
        driftedTask: taskId,
        error: `Protected task file "${taskId}.json" is missing from disk.`
      };
    }

    const actualHash = computeFileSha256(taskPath);
    if (actualHash !== expectedHash) {
      return {
        valid: false,
        driftedTask: taskId,
        expectedHash,
        actualHash,
        error: `Provenance drift detected: Task "${taskId}" content modified on disk.`
      };
    }
  }

  return { valid: true };
}

/**
 * Asserts task provenance. Throws ProvenanceDriftError if any drift is detected.
 */
export function assertTaskProvenance(cwd: string = process.cwd()): void {
  const result = verifyTaskProvenance(cwd);
  if (!result.valid) {
    throw new ProvenanceDriftError(
      result.error || 'Provenance drift detected in registered tasks.',
      result.driftedTask
    );
  }
}
