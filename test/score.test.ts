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
import { handleScore } from '../src/cli/commands/score';
import { computeCampaignScores, formatDeterministicScores } from '../src/core/scoring/scorer';
import { acquireCampaignLock, releaseCampaignLock } from '../src/core/concurrency/lock';
import { persistAttemptManifest } from '../src/core/execution/manifest';
import { getCampaignSchedule } from '../src/core/scheduler/scheduler';
import { readJson } from '../src/core/storage/atomic';
import { EXIT_CODES } from '../src/core/constants';

describe('Score Aggregation & evalcampaign score Command', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalcampaign-score-test-'));
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

  test('computes accurate weighted mean and rankings across multiple models, tasks, and repetitions', async () => {
    const campConfig = {
      campaign_id: 'score_e2e_camp',
      name: 'Score E2E Campaign',
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

    // Register 2 models: model_alpha and model_beta
    for (const m of ['model_alpha', 'model_beta']) {
      const p = path.join(workDir, `${m}.json`);
      fs.writeFileSync(p, JSON.stringify({ model_id: m }));
      handleAddModel(p, workDir);
    }

    // Task 1: weight = 1.0
    // model_alpha gets 0.8, model_beta gets 0.4
    const s1 = path.join(workDir, 's1.js');
    fs.writeFileSync(s1, `
      const m = process.env.EVAL_MODEL_ID;
      const score = (m === 'model_alpha') ? 0.8 : 0.4;
      process.stdout.write(JSON.stringify({ score }));
    `);
    const t1 = path.join(workDir, 't1.json');
    fs.writeFileSync(t1, JSON.stringify({
      task_id: 'task_easy',
      command: `node "${s1}"`,
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    handleAddTask(t1, workDir);

    // Task 2: weight = 3.0
    // model_alpha gets 0.6, model_beta gets 0.8
    const s2 = path.join(workDir, 's2.js');
    fs.writeFileSync(s2, `
      const m = process.env.EVAL_MODEL_ID;
      const score = (m === 'model_alpha') ? 0.6 : 0.8;
      process.stdout.write(JSON.stringify({ score }));
    `);
    const t2 = path.join(workDir, 't2.json');
    fs.writeFileSync(t2, JSON.stringify({
      task_id: 'task_hard',
      command: `node "${s2}"`,
      timeout_seconds: 5,
      weight: 3.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    handleAddTask(t2, workDir);

    // Execute run (2 models x 2 tasks x 2 repetitions = 8 logical runs)
    const runCode = await handleRun(workDir);
    assert.strictEqual(runCode, EXIT_CODES.SUCCESS);

    // Expected Scores:
    // Total weight = 1.0 + 3.0 = 4.0
    // model_alpha: (1.0 * 0.8 + 3.0 * 0.6) / 4.0 = (0.8 + 1.8) / 4.0 = 2.6 / 4.0 = 0.65
    // model_beta:  (1.0 * 0.4 + 3.0 * 0.8) / 4.0 = (0.4 + 2.4) / 4.0 = 2.8 / 4.0 = 0.70
    // Rankings:
    // Rank 1: model_beta (score 0.7)
    // Rank 2: model_alpha (score 0.65)

    const report = computeCampaignScores(workDir);
    assert.strictEqual(report.campaign_id, 'score_e2e_camp');
    assert.strictEqual(report.aggregation, 'weighted_mean');
    assert.strictEqual(report.missing_policy, 'zero');
    assert.strictEqual(report.total_completed_runs, 8);
    assert.strictEqual(report.total_logical_runs, 8);

    assert.strictEqual(report.models.model_beta.score, 0.7);
    assert.strictEqual(report.models.model_beta.rank, 1);
    assert.strictEqual(report.models.model_alpha.score, 0.65);
    assert.strictEqual(report.models.model_alpha.rank, 2);

    assert.strictEqual(report.rankings[0].model_id, 'model_beta');
    assert.strictEqual(report.rankings[0].score, 0.7);
    assert.strictEqual(report.rankings[0].rank, 1);

    assert.strictEqual(report.rankings[1].model_id, 'model_alpha');
    assert.strictEqual(report.rankings[1].score, 0.65);
    assert.strictEqual(report.rankings[1].rank, 2);

    // Test CLI invocation
    const cliCode = handleScore(workDir);
    assert.strictEqual(cliCode, EXIT_CODES.SUCCESS);
  });

  test('properly handles legitimate 0.0 scores without treating them as failure or incomplete', async () => {
    const campConfig = {
      campaign_id: 'zero_score_camp',
      name: 'Zero Score Campaign',
      repetitions: 1,
      budget: { max_wall_time_seconds: 60, max_total_attempts: 10, max_output_bytes: 4096 },
      scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));
    handleInit(campPath, workDir);

    const mPath = path.join(workDir, 'm.json');
    fs.writeFileSync(mPath, JSON.stringify({ model_id: 'model_zero' }));
    handleAddModel(mPath, workDir);

    // Task 1: score = 0.0
    const s1 = path.join(workDir, 's1.js');
    fs.writeFileSync(s1, 'process.stdout.write(JSON.stringify({ score: 0.0 }));');
    const t1 = path.join(workDir, 't1.json');
    fs.writeFileSync(t1, JSON.stringify({
      task_id: 'task_zero',
      command: `node "${s1}"`,
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    handleAddTask(t1, workDir);

    // Task 2: score = 1.0
    const s2 = path.join(workDir, 's2.js');
    fs.writeFileSync(s2, 'process.stdout.write(JSON.stringify({ score: 1.0 }));');
    const t2 = path.join(workDir, 't2.json');
    fs.writeFileSync(t2, JSON.stringify({
      task_id: 'task_one',
      command: `node "${s2}"`,
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    handleAddTask(t2, workDir);

    const runCode = await handleRun(workDir);
    assert.strictEqual(runCode, EXIT_CODES.SUCCESS);

    const report = computeCampaignScores(workDir);
    // Task 1: 0.0, Task 2: 1.0 -> Mean: 0.5
    assert.strictEqual(report.models.model_zero.task_scores.task_zero, 0.0);
    assert.strictEqual(report.models.model_zero.task_scores.task_one, 1.0);
    assert.strictEqual(report.models.model_zero.score, 0.5);
    assert.strictEqual(report.models.model_zero.rank, 1);

    const cliCode = handleScore(workDir);
    assert.strictEqual(cliCode, EXIT_CODES.SUCCESS);
  });

  test('incomplete campaign guard: rejects scoring with exit code 4 when runs are unfinished', () => {
    const campConfig = {
      campaign_id: 'incomplete_camp',
      name: 'Incomplete Campaign',
      repetitions: 1,
      budget: { max_wall_time_seconds: 60, max_total_attempts: 10, max_output_bytes: 4096 },
      scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));
    handleInit(campPath, workDir);

    const mPath = path.join(workDir, 'm.json');
    fs.writeFileSync(mPath, JSON.stringify({ model_id: 'm1' }));
    handleAddModel(mPath, workDir);

    const tPath = path.join(workDir, 't.json');
    fs.writeFileSync(tPath, JSON.stringify({
      task_id: 't1',
      command: 'echo 1',
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    handleAddTask(tPath, workDir);

    // Runs have not been executed yet
    const exitCode = handleScore(workDir);
    assert.strictEqual(exitCode, EXIT_CODES.INVALID_STATE);
  });

  test('manifest integrity: rejects scoring with exit code 4 on malformed manifest', async () => {
    const campConfig = {
      campaign_id: 'corrupt_manifest_camp',
      name: 'Corrupt Manifest Campaign',
      repetitions: 1,
      budget: { max_wall_time_seconds: 60, max_total_attempts: 10, max_output_bytes: 4096 },
      scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));
    handleInit(campPath, workDir);

    const mPath = path.join(workDir, 'm.json');
    fs.writeFileSync(mPath, JSON.stringify({ model_id: 'm1' }));
    handleAddModel(mPath, workDir);

    const s = path.join(workDir, 's.js');
    fs.writeFileSync(s, 'process.stdout.write(JSON.stringify({ score: 0.9 }));');
    const tPath = path.join(workDir, 't.json');
    fs.writeFileSync(tPath, JSON.stringify({
      task_id: 't1',
      command: `node "${s}"`,
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    handleAddTask(tPath, workDir);

    await handleRun(workDir);

    // Corrupt the generated manifest file
    const runsDir = path.join(workDir, '.evalcampaign', 'runs');
    const files = fs.readdirSync(runsDir);
    assert.ok(files.length > 0);
    fs.writeFileSync(path.join(runsDir, files[0]), '{ malformed json: true');

    const exitCode = handleScore(workDir);
    assert.strictEqual(exitCode, EXIT_CODES.INVALID_STATE);
  });

  test('deterministic repeated scoring produces byte-for-byte identical output with canonically sorted keys', async () => {
    const campConfig = {
      campaign_id: 'determinism_camp',
      name: 'Determinism Campaign',
      repetitions: 2,
      budget: { max_wall_time_seconds: 60, max_total_attempts: 10, max_output_bytes: 4096 },
      scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));
    handleInit(campPath, workDir);

    for (const m of ['model_z', 'model_a']) {
      const p = path.join(workDir, `${m}.json`);
      fs.writeFileSync(p, JSON.stringify({ model_id: m }));
      handleAddModel(p, workDir);
    }

    const s = path.join(workDir, 's.js');
    fs.writeFileSync(s, 'process.stdout.write(JSON.stringify({ score: 0.85 }));');
    const tPath = path.join(workDir, 't.json');
    fs.writeFileSync(tPath, JSON.stringify({
      task_id: 't_det',
      command: `node "${s}"`,
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    handleAddTask(tPath, workDir);

    await handleRun(workDir);

    const report1 = computeCampaignScores(workDir);
    const json1 = formatDeterministicScores(report1);

    const report2 = computeCampaignScores(workDir);
    const json2 = formatDeterministicScores(report2);

    assert.strictEqual(json1, json2);

    // Verify key sorting
    const parsed = JSON.parse(json1);
    const keys = Object.keys(parsed);
    assert.deepStrictEqual(keys, [...keys].sort());

    const modelKeys = Object.keys(parsed.models);
    assert.deepStrictEqual(modelKeys, [...modelKeys].sort());
  });

  test('scoring succeeds after crash recovery and retried runs', async () => {
    const campConfig = {
      campaign_id: 'recovery_score_camp',
      name: 'Recovery Score Campaign',
      repetitions: 1,
      budget: { max_wall_time_seconds: 60, max_total_attempts: 10, max_output_bytes: 4096 },
      scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));
    handleInit(campPath, workDir);

    const mPath = path.join(workDir, 'm.json');
    fs.writeFileSync(mPath, JSON.stringify({ model_id: 'model_retry' }));
    handleAddModel(mPath, workDir);

    // Task that crashes on attempt 1, passes on attempt 2
    const s = path.join(workDir, 'retry_eval.js');
    fs.writeFileSync(s, `
      const att = process.env.EVAL_ATTEMPT;
      if (att === '1') {
        process.exit(1);
      } else {
        process.stdout.write(JSON.stringify({ score: 0.95 }));
      }
    `);
    const tPath = path.join(workDir, 't.json');
    fs.writeFileSync(tPath, JSON.stringify({
      task_id: 'task_retry',
      command: `node "${s}"`,
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 2, retry_on: ['evaluator_crash'] }
    }));
    handleAddTask(tPath, workDir);

    // Seed simulated crash after attempt 1
    const schedule = getCampaignSchedule(workDir, 1);
    persistAttemptManifest({
      runId: schedule[0].run_id,
      attempt: 1,
      campaignId: 'recovery_score_camp',
      campaignRev: 1,
      modelId: 'model_retry',
      taskId: 'task_retry',
      repetition: 1,
      status: 'EVALUATOR_CRASH',
      rawScore: null,
      exitCode: 1,
      executionTimeMs: 50,
      stdout: '',
      stderr: 'Crash error',
      completedAt: 1000
    }, workDir);

    // Before resume, campaign is incomplete -> score must reject with exit 4
    const preScore = handleScore(workDir);
    assert.strictEqual(preScore, EXIT_CODES.INVALID_STATE);

    // Resume campaign -> attempt 2 executes and completes with score 0.95
    const resumeExit = await handleResume(workDir);
    assert.strictEqual(resumeExit, EXIT_CODES.SUCCESS);

    // Now scoring should succeed
    const scoreExit = handleScore(workDir);
    assert.strictEqual(scoreExit, EXIT_CODES.SUCCESS);

    const report = computeCampaignScores(workDir);
    assert.strictEqual(report.models.model_retry.score, 0.95);
    assert.strictEqual(report.models.model_retry.rank, 1);
  });

  test('exits with code 3 when lock contention is encountered', () => {
    const campConfig = {
      campaign_id: 'lock_score_camp',
      name: 'Lock Score Campaign',
      repetitions: 1,
      budget: { max_wall_time_seconds: 60, max_total_attempts: 10, max_output_bytes: 1024 },
      scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));
    handleInit(campPath, workDir);

    const lock = acquireCampaignLock(workDir);
    try {
      const code = handleScore(workDir);
      assert.strictEqual(code, EXIT_CODES.LOCK_CONTENTION);
    } finally {
      releaseCampaignLock(lock);
    }
  });

  test('fails safely with exit code 1 when campaign is not initialized', () => {
    const exitCode = handleScore(workDir);
    assert.strictEqual(exitCode, EXIT_CODES.USAGE_ERROR);
  });
});
