import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { shouldRetry } from '../src/core/execution/retry';
import { EXECUTION_STATUSES } from '../src/core/execution/types';

describe('Task Retry Policy Logic', () => {
  const policy = {
    max_attempts: 3,
    retry_on: ['timeout', 'evaluator_crash']
  };

  test('COMPLETED status never retries', () => {
    assert.strictEqual(shouldRetry(EXECUTION_STATUSES.COMPLETED, 1, policy), false);
    assert.strictEqual(shouldRetry(EXECUTION_STATUSES.COMPLETED, 2, policy), false);
  });

  test('retries on matching conditions when attempt < max_attempts', () => {
    assert.strictEqual(shouldRetry(EXECUTION_STATUSES.TIMEOUT, 1, policy), true);
    assert.strictEqual(shouldRetry(EXECUTION_STATUSES.TIMEOUT, 2, policy), true);
    assert.strictEqual(shouldRetry(EXECUTION_STATUSES.EVALUATOR_CRASH, 1, policy), true);
    assert.strictEqual(shouldRetry(EXECUTION_STATUSES.EVALUATOR_CRASH, 2, policy), true);
  });

  test('stops retrying when attempt reaches max_attempts', () => {
    assert.strictEqual(shouldRetry(EXECUTION_STATUSES.TIMEOUT, 3, policy), false);
    assert.strictEqual(shouldRetry(EXECUTION_STATUSES.EVALUATOR_CRASH, 3, policy), false);
  });

  test('does not retry on unlisted error conditions like MALFORMED_OUTPUT', () => {
    assert.strictEqual(shouldRetry(EXECUTION_STATUSES.MALFORMED_OUTPUT, 1, policy), false);
  });

  test('does not retry on unlisted error conditions like OUTPUT_OVERFLOW unless in policy', () => {
    assert.strictEqual(shouldRetry(EXECUTION_STATUSES.OUTPUT_OVERFLOW, 1, policy), false);
  });
});
