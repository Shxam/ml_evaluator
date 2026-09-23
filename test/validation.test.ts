import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { validateCampaignConfig, validateBudget, validateScoring } from '../src/core/validation/campaign';

describe('Campaign Schema Validation', () => {
  const validConfig = {
    campaign_id: 'coding_eval_v1',
    name: 'Frontier Agent Coding Evaluation',
    budget: {
      max_wall_time_seconds: 1800,
      max_total_attempts: 100,
      max_output_bytes: 1048576
    },
    scoring: {
      aggregation: 'weighted_mean',
      missing_policy: 'zero'
    }
  };

  test('accepts valid campaign configuration', () => {
    const result = validateCampaignConfig(validConfig);
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.errors.length, 0);
    assert.strictEqual(result.config?.campaign_id, 'coding_eval_v1');
  });

  test('rejects missing or empty campaign_id', () => {
    const invalid = { ...validConfig, campaign_id: '' };
    const result = validateCampaignConfig(invalid);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('campaign_id')));
  });

  test('rejects missing or empty name', () => {
    const invalid = { ...validConfig, name: '   ' };
    const result = validateCampaignConfig(invalid);
    assert.strictEqual(result.valid, false);
    assert.ok(result.errors.some(e => e.includes('name')));
  });

  test('rejects negative or zero budget parameters', () => {
    assert.strictEqual(validateBudget({ max_wall_time_seconds: 0, max_total_attempts: 10, max_output_bytes: 100 }).valid, false);
    assert.strictEqual(validateBudget({ max_wall_time_seconds: 100, max_total_attempts: -1, max_output_bytes: 100 }).valid, false);
    assert.strictEqual(validateBudget({ max_wall_time_seconds: 100, max_total_attempts: 10, max_output_bytes: 0 }).valid, false);
  });

  test('rejects unsupported scoring parameters', () => {
    assert.strictEqual(validateScoring({ aggregation: 'simple_mean', missing_policy: 'zero' }).valid, false);
    assert.strictEqual(validateScoring({ aggregation: 'weighted_mean', missing_policy: 'ignore' }).valid, false);
  });
});
