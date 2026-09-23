import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { handleInit } from '../src/cli/commands/init';
import { handleAddTask } from '../src/cli/commands/addTask';
import { handleAddModel } from '../src/cli/commands/addModel';
import { handleRun } from '../src/cli/commands/run';
import { handleResume } from '../src/cli/commands/resume';
import { handleRollback } from '../src/cli/commands/rollback';
import { handleStatus } from '../src/cli/commands/status';
import { handleScore } from '../src/cli/commands/score';
import { getCampaignStatus } from '../src/core/status/status';
import { computeCampaignScores } from '../src/core/scoring/scorer';
import { acquireCampaignLock, releaseCampaignLock } from '../src/core/concurrency/lock';
import { readJson } from '../src/core/storage/atomic';
import { CampaignState } from '../src/core/types';
import { EXIT_CODES } from '../src/core/constants';

describe('Campaign Rollback (evalcampaign rollback [n])', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalcampaign-rollback-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(workDir)) {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  test('reverts default n=1 completed run batch and restores campaign state', async () => {
    const campConfig = {
      campaign_id: 'rb_test_camp',
      name: 'Rollback Test Campaign',
      repetitions: 1,
      budget: { max_wall_time_seconds: 60, max_total_attempts: 10, max_output_bytes: 1024 },
      scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));
    handleInit(campPath, workDir);

    for (const m of ['m1', 'm2']) {
      const p = path.join(workDir, `${m}.json`);
      fs.writeFileSync(p, JSON.stringify({ model_id: m }));
      handleAddModel(p, workDir);
    }

    const s = path.join(workDir, 's.js');
    fs.writeFileSync(s, 'process.stdout.write(JSON.stringify({ score: 0.9 }));');
    const t = path.join(workDir, 't.json');
    fs.writeFileSync(t, JSON.stringify({
      task_id: 'task_rb',
      command: `node "${s}"`,
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    handleAddTask(t, workDir);

    // Run campaign: 2 models x 1 task x 1 rep = 2 logical runs
    const runExit = await handleRun(workDir);
    assert.strictEqual(runExit, EXIT_CODES.SUCCESS);

    let status = getCampaignStatus(workDir);
    assert.strictEqual(status.completed_logical_runs, 2);
    assert.strictEqual(status.lifecycle_state, 'completed');

    // Rollback 1 batch (default)
    const rbExit = handleRollback([], workDir);
    assert.strictEqual(rbExit, EXIT_CODES.SUCCESS);

    status = getCampaignStatus(workDir);
    assert.strictEqual(status.completed_logical_runs, 1);
    assert.strictEqual(status.remaining_logical_runs, 1);
    assert.strictEqual(status.lifecycle_state, 'running');

    // Verify state.json
    const state = readJson<CampaignState>(path.join(workDir, '.evalcampaign', 'state.json'));
    assert.strictEqual(state.lifecycle_state, 'running');
    assert.strictEqual((state as any).completed_runs, 1);

    // Verify 1 manifest remains in runs dir
    const runsDir = path.join(workDir, '.evalcampaign', 'runs');
    const remainingManifests = fs.readdirSync(runsDir).filter(f => f.endsWith('.json'));
    assert.strictEqual(remainingManifests.length, 1);
  });

  test('reverts multiple batches (n = 2) cleanly', async () => {
    const campConfig = {
      campaign_id: 'rb_multi_camp',
      name: 'Rollback Multi Campaign',
      repetitions: 2,
      budget: { max_wall_time_seconds: 60, max_total_attempts: 10, max_output_bytes: 1024 },
      scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));
    handleInit(campPath, workDir);

    for (const m of ['m1', 'm2']) {
      const p = path.join(workDir, `${m}.json`);
      fs.writeFileSync(p, JSON.stringify({ model_id: m }));
      handleAddModel(p, workDir);
    }

    const s = path.join(workDir, 's.js');
    fs.writeFileSync(s, 'process.stdout.write(JSON.stringify({ score: 0.85 }));');
    const t = path.join(workDir, 't.json');
    fs.writeFileSync(t, JSON.stringify({
      task_id: 't1',
      command: `node "${s}"`,
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    handleAddTask(t, workDir);

    // 4 logical runs completed
    await handleRun(workDir);
    assert.strictEqual(getCampaignStatus(workDir).completed_logical_runs, 4);

    // Rollback 2 batches
    const rbExit = handleRollback(['2'], workDir);
    assert.strictEqual(rbExit, EXIT_CODES.SUCCESS);

    const status = getCampaignStatus(workDir);
    assert.strictEqual(status.completed_logical_runs, 2);
    assert.strictEqual(status.remaining_logical_runs, 2);
    assert.strictEqual(status.lifecycle_state, 'running');
  });

  test('rejects rollback past initial configured revision with exit code 4', async () => {
    const campConfig = {
      campaign_id: 'rb_bound_camp',
      name: 'Rollback Boundary Campaign',
      repetitions: 1,
      budget: { max_wall_time_seconds: 60, max_total_attempts: 10, max_output_bytes: 1024 },
      scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));
    handleInit(campPath, workDir);

    const m = path.join(workDir, 'm.json');
    fs.writeFileSync(m, JSON.stringify({ model_id: 'm1' }));
    handleAddModel(m, workDir);

    const t = path.join(workDir, 't.json');
    fs.writeFileSync(t, JSON.stringify({
      task_id: 't1',
      command: 'echo 1',
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    handleAddTask(t, workDir);

    // 0 completed runs: rollback must fail with exit code 4
    const rbZero = handleRollback([], workDir);
    assert.strictEqual(rbZero, EXIT_CODES.INVALID_STATE);

    // Execute 1 run
    const s = path.join(workDir, 's.js');
    fs.writeFileSync(s, 'process.stdout.write(JSON.stringify({ score: 1.0 }));');
    const tDef = JSON.parse(fs.readFileSync(path.join(workDir, '.evalcampaign', 'tasks', 't1.json'), 'utf8'));
    tDef.command = `node "${s}"`;
    fs.writeFileSync(path.join(workDir, '.evalcampaign', 'tasks', 't1.json'), JSON.stringify(tDef, null, 2));

    await handleRun(workDir);
    assert.strictEqual(getCampaignStatus(workDir).completed_logical_runs, 1);

    // Attempting to rollback 2 batches when only 1 exists: must fail with exit code 4
    const rbTooMany = handleRollback(['2'], workDir);
    assert.strictEqual(rbTooMany, EXIT_CODES.INVALID_STATE);
  });

  test('rejects invalid rollback arguments with exit code 1', () => {
    const campConfig = {
      campaign_id: 'rb_invalid_camp',
      name: 'Rollback Invalid Campaign',
      repetitions: 1,
      budget: { max_wall_time_seconds: 60, max_total_attempts: 10, max_output_bytes: 1024 },
      scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));
    handleInit(campPath, workDir);

    assert.strictEqual(handleRollback(['-1'], workDir), EXIT_CODES.USAGE_ERROR);
    assert.strictEqual(handleRollback(['0'], workDir), EXIT_CODES.USAGE_ERROR);
    assert.strictEqual(handleRollback(['abc'], workDir), EXIT_CODES.USAGE_ERROR);
    assert.strictEqual(handleRollback(['1.5'], workDir), EXIT_CODES.USAGE_ERROR);
  });

  test('full cycle: run -> rollback -> resume -> score works consistently', async () => {
    const campConfig = {
      campaign_id: 'rb_cycle_camp',
      name: 'Rollback Cycle Campaign',
      repetitions: 1,
      budget: { max_wall_time_seconds: 60, max_total_attempts: 10, max_output_bytes: 1024 },
      scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));
    handleInit(campPath, workDir);

    for (const m of ['m1', 'm2']) {
      const p = path.join(workDir, `${m}.json`);
      fs.writeFileSync(p, JSON.stringify({ model_id: m }));
      handleAddModel(p, workDir);
    }

    const s = path.join(workDir, 's.js');
    fs.writeFileSync(s, 'process.stdout.write(JSON.stringify({ score: 0.9 }));');
    const t = path.join(workDir, 't.json');
    fs.writeFileSync(t, JSON.stringify({
      task_id: 't_cycle',
      command: `node "${s}"`,
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    handleAddTask(t, workDir);

    // 1. Initial complete run
    await handleRun(workDir);
    assert.strictEqual(getCampaignStatus(workDir).completed_logical_runs, 2);

    // 2. Score succeeds
    assert.strictEqual(handleScore(workDir), EXIT_CODES.SUCCESS);

    // 3. Rollback 1 run
    assert.strictEqual(handleRollback(['1'], workDir), EXIT_CODES.SUCCESS);
    assert.strictEqual(getCampaignStatus(workDir).completed_logical_runs, 1);

    // 4. Score is guarded (exit code 4 because campaign is now incomplete)
    assert.strictEqual(handleScore(workDir), EXIT_CODES.INVALID_STATE);

    // 5. Resume re-executes the rolled-back run
    const resExit = await handleResume(workDir);
    assert.strictEqual(resExit, EXIT_CODES.SUCCESS);

    // 6. Both runs complete again
    assert.strictEqual(getCampaignStatus(workDir).completed_logical_runs, 2);
    assert.strictEqual(getCampaignStatus(workDir).lifecycle_state, 'completed');

    // 7. Score succeeds again
    assert.strictEqual(handleScore(workDir), EXIT_CODES.SUCCESS);
    const scoreReport = computeCampaignScores(workDir);
    assert.strictEqual(scoreReport.models.m1.score, 0.9);
    assert.strictEqual(scoreReport.models.m2.score, 0.9);
  });

  test('rollback respects advisory lock contention (exit code 3)', () => {
    const campConfig = {
      campaign_id: 'rb_lock_camp',
      name: 'Rollback Lock Campaign',
      repetitions: 1,
      budget: { max_wall_time_seconds: 60, max_total_attempts: 10, max_output_bytes: 1024 },
      scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));
    handleInit(campPath, workDir);

    const lock = acquireCampaignLock(workDir);
    try {
      const code = handleRollback([], workDir);
      assert.strictEqual(code, EXIT_CODES.LOCK_CONTENTION);
    } finally {
      releaseCampaignLock(lock);
    }
  });
});
