import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';
import { handleInit } from '../src/cli/commands/init';
import { handleAddTask } from '../src/cli/commands/addTask';
import { handleAddModel } from '../src/cli/commands/addModel';
import { handleRun } from '../src/cli/commands/run';
import { handleResume } from '../src/cli/commands/resume';
import { handleStatus } from '../src/cli/commands/status';
import { runCli } from '../src/cli';
import { getCampaignStatus, formatPlaintextStatus, formatJsonStatus } from '../src/core/status/status';
import { acquireCampaignLock, releaseCampaignLock } from '../src/core/concurrency/lock';
import { EXIT_CODES } from '../src/core/constants';

describe('Campaign Status Reporting & evalcampaign status Command', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalcampaign-status-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(workDir)) {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup error
      }
    }
  });

  test('reports correct status on a fresh campaign', () => {
    const campConfig = {
      campaign_id: 'fresh_status_camp',
      name: 'Fresh Status Campaign',
      repetitions: 1,
      budget: {
        max_wall_time_seconds: 60,
        max_total_attempts: 10,
        max_output_bytes: 4096
      },
      scoring: {
        aggregation: 'weighted_mean',
        missing_policy: 'zero'
      }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));
    handleInit(campPath, workDir);

    const status = getCampaignStatus(workDir);
    assert.strictEqual(status.campaign_id, 'fresh_status_camp');
    assert.strictEqual(status.lifecycle_state, 'created');
    assert.strictEqual(status.active_revision, 1);
    assert.strictEqual(status.completed_logical_runs, 0);
    assert.strictEqual(status.remaining_logical_runs, 0);
    assert.strictEqual(status.total_logical_runs, 0);
    assert.strictEqual(status.cumulative_attempt_count, 0);
    assert.strictEqual(status.budget_consumption.attempts_consumed, 0);
    assert.strictEqual(status.budget_consumption.max_total_attempts, 10);

    // Test plaintext format
    const plain = formatPlaintextStatus(status);
    assert.ok(plain.includes('Campaign ID:            fresh_status_camp'));
    assert.ok(plain.includes('Lifecycle State:        created'));
    assert.ok(plain.includes('Completed Logical Runs: 0 / 0'));

    // Test CLI invocation
    const exitCode = handleStatus({}, workDir);
    assert.strictEqual(exitCode, EXIT_CODES.SUCCESS);
  });

  test('reports correct status on configured campaign with tasks and models', () => {
    const campConfig = {
      campaign_id: 'configured_status_camp',
      name: 'Configured Campaign',
      repetitions: 2,
      budget: {
        max_wall_time_seconds: 60,
        max_total_attempts: 20,
        max_output_bytes: 4096
      },
      scoring: {
        aggregation: 'weighted_mean',
        missing_policy: 'zero'
      }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));
    handleInit(campPath, workDir);

    // Register 2 models and 2 tasks -> 2 * 2 * 2 = 8 logical runs
    for (const m of ['model_1', 'model_2']) {
      const p = path.join(workDir, `${m}.json`);
      fs.writeFileSync(p, JSON.stringify({ model_id: m }));
      handleAddModel(p, workDir);
    }

    for (const t of ['task_a', 'task_b']) {
      const p = path.join(workDir, `${t}.json`);
      fs.writeFileSync(p, JSON.stringify({
        task_id: t,
        command: 'echo 1',
        timeout_seconds: 5,
        weight: 1.0,
        retry_policy: { max_attempts: 1, retry_on: [] }
      }));
      handleAddTask(p, workDir);
    }

    const status = getCampaignStatus(workDir);
    assert.strictEqual(status.lifecycle_state, 'created');
    assert.strictEqual(status.total_logical_runs, 8);
    assert.strictEqual(status.completed_logical_runs, 0);
    assert.strictEqual(status.remaining_logical_runs, 8);
    assert.strictEqual(status.cumulative_attempt_count, 0);

    // If state is transitioned to configured, status reflects configured
    const stateFile = path.join(workDir, '.evalcampaign', 'state.json');
    const stateData = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    stateData.lifecycle_state = 'configured';
    fs.writeFileSync(stateFile, JSON.stringify(stateData, null, 2));

    const configuredStatus = getCampaignStatus(workDir);
    assert.strictEqual(configuredStatus.lifecycle_state, 'configured');
  });

  test('reports accurate status during partial execution and after budget halt', async () => {
    const campConfig = {
      campaign_id: 'partial_status_camp',
      name: 'Partial Status Campaign',
      repetitions: 1,
      budget: {
        max_wall_time_seconds: 60,
        max_total_attempts: 1, // Stop after 1 attempt
        max_output_bytes: 4096
      },
      scoring: {
        aggregation: 'weighted_mean',
        missing_policy: 'zero'
      }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));
    handleInit(campPath, workDir);

    for (const m of ['model_a', 'model_b']) {
      const p = path.join(workDir, `${m}.json`);
      fs.writeFileSync(p, JSON.stringify({ model_id: m }));
      handleAddModel(p, workDir);
    }

    const taskScript = path.join(workDir, 'eval.js');
    fs.writeFileSync(taskScript, 'process.stdout.write(JSON.stringify({ score: 1.0 }));');
    const tPath = path.join(workDir, 't.json');
    fs.writeFileSync(tPath, JSON.stringify({
      task_id: 't_single',
      command: `node "${taskScript}"`,
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    handleAddTask(tPath, workDir);

    // Total logical runs = 2 (2 models x 1 task x 1 rep)
    // Run campaign -> budget stops after 1 attempt
    const runExit = await handleRun(workDir);
    assert.strictEqual(runExit, EXIT_CODES.BUDGET_EXCEEDED);

    const status = getCampaignStatus(workDir);
    assert.strictEqual(status.lifecycle_state, 'running');
    assert.strictEqual(status.total_logical_runs, 2);
    assert.strictEqual(status.completed_logical_runs, 1);
    assert.strictEqual(status.remaining_logical_runs, 1);
    assert.strictEqual(status.cumulative_attempt_count, 1);
    assert.strictEqual(status.budget_consumption.attempts_consumed, 1);
  });

  test('reports status accurately after resume to completion', async () => {
    const campConfig = {
      campaign_id: 'resume_status_camp',
      name: 'Resume Status Campaign',
      repetitions: 1,
      budget: {
        max_wall_time_seconds: 60,
        max_total_attempts: 1, // Stop after 1
        max_output_bytes: 4096
      },
      scoring: {
        aggregation: 'weighted_mean',
        missing_policy: 'zero'
      }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));
    handleInit(campPath, workDir);

    for (const m of ['m1', 'm2']) {
      const p = path.join(workDir, `${m}.json`);
      fs.writeFileSync(p, JSON.stringify({ model_id: m }));
      handleAddModel(p, workDir);
    }

    const taskScript = path.join(workDir, 'eval.js');
    fs.writeFileSync(taskScript, 'process.stdout.write(JSON.stringify({ score: 0.8 }));');
    const tPath = path.join(workDir, 't.json');
    fs.writeFileSync(tPath, JSON.stringify({
      task_id: 't_eval',
      command: `node "${taskScript}"`,
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    handleAddTask(tPath, workDir);

    // Initial run halts at budget = 1
    await handleRun(workDir);

    // Now raise the budget so resume can finish
    const campFile = path.join(workDir, '.evalcampaign', 'campaign.json');
    const rawCamp = JSON.parse(fs.readFileSync(campFile, 'utf8'));
    rawCamp.budget.max_total_attempts = 10;
    fs.writeFileSync(campFile, JSON.stringify(rawCamp, null, 2));

    // Resume execution
    const resumeExit = await handleResume(workDir);
    assert.strictEqual(resumeExit, EXIT_CODES.SUCCESS);

    const status = getCampaignStatus(workDir);
    assert.strictEqual(status.lifecycle_state, 'completed');
    assert.strictEqual(status.total_logical_runs, 2);
    assert.strictEqual(status.completed_logical_runs, 2);
    assert.strictEqual(status.remaining_logical_runs, 0);
    assert.strictEqual(status.cumulative_attempt_count, 2);
  });

  test('JSON status output is canonical, deterministic, and contains no wall-clock drift', () => {
    const campConfig = {
      campaign_id: 'json_status_camp',
      name: 'JSON Status Campaign',
      repetitions: 1,
      budget: {
        max_wall_time_seconds: 120,
        max_total_attempts: 50,
        max_output_bytes: 8192
      },
      scoring: {
        aggregation: 'weighted_mean',
        missing_policy: 'zero'
      }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));
    handleInit(campPath, workDir);

    const status = getCampaignStatus(workDir);
    const json1 = formatJsonStatus(status);
    const json2 = formatJsonStatus(status);

    assert.strictEqual(json1, json2);

    // Check lexicographical ordering of top-level keys
    const parsed = JSON.parse(json1);
    const keys = Object.keys(parsed);
    const sortedKeys = [...keys].sort();
    assert.deepStrictEqual(keys, sortedKeys);

    // Ensure no dynamic wall-clock properties (e.g. now, timestamp, elapsed)
    assert.strictEqual(parsed.elapsed_time, undefined);
    assert.strictEqual(parsed.current_time, undefined);
    assert.strictEqual(parsed.timestamp, undefined);
  });

  test('fails safely with exit code 1 when campaign is not initialized', () => {
    const exitCode = handleStatus({}, workDir);
    assert.strictEqual(exitCode, EXIT_CODES.USAGE_ERROR);
  });

  test('rejects unknown CLI options with exit code 1', () => {
    const campConfig = {
      campaign_id: 'opts_camp',
      name: 'Opts Campaign',
      repetitions: 1,
      budget: { max_wall_time_seconds: 60, max_total_attempts: 10, max_output_bytes: 1024 },
      scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));
    handleInit(campPath, workDir);

    const code = runCli(['node', 'evalcampaign', 'status', '--invalid-flag'], workDir);
    assert.strictEqual(code, EXIT_CODES.USAGE_ERROR);
  });

  test('exits with code 3 when lock contention is encountered', () => {
    const campConfig = {
      campaign_id: 'lock_status_camp',
      name: 'Lock Status Campaign',
      repetitions: 1,
      budget: { max_wall_time_seconds: 60, max_total_attempts: 10, max_output_bytes: 1024 },
      scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));
    handleInit(campPath, workDir);

    // Hold the campaign lock
    const lock = acquireCampaignLock(workDir);

    try {
      const code = handleStatus({}, workDir);
      assert.strictEqual(code, EXIT_CODES.LOCK_CONTENTION);
    } finally {
      releaseCampaignLock(lock);
    }
  });
});
