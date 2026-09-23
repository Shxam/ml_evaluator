import * as path from 'path';
import * as crypto from 'crypto';
import { getCampaignPaths } from '../storage/layout';
import { atomicWriteJson } from '../storage/atomic';
import { getAttemptManifestFilename } from '../identity/runId';
import { AttemptManifest, ExecutionStatus } from './types';

export interface CreateManifestParams {
  runId: string;
  attempt: number;
  campaignId: string;
  campaignRev: number;
  modelId: string;
  taskId: string;
  repetition: number;
  status: ExecutionStatus;
  rawScore: number | null;
  normalizedScore?: number | null;
  exitCode: number | null;
  executionTimeMs: number;
  stdout: string;
  stderr: string;
  completedAt?: number;
}

/**
 * Creates an attempt manifest and saves it atomically to .evalcampaign/runs/<run_id>_att<N>.json.
 */
export function persistAttemptManifest(params: CreateManifestParams, cwd: string = process.cwd()): AttemptManifest {
  const paths = getCampaignPaths(cwd);
  const filename = getAttemptManifestFilename(params.runId, params.attempt);
  const targetPath = path.join(paths.runsDir, filename);

  const stdoutHash = crypto.createHash('sha256').update(params.stdout, 'utf8').digest('hex');
  const stderrHash = crypto.createHash('sha256').update(params.stderr, 'utf8').digest('hex');

  const manifest: AttemptManifest = {
    run_id: params.runId,
    attempt: params.attempt,
    campaign_id: params.campaignId,
    campaign_rev: params.campaignRev,
    model_id: params.modelId,
    task_id: params.taskId,
    repetition: params.repetition,
    status: params.status,
    raw_score: params.rawScore,
    normalized_score: params.normalizedScore !== undefined ? params.normalizedScore : params.rawScore,
    exit_code: params.exitCode,
    execution_time_ms: params.executionTimeMs,
    stdout: params.stdout,
    stderr: params.stderr,
    stdout_hash: stdoutHash,
    stderr_hash: stderrHash,
    completed_at: params.completedAt || Date.now()
  };

  atomicWriteJson(targetPath, manifest);
  return manifest;
}
