import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import * as crypto from 'crypto';
import { computeRunId, getAttemptManifestFilename } from '../src/core/identity/runId';

describe('Deterministic Run ID Derivation', () => {
  const baseParams = {
    campaign_id: 'coding_eval_v1',
    campaign_rev: 1,
    model_id: 'claude_opus_5',
    task_id: 'syntax_validation',
    repetition: 1
  };

  test('computes exact known 16-character lowercase SHA-256 prefix', () => {
    const seed = 'coding_eval_v1:1:claude_opus_5:syntax_validation:1';
    const expected = crypto.createHash('sha256').update(seed, 'utf8').digest('hex').slice(0, 16);

    const runId = computeRunId(baseParams);
    assert.strictEqual(runId, expected);
    assert.strictEqual(runId.length, 16);
    assert.match(runId, /^[0-9a-f]{16}$/);
  });

  test('produces identical run ID across repeated executions', () => {
    const runId1 = computeRunId(baseParams);
    const runId2 = computeRunId({ ...baseParams });
    assert.strictEqual(runId1, runId2);
  });

  test('changes run ID when campaign_rev changes', () => {
    const runIdRev1 = computeRunId({ ...baseParams, campaign_rev: 1 });
    const runIdRev2 = computeRunId({ ...baseParams, campaign_rev: 2 });
    assert.notStrictEqual(runIdRev1, runIdRev2);
  });

  test('changes run ID when model_id changes', () => {
    const runId1 = computeRunId({ ...baseParams, model_id: 'claude_opus_5' });
    const runId2 = computeRunId({ ...baseParams, model_id: 'gpt_5_turbo' });
    assert.notStrictEqual(runId1, runId2);
  });

  test('changes run ID when task_id changes', () => {
    const runId1 = computeRunId({ ...baseParams, task_id: 'syntax_validation' });
    const runId2 = computeRunId({ ...baseParams, task_id: 'unit_testing' });
    assert.notStrictEqual(runId1, runId2);
  });

  test('changes run ID when repetition changes', () => {
    const runIdRep1 = computeRunId({ ...baseParams, repetition: 1 });
    const runIdRep2 = computeRunId({ ...baseParams, repetition: 2 });
    assert.notStrictEqual(runIdRep1, runIdRep2);
  });

  test('generates canonical attempt manifest filenames', () => {
    const runId = computeRunId(baseParams);
    assert.strictEqual(getAttemptManifestFilename(runId, 1), `${runId}_att1.json`);
    assert.strictEqual(getAttemptManifestFilename(runId, 2), `${runId}_att2.json`);
  });
});
