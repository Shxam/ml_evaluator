import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { handleInit } from '../src/cli/commands/init';
import { handleAddTask } from '../src/cli/commands/addTask';
import {
  captureTaskBaselines,
  verifyTaskProvenance,
  assertTaskProvenance,
  ProvenanceDriftError
} from '../src/core/provenance/provenance';
import { EXIT_CODES } from '../src/core/constants';
import { readJson } from '../src/core/storage/atomic';

describe('Cryptographic Task Provenance & Drift Verification', () => {
  let workDir: string;
  let task1Path: string;
  let task2Path: string;

  const validCampaign = {
    campaign_id: 'prov_test_camp',
    name: 'Provenance Test Campaign',
    budget: { max_wall_time_seconds: 60, max_total_attempts: 10, max_output_bytes: 1024 },
    scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
  };

  const task1 = {
    task_id: 'task_syntax',
    command: 'python3 eval_syntax.py',
    timeout_seconds: 10,
    weight: 0.5,
    retry_policy: { max_attempts: 2, retry_on: ['timeout'] }
  };

  const task2 = {
    task_id: 'task_unit',
    command: 'python3 eval_unit.py',
    timeout_seconds: 15,
    weight: 0.5,
    retry_policy: { max_attempts: 2, retry_on: ['evaluator_crash'] }
  };

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalcampaign-prov-test-'));
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(validCampaign, null, 2));
    handleInit(campPath, workDir);

    task1Path = path.join(workDir, 'task1.json');
    fs.writeFileSync(task1Path, JSON.stringify(task1, null, 2));
    handleAddTask(task1Path, workDir);

    task2Path = path.join(workDir, 'task2.json');
    fs.writeFileSync(task2Path, JSON.stringify(task2, null, 2));
    handleAddTask(task2Path, workDir);
  });

  afterEach(() => {
    if (fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('captures and durably persists baseline SHA-256 digests for all registered tasks', () => {
    const baselines = captureTaskBaselines(workDir);

    assert.ok(baselines['task_syntax'], 'Should capture task_syntax hash');
    assert.ok(baselines['task_unit'], 'Should capture task_unit hash');
    assert.strictEqual(baselines['task_syntax'].length, 64);
    assert.strictEqual(baselines['task_unit'].length, 64);

    const provFile = path.join(workDir, '.evalcampaign', 'provenance.json');
    assert.ok(fs.existsSync(provFile), 'provenance.json should exist on disk');

    const persisted = readJson<Record<string, string>>(provFile);
    assert.deepStrictEqual(persisted, baselines);
  });

  test('passes verification when task files are untouched', () => {
    captureTaskBaselines(workDir);

    const result = verifyTaskProvenance(workDir);
    assert.strictEqual(result.valid, true);
    assert.doesNotThrow(() => assertTaskProvenance(workDir));
  });

  test('detects single-byte tampering on disk and fails with exit code 5 (ProvenanceDriftError)', () => {
    captureTaskBaselines(workDir);

    // Tamper with task1 on disk
    const targetFile = path.join(workDir, '.evalcampaign', 'tasks', 'task_syntax.json');
    const content = fs.readFileSync(targetFile, 'utf8');
    // Modify 1 character
    fs.writeFileSync(targetFile, content + ' ');

    const result = verifyTaskProvenance(workDir);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.driftedTask, 'task_syntax');

    assert.throws(
      () => assertTaskProvenance(workDir),
      (err: unknown) => {
        const driftErr = err as ProvenanceDriftError;
        return driftErr instanceof ProvenanceDriftError && driftErr.exitCode === EXIT_CODES.PROVENANCE_DRIFT;
      }
    );
  });

  test('fails closed with error when a protected task file is deleted from disk', () => {
    captureTaskBaselines(workDir);

    // Delete task2 from disk
    const targetFile = path.join(workDir, '.evalcampaign', 'tasks', 'task_unit.json');
    fs.unlinkSync(targetFile);

    const result = verifyTaskProvenance(workDir);
    assert.strictEqual(result.valid, false);
    assert.strictEqual(result.driftedTask, 'task_unit');

    assert.throws(
      () => assertTaskProvenance(workDir),
      (err: unknown) => {
        const driftErr = err as ProvenanceDriftError;
        return driftErr instanceof ProvenanceDriftError && driftErr.exitCode === EXIT_CODES.PROVENANCE_DRIFT;
      }
    );
  });
});
