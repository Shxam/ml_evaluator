import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { handleInit } from '../src/cli/commands/init';
import { handleAddTask } from '../src/cli/commands/addTask';
import { EXIT_CODES } from '../src/core/constants';
import { readJson } from '../src/core/storage/atomic';
import { TaskDefinition } from '../src/core/types';
import { validateTaskDefinition } from '../src/core/validation/task';

describe('Task Definition Schema & add-task Command', () => {
  let workDir: string;
  let validTaskPath: string;

  const validCampaign = {
    campaign_id: 'test_camp',
    name: 'Test Campaign',
    budget: { max_wall_time_seconds: 100, max_total_attempts: 10, max_output_bytes: 1024 },
    scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
  };

  const validTask: TaskDefinition = {
    task_id: 'syntax_validation',
    command: 'python3 mock_eval.py --task=syntax',
    timeout_seconds: 10,
    weight: 0.25,
    retry_policy: {
      max_attempts: 3,
      retry_on: ['timeout', 'evaluator_crash']
    }
  };

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalcampaign-task-test-'));
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(validCampaign, null, 2));
    handleInit(campPath, workDir);

    validTaskPath = path.join(workDir, 'task_syntax.json');
    fs.writeFileSync(validTaskPath, JSON.stringify(validTask, null, 2));
  });

  afterEach(() => {
    if (fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('registers valid task successfully (exit 0) and persists definition deterministically', () => {
    const code = handleAddTask(validTaskPath, workDir);
    assert.strictEqual(code, EXIT_CODES.SUCCESS);

    const taskFile = path.join(workDir, '.evalcampaign', 'tasks', 'syntax_validation.json');
    assert.ok(fs.existsSync(taskFile), 'Persisted task file should exist');

    const loaded = readJson<TaskDefinition>(taskFile);
    assert.strictEqual(loaded.task_id, 'syntax_validation');
    assert.strictEqual(loaded.command, 'python3 mock_eval.py --task=syntax');
    assert.strictEqual(loaded.timeout_seconds, 10);
    assert.strictEqual(loaded.weight, 0.25);
    assert.strictEqual(loaded.retry_policy.max_attempts, 3);
    assert.deepStrictEqual(loaded.retry_policy.retry_on, ['timeout', 'evaluator_crash']);

    // Ensure source file was not mutated
    const sourceContent = fs.readFileSync(validTaskPath, 'utf8');
    assert.deepStrictEqual(JSON.parse(sourceContent), validTask);
  });

  test('rejects duplicate task registration with exit code 2 and does not overwrite original', () => {
    const code1 = handleAddTask(validTaskPath, workDir);
    assert.strictEqual(code1, EXIT_CODES.SUCCESS);

    // Modify source file with same task_id but different weight
    const modifiedTask = { ...validTask, weight: 0.99 };
    fs.writeFileSync(validTaskPath, JSON.stringify(modifiedTask, null, 2));

    const code2 = handleAddTask(validTaskPath, workDir);
    assert.strictEqual(code2, EXIT_CODES.VALIDATION_ERROR);

    // Verify original persisted file is untouched
    const taskFile = path.join(workDir, '.evalcampaign', 'tasks', 'syntax_validation.json');
    const loaded = readJson<TaskDefinition>(taskFile);
    assert.strictEqual(loaded.weight, 0.25);
  });

  test('validates task schema failure modes', () => {
    assert.strictEqual(validateTaskDefinition({}).valid, false);
    assert.strictEqual(validateTaskDefinition({ ...validTask, task_id: '' }).valid, false);
    assert.strictEqual(validateTaskDefinition({ ...validTask, command: ' ' }).valid, false);
    assert.strictEqual(validateTaskDefinition({ ...validTask, timeout_seconds: 0 }).valid, false);
    assert.strictEqual(validateTaskDefinition({ ...validTask, timeout_seconds: -5 }).valid, false);
    assert.strictEqual(validateTaskDefinition({ ...validTask, weight: 0 }).valid, false);
    assert.strictEqual(validateTaskDefinition({ ...validTask, weight: -1 }).valid, false);
    assert.strictEqual(validateTaskDefinition({ ...validTask, retry_policy: null }).valid, false);
    assert.strictEqual(
      validateTaskDefinition({
        ...validTask,
        retry_policy: { max_attempts: 0, retry_on: ['timeout'] }
      }).valid,
      false
    );
    assert.strictEqual(
      validateTaskDefinition({
        ...validTask,
        retry_policy: { max_attempts: 2, retry_on: 'timeout' }
      }).valid,
      false
    );
  });

  test('rejects invalid task file with exit code 2 and creates no partial task file', () => {
    const invalidPath = path.join(workDir, 'invalid_task.json');
    fs.writeFileSync(
      invalidPath,
      JSON.stringify({ ...validTask, task_id: 'bad_task', weight: -10 })
    );

    const code = handleAddTask(invalidPath, workDir);
    assert.strictEqual(code, EXIT_CODES.VALIDATION_ERROR);

    const taskFile = path.join(workDir, '.evalcampaign', 'tasks', 'bad_task.json');
    assert.ok(!fs.existsSync(taskFile), 'Should not create partial/invalid task file');
  });

  test('rejects malformed JSON with exit code 2', () => {
    const malformedPath = path.join(workDir, 'malformed.json');
    fs.writeFileSync(malformedPath, '{ not json');

    const code = handleAddTask(malformedPath, workDir);
    assert.strictEqual(code, EXIT_CODES.VALIDATION_ERROR);
  });

  test('rejects missing or non-existent file path with exit code 1', () => {
    assert.strictEqual(handleAddTask(undefined, workDir), EXIT_CODES.USAGE_ERROR);
    assert.strictEqual(
      handleAddTask(path.join(workDir, 'missing.json'), workDir),
      EXIT_CODES.USAGE_ERROR
    );
  });

  test('rejects registration when campaign is not initialized with exit code 1', () => {
    const uninitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalcampaign-uninit-'));
    try {
      const code = handleAddTask(validTaskPath, uninitDir);
      assert.strictEqual(code, EXIT_CODES.USAGE_ERROR);
    } finally {
      fs.rmSync(uninitDir, { recursive: true, force: true });
    }
  });
});
