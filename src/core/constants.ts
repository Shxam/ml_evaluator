export const EXIT_CODES = {
  SUCCESS: 0,
  USAGE_ERROR: 1,
  VALIDATION_ERROR: 2,
  LOCK_CONTENTION: 3,
  INVALID_STATE: 4,
  PROVENANCE_DRIFT: 5,
  BUDGET_EXCEEDED: 6,
  UNRECOVERABLE_CORRUPTION: 7
} as const;

export type ExitCode = typeof EXIT_CODES[keyof typeof EXIT_CODES];

export const DIRECTORY_NAMES = {
  ROOT: '.evalcampaign',
  TASKS: 'tasks',
  MODELS: 'models',
  RUNS: 'runs',
  REGISTERS: 'registers',
  LOCKS: 'locks'
} as const;

export const FILE_NAMES = {
  CAMPAIGN: 'campaign.json',
  STATE: 'state.json',
  LOCK: 'campaign.lock'
} as const;

export const LIFECYCLE_STATES = {
  CREATED: 'created',
  CONFIGURED: 'configured',
  RUNNING: 'running',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed'
} as const;

export type LifecycleState = typeof LIFECYCLE_STATES[keyof typeof LIFECYCLE_STATES];
