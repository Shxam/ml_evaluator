import { CampaignConfig, BudgetConfig, ScoringConfig } from '../types';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  config?: CampaignConfig;
}

export function validateBudget(rawBudget: unknown): { valid: boolean; errors: string[]; budget?: BudgetConfig } {
  const errors: string[] = [];
  if (!rawBudget || typeof rawBudget !== 'object' || Array.isArray(rawBudget)) {
    return { valid: false, errors: ['Field "budget" must be an object.'] };
  }

  const budget = rawBudget as Record<string, unknown>;

  if (typeof budget.max_wall_time_seconds !== 'number' || !Number.isFinite(budget.max_wall_time_seconds) || budget.max_wall_time_seconds <= 0) {
    errors.push('budget.max_wall_time_seconds must be a positive number.');
  }

  if (typeof budget.max_total_attempts !== 'number' || !Number.isInteger(budget.max_total_attempts) || budget.max_total_attempts <= 0) {
    errors.push('budget.max_total_attempts must be a positive integer.');
  }

  if (typeof budget.max_output_bytes !== 'number' || !Number.isInteger(budget.max_output_bytes) || budget.max_output_bytes <= 0) {
    errors.push('budget.max_output_bytes must be a positive integer.');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    budget: {
      max_wall_time_seconds: budget.max_wall_time_seconds as number,
      max_total_attempts: budget.max_total_attempts as number,
      max_output_bytes: budget.max_output_bytes as number
    }
  };
}

export function validateScoring(rawScoring: unknown): { valid: boolean; errors: string[]; scoring?: ScoringConfig } {
  const errors: string[] = [];
  if (!rawScoring || typeof rawScoring !== 'object' || Array.isArray(rawScoring)) {
    return { valid: false, errors: ['Field "scoring" must be an object.'] };
  }

  const scoring = rawScoring as Record<string, unknown>;

  if (scoring.aggregation !== 'weighted_mean') {
    errors.push(`Unsupported scoring.aggregation: "${String(scoring.aggregation)}". Supported: "weighted_mean".`);
  }

  if (scoring.missing_policy !== 'zero') {
    errors.push(`Unsupported scoring.missing_policy: "${String(scoring.missing_policy)}". Supported: "zero".`);
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    scoring: {
      aggregation: 'weighted_mean',
      missing_policy: 'zero'
    }
  };
}

export function validateCampaignConfig(raw: unknown): ValidationResult {
  const errors: string[] = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['Campaign configuration must be a JSON object.'] };
  }

  const record = raw as Record<string, unknown>;

  if (typeof record.campaign_id !== 'string' || record.campaign_id.trim() === '') {
    errors.push('Field "campaign_id" must be a non-empty string.');
  }

  if (typeof record.name !== 'string' || record.name.trim() === '') {
    errors.push('Field "name" must be a non-empty string.');
  }

  const budgetRes = validateBudget(record.budget);
  if (!budgetRes.valid) {
    errors.push(...budgetRes.errors);
  }

  const scoringRes = validateScoring(record.scoring);
  if (!scoringRes.valid) {
    errors.push(...scoringRes.errors);
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const config: CampaignConfig = {
    ...record,
    campaign_id: (record.campaign_id as string).trim(),
    name: (record.name as string).trim(),
    budget: budgetRes.budget!,
    scoring: scoringRes.scoring!
  };

  return { valid: true, errors: [], config };
}
