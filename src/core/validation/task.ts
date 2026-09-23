import { TaskDefinition, RetryPolicy } from '../types';

export interface TaskValidationResult {
  valid: boolean;
  errors: string[];
  task?: TaskDefinition;
}

export function validateRetryPolicy(rawPolicy: unknown): { valid: boolean; errors: string[]; policy?: RetryPolicy } {
  const errors: string[] = [];

  if (!rawPolicy || typeof rawPolicy !== 'object' || Array.isArray(rawPolicy)) {
    return { valid: false, errors: ['Field "retry_policy" must be an object.'] };
  }

  const policy = rawPolicy as Record<string, unknown>;

  if (typeof policy.max_attempts !== 'number' || !Number.isInteger(policy.max_attempts) || policy.max_attempts < 1) {
    errors.push('retry_policy.max_attempts must be an integer >= 1.');
  }

  if (!Array.isArray(policy.retry_on)) {
    errors.push('retry_policy.retry_on must be an array of string conditions.');
  } else {
    for (let i = 0; i < policy.retry_on.length; i++) {
      const condition = policy.retry_on[i];
      if (typeof condition !== 'string' || condition.trim() === '') {
        errors.push(`retry_policy.retry_on[${i}] must be a non-empty string.`);
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return {
    valid: true,
    errors: [],
    policy: {
      max_attempts: policy.max_attempts as number,
      retry_on: (policy.retry_on as string[]).map(s => s.trim())
    }
  };
}

export function validateTaskDefinition(raw: unknown): TaskValidationResult {
  const errors: string[] = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['Task definition must be a JSON object.'] };
  }

  const record = raw as Record<string, unknown>;

  if (typeof record.task_id !== 'string' || record.task_id.trim() === '') {
    errors.push('Field "task_id" must be a non-empty string.');
  }

  if (typeof record.command !== 'string' || record.command.trim() === '') {
    errors.push('Field "command" must be a non-empty string.');
  }

  if (typeof record.timeout_seconds !== 'number' || !Number.isFinite(record.timeout_seconds) || record.timeout_seconds <= 0) {
    errors.push('Field "timeout_seconds" must be a positive number (> 0).');
  }

  if (typeof record.weight !== 'number' || !Number.isFinite(record.weight) || record.weight <= 0) {
    errors.push('Field "weight" must be a positive number (> 0).');
  }

  const policyRes = validateRetryPolicy(record.retry_policy);
  if (!policyRes.valid) {
    errors.push(...policyRes.errors);
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const task: TaskDefinition = {
    ...record,
    task_id: (record.task_id as string).trim(),
    command: (record.command as string).trim(),
    timeout_seconds: record.timeout_seconds as number,
    weight: record.weight as number,
    retry_policy: policyRes.policy!
  };

  return { valid: true, errors: [], task };
}
