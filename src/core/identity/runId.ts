import * as crypto from 'crypto';

export interface RunIdParams {
  campaign_id: string;
  campaign_rev: number;
  model_id: string;
  task_id: string;
  repetition: number;
}

/**
 * Computes deterministic 16-character Run ID according to the canonical specification:
 * seed = f"{campaign_id}:{campaign_rev}:{model_id}:{task_id}:{repetition}"
 * run_id = SHA-256(seed UTF-8 bytes).hexdigest()[:16]
 */
export function computeRunId(params: RunIdParams): string {
  const seed = `${params.campaign_id}:${params.campaign_rev}:${params.model_id}:${params.task_id}:${params.repetition}`;
  return crypto.createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 16);
}

/**
 * Computes the canonical attempt manifest filename for a given run ID and attempt number.
 * Format: <run_id>_att<N>.json
 */
export function getAttemptManifestFilename(runId: string, attempt: number): string {
  return `${runId}_att${attempt}.json`;
}
