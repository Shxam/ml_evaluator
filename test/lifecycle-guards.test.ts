import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { handleInit } from '../src/cli/commands/init';
import { handleAddTask } from '../src/cli/commands/addTask';
import { handleAddModel } from '../src/cli/commands/addModel';
import { EXIT_CODES, LIFECYCLE_STATES, LifecycleState } from '../src/core/constants';
import { readJson, atomicWriteJson } from '../src/core/storage/atomic';
import { CampaignState } from '../src/core/types';

describe('Lifecycle Guards for Task & Model Registration', () => {
  let workDir: string;
  let taskPath: string;
  let modelPath: string;

  const validCampaign = {
    campaign_id: 'guard_test_camp',
    name: 'Guard Verification Campaign',
    budget: { max_wall_time_seconds: 60, max_total_attempts: 10, max_output_bytes: 2048 },
    scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
  };

  const sampleTask = {
    task_id: 'guard_task',
    command: 'echo "test"',
    timeout_seconds: 5,
    weight: 1.0,
    retry_policy: { max_attempts: 1, retry_on: ['timeout'] }
  };

  const sampleModel = {
    model_id: 'guard_model',
    name: 'Guard Candidate'
  };

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalcampaign-guard-test-'));
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(validCampaign, null, 2));
    handleInit(campPath, workDir);

    taskPath = path.join(workDir, 'task.json');
    fs.writeFileSync(taskPath, JSON.stringify(sampleTask, null, 2));

    modelPath = path.join(workDir, 'model.json');
    fs.writeFileSync(modelPath, JSON.stringify(sampleModel, null, 2));
  });

  afterEach(() => {
    if (fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  function setLifecycleState(targetState: LifecycleState) {
    const stateFile = path.join(workDir, '.evalcampaign', 'state.json');
    const state = readJson<CampaignState>(stateFile);
    state.lifecycle_state = targetState;
    atomicWriteJson(stateFile, state);
  }

  test('created state allows add-task and add-model (exit 0)', () => {
    setLifecycleState(LIFECYCLE_STATES.CREATED);
    assert.strictEqual(handleAddTask(taskPath, workDir), EXIT_CODES.SUCCESS);
    assert.strictEqual(handleAddModel(modelPath, workDir), EXIT_CODES.SUCCESS);
  });

  test('running state forbids add-task and add-model with exit code 4', () => {
    setLifecycleState(LIFECYCLE_STATES.RUNNING);
    assert.strictEqual(handleAddTask(taskPath, workDir), EXIT_CODES.INVALID_STATE);
    assert.strictEqual(handleAddModel(modelPath, workDir), EXIT_CODES.INVALID_STATE);
  });

  test('paused state forbids add-task and add-model with exit code 4', () => {
    setLifecycleState(LIFECYCLE_STATES.PAUSED);
    assert.strictEqual(handleAddTask(taskPath, workDir), EXIT_CODES.INVALID_STATE);
    assert.strictEqual(handleAddModel(modelPath, workDir), EXIT_CODES.INVALID_STATE);
  });

  test('completed state forbids add-task and add-model with exit code 4', () => {
    setLifecycleState(LIFECYCLE_STATES.COMPLETED);
    assert.strictEqual(handleAddTask(taskPath, workDir), EXIT_CODES.INVALID_STATE);
    assert.strictEqual(handleAddModel(modelPath, workDir), EXIT_CODES.INVALID_STATE);
  });

  test('failed state forbids add-task and add-model with exit code 4', () => {
    setLifecycleState(LIFECYCLE_STATES.FAILED);
    assert.strictEqual(handleAddTask(taskPath, workDir), EXIT_CODES.INVALID_STATE);
    assert.strictEqual(handleAddModel(modelPath, workDir), EXIT_CODES.INVALID_STATE);
  });

  test('configured state forbids add-task and add-model with exit code 4', () => {
    setLifecycleState(LIFECYCLE_STATES.CONFIGURED);
    assert.strictEqual(handleAddTask(taskPath, workDir), EXIT_CODES.INVALID_STATE);
    assert.strictEqual(handleAddModel(modelPath, workDir), EXIT_CODES.INVALID_STATE);
  });
});
