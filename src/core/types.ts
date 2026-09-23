import { LifecycleState } from './constants';
export { LifecycleState };

export interface BudgetConfig {
  max_wall_time_seconds: number;
  max_total_attempts: number;
  max_output_bytes: number;
}

export interface ScoringConfig {
  aggregation: 'weighted_mean';
  missing_policy: 'zero';
}

export interface CampaignConfig {
  campaign_id: string;
  name: string;
  budget: BudgetConfig;
  scoring: ScoringConfig;
  [key: string]: unknown;
}

export interface CampaignState {
  campaign_id: string;
  campaign_rev: number;
  lifecycle_state: LifecycleState;
  budget: BudgetConfig;
  scoring: ScoringConfig;
  total_attempts?: number;
  completed_runs?: number;
  created_at: number;
  updated_at: number;
  [key: string]: unknown;
}

export interface RetryPolicy {
  max_attempts: number;
  retry_on: string[];
}

export interface TaskDefinition {
  task_id: string;
  command: string;
  timeout_seconds: number;
  weight: number;
  retry_policy: RetryPolicy;
  [key: string]: unknown;
}

export interface ModelDefinition {
  model_id: string;
  name?: string;
  [key: string]: unknown;
}
