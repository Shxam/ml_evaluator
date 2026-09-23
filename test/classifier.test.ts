import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { classifyExecution } from '../src/core/execution/classifier';
import { EXECUTION_STATUSES } from '../src/core/execution/types';

describe('Evaluator Result Classifier & Score Semantics', () => {
  test('classifies valid 0.0 score as COMPLETED (never treating 0.0 as failure)', () => {
    const res = classifyExecution({
      exitCode: 0,
      stdout: JSON.stringify({ score: 0.0 }),
      timedOut: false,
      outputOverflow: false
    });
    assert.strictEqual(res.status, EXECUTION_STATUSES.COMPLETED);
    assert.strictEqual(res.rawScore, 0.0);
  });

  test('classifies positive finite scores as COMPLETED', () => {
    const res = classifyExecution({
      exitCode: 0,
      stdout: JSON.stringify({ score: 0.85 }),
      timedOut: false,
      outputOverflow: false
    });
    assert.strictEqual(res.status, EXECUTION_STATUSES.COMPLETED);
    assert.strictEqual(res.rawScore, 0.85);
  });

  test('classifies negative finite scores as COMPLETED', () => {
    const res = classifyExecution({
      exitCode: 0,
      stdout: JSON.stringify({ score: -0.5 }),
      timedOut: false,
      outputOverflow: false
    });
    assert.strictEqual(res.status, EXECUTION_STATUSES.COMPLETED);
    assert.strictEqual(res.rawScore, -0.5);
  });

  test('classifies non-zero exit code as EVALUATOR_CRASH', () => {
    const res = classifyExecution({
      exitCode: 1,
      stdout: JSON.stringify({ score: 1.0 }),
      timedOut: false,
      outputOverflow: false
    });
    assert.strictEqual(res.status, EXECUTION_STATUSES.EVALUATOR_CRASH);
    assert.strictEqual(res.rawScore, null);
  });

  test('classifies timedOut flag as TIMEOUT regardless of exit code', () => {
    const res = classifyExecution({
      exitCode: 0,
      stdout: JSON.stringify({ score: 1.0 }),
      timedOut: true,
      outputOverflow: false
    });
    assert.strictEqual(res.status, EXECUTION_STATUSES.TIMEOUT);
    assert.strictEqual(res.rawScore, null);
  });

  test('classifies outputOverflow flag as OUTPUT_OVERFLOW', () => {
    const res = classifyExecution({
      exitCode: 0,
      stdout: '{"score": 1.0}',
      timedOut: false,
      outputOverflow: true
    });
    assert.strictEqual(res.status, EXECUTION_STATUSES.OUTPUT_OVERFLOW);
    assert.strictEqual(res.rawScore, null);
  });

  test('classifies invalid JSON as MALFORMED_OUTPUT', () => {
    const res = classifyExecution({
      exitCode: 0,
      stdout: '{ score: 1.0 invalid json',
      timedOut: false,
      outputOverflow: false
    });
    assert.strictEqual(res.status, EXECUTION_STATUSES.MALFORMED_OUTPUT);
    assert.strictEqual(res.rawScore, null);
  });

  test('classifies missing score field as MALFORMED_OUTPUT', () => {
    const res = classifyExecution({
      exitCode: 0,
      stdout: JSON.stringify({ other_field: 'hello' }),
      timedOut: false,
      outputOverflow: false
    });
    assert.strictEqual(res.status, EXECUTION_STATUSES.MALFORMED_OUTPUT);
    assert.strictEqual(res.rawScore, null);
  });

  test('classifies non-numeric string score as MALFORMED_OUTPUT', () => {
    const res = classifyExecution({
      exitCode: 0,
      stdout: JSON.stringify({ score: 'not_a_number' }),
      timedOut: false,
      outputOverflow: false
    });
    assert.strictEqual(res.status, EXECUTION_STATUSES.MALFORMED_OUTPUT);
    assert.strictEqual(res.rawScore, null);
  });

  test('classifies NaN as MALFORMED_OUTPUT', () => {
    const res = classifyExecution({
      exitCode: 0,
      stdout: '{"score": "NaN"}',
      timedOut: false,
      outputOverflow: false
    });
    assert.strictEqual(res.status, EXECUTION_STATUSES.MALFORMED_OUTPUT);
    assert.strictEqual(res.rawScore, null);
  });

  test('classifies Infinity and -Infinity as MALFORMED_OUTPUT', () => {
    const resPos = classifyExecution({
      exitCode: 0,
      stdout: '{"score": "Infinity"}',
      timedOut: false,
      outputOverflow: false
    });
    assert.strictEqual(resPos.status, EXECUTION_STATUSES.MALFORMED_OUTPUT);
    assert.strictEqual(resPos.rawScore, null);

    const resNeg = classifyExecution({
      exitCode: 0,
      stdout: '{"score": "-Infinity"}',
      timedOut: false,
      outputOverflow: false
    });
    assert.strictEqual(resNeg.status, EXECUTION_STATUSES.MALFORMED_OUTPUT);
    assert.strictEqual(resNeg.rawScore, null);
  });
});
