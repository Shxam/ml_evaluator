export const EXECUTION_STATUSES = {
  COMPLETED: 'COMPLETED',
  EVALUATOR_CRASH: 'EVALUATOR_CRASH',
  TIMEOUT: 'TIMEOUT',
  MALFORMED_OUTPUT: 'MALFORMED_OUTPUT',
  OUTPUT_OVERFLOW: 'OUTPUT_OVERFLOW'
} as const;

export type ExecutionStatus = typeof EXECUTION_STATUSES[keyof typeof EXECUTION_STATUSES];

export interface SubprocessExecutionResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  executionTimeMs: number;
  timedOut: boolean;
  outputOverflow: boolean;
}

export interface ClassificationResult {
  status: ExecutionStatus;
  rawScore: number | null;
}

export interface AttemptManifest {
  run_id: string;
  attempt: number;
  campaign_id: string;
  campaign_rev: number;
  model_id: string;
  task_id: string;
  repetition: number;
  status: ExecutionStatus;
  raw_score: number | null;
  normalized_score: number | null;
  exit_code: number | null;
  execution_time_ms: number;
  stdout: string;
  stderr: string;
  stdout_hash: string;
  stderr_hash: string;
  completed_at: number;
}
