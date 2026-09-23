import { ModelDefinition } from '../types';

export interface ModelValidationResult {
  valid: boolean;
  errors: string[];
  model?: ModelDefinition;
}

export function validateModelDefinition(raw: unknown): ModelValidationResult {
  const errors: string[] = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { valid: false, errors: ['Model definition must be a JSON object.'] };
  }

  const record = raw as Record<string, unknown>;

  if (typeof record.model_id !== 'string' || record.model_id.trim() === '') {
    errors.push('Field "model_id" must be a non-empty string.');
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  const model: ModelDefinition = {
    ...record,
    model_id: (record.model_id as string).trim()
  };

  return { valid: true, errors: [], model };
}
