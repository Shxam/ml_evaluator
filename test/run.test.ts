import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { handleInit } from '../src/cli/commands/init';
import { handleAddTask } from '../src/cli/commands/addTask';
import { handleAddModel } from '../src/cli/commands/addModel';
import { handleRun } from '../src/cli/commands/run';
import { runCampaign } from '../src/core/execution/runner';
import { EXIT_CODES } from '../src/core/constants';
import { readJson } from '../src/core/storage/atomic';
import { CampaignState } from '../src/core/types';
import { AttemptManifest } from '../src/core/execution/types';

describe('Campaign Execution Runner & evalcampaign run Command', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalcampaign-run-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('executes clean end-to-end campaign with multiple tasks, models, scores, and 0.0 scores', async () => {
    const campConfig = {
      campaign_id: 'e2e_campaign',
      name: 'End to End Campaign',
      budget: { max_wall_time_seconds: 60, max_total_attempts: 20, max_output_bytes: 4096 },
      scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));
    assert.strictEqual(handleInit(campPath, workDir), EXIT_CODES.SUCCESS);

    // Register 2 models
    const m1Path = path.join(workDir, 'm1.json');
    fs.writeFileSync(m1Path, JSON.stringify({ model_id: 'model_alpha', name: 'Model Alpha' }));
    assert.strictEqual(handleAddModel(m1Path, workDir), EXIT_CODES.SUCCESS);

    const m2Path = path.join(workDir, 'm2.json');
    fs.writeFileSync(m2Path, JSON.stringify({ model_id: 'model_beta', name: 'Model Beta' }));
    assert.strictEqual(handleAddModel(m2Path, workDir), EXIT_CODES.SUCCESS);

    // Task 1: Returns positive score 0.85
    const script1Path = path.join(workDir, 'eval_pos.js');
    fs.writeFileSync(script1Path, `process.stdout.write(JSON.stringify({ score: 0.85 }));`);

    const t1Path = path.join(workDir, 't1.json');
    fs.writeFileSync(
      t1Path,
      JSON.stringify({
        task_id: 'task_positive',
        command: `node "${script1Path}"`,
        timeout_seconds: 5,
        weight: 1.0,
        retry_policy: { max_attempts: 1, retry_on: [] }
      })
    );
    assert.strictEqual(handleAddTask(t1Path, workDir), EXIT_CODES.SUCCESS);

    // Task 2: Returns valid 0.0 score (must be COMPLETED, not failure)
    const script2Path = path.join(workDir, 'eval_zero.js');
    fs.writeFileSync(script2Path, `process.stdout.write(JSON.stringify({ score: 0.0 }));`);

    const t2Path = path.join(workDir, 't2.json');
    fs.writeFileSync(
      t2Path,
      JSON.stringify({
        task_id: 'task_zero',
        command: `node "${script2Path}"`,
        timeout_seconds: 5,
        weight: 1.0,
        retry_policy: { max_attempts: 1, retry_on: [] }
      })
    );
    assert.strictEqual(handleAddTask(t2Path, workDir), EXIT_CODES.SUCCESS);

    // Run the campaign
    const code = await handleRun(workDir);
    assert.strictEqual(code, EXIT_CODES.SUCCESS);

    // Verify state.json
    const statePath = path.join(workDir, '.evalcampaign', 'state.json');
    const state = readJson<CampaignState>(statePath);
    assert.strictEqual(state.lifecycle_state, 'completed');
    assert.strictEqual((state as any).completed_runs, 4); // 2 models x 2 tasks x 1 rep

    // Verify manifests exist in runs/
    const runsDir = path.join(workDir, '.evalcampaign', 'runs');
    const manifestFiles = fs.readdirSync(runsDir).filter(f => f.endsWith('.json'));
    assert.strictEqual(manifestFiles.length, 4);

    for (const file of manifestFiles) {
      const manifest = readJson<AttemptManifest>(path.join(runsDir, file));
      assert.strictEqual(manifest.status, 'COMPLETED');
      assert.strictEqual(manifest.attempt, 1);
      assert.ok(manifest.raw_score === 0.85 || manifest.raw_score === 0.0);
    }
  });

  test('handles task retry on failure and increments attempt counter across retries', async () => {
    const campConfig = {
      campaign_id: 'retry_campaign',
      name: 'Retry Campaign',
      budget: { max_wall_time_seconds: 60, max_total_attempts: 10, max_output_bytes: 4096 },
      scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));
    handleInit(campPath, workDir);

    const mPath = path.join(workDir, 'm.json');
    fs.writeFileSync(mPath, JSON.stringify({ model_id: 'model_1' }));
    handleAddModel(mPath, workDir);

    // Task that fails on attempt 1 (exit 1), but succeeds on attempt 2
    const retryScriptPath = path.join(workDir, 'retry_eval.js');
    fs.writeFileSync(
      retryScriptPath,
      `const att = process.env.EVAL_ATTEMPT; if (att === '1') { process.exit(1); } else { process.stdout.write(JSON.stringify({ score: 1.0 })); }`
    );

    const tPath = path.join(workDir, 't.json');
    fs.writeFileSync(
      tPath,
      JSON.stringify({
        task_id: 'task_retry',
        command: `node "${retryScriptPath}"`,
        timeout_seconds: 5,
        weight: 1.0,
        retry_policy: { max_attempts: 2, retry_on: ['evaluator_crash'] }
      })
    );
    handleAddTask(tPath, workDir);

    const result = await runCampaign(workDir);
    assert.strictEqual(result.exitCode, EXIT_CODES.SUCCESS);
    assert.strictEqual(result.totalAttempts, 2);
    assert.strictEqual(result.completedRuns, 1);

    const runsDir = path.join(workDir, '.evalcampaign', 'runs');
    const files = fs.readdirSync(runsDir).filter(f => f.endsWith('.json')).sort();
    assert.strictEqual(files.length, 2);

    const att1 = readJson<AttemptManifest>(path.join(runsDir, files[0]));
    const att2 = readJson<AttemptManifest>(path.join(runsDir, files[1]));

    assert.strictEqual(att1.run_id, att2.run_id);
    assert.strictEqual(att1.attempt, 1);
    assert.strictEqual(att1.status, 'EVALUATOR_CRASH');
    assert.strictEqual(att2.attempt, 2);
    assert.strictEqual(att2.status, 'COMPLETED');
    assert.strictEqual(att2.raw_score, 1.0);
  });

  test('halts with exit code 6 when global attempt budget is exhausted', async () => {
    const campConfig = {
      campaign_id: 'budget_campaign',
      name: 'Budget Campaign',
      budget: { max_wall_time_seconds: 60, max_total_attempts: 2, max_output_bytes: 4096 },
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

    const scriptPath = path.join(workDir, 'eval_success.js');
    fs.writeFileSync(scriptPath, `process.stdout.write(JSON.stringify({ score: 1.0 }));`);

    for (const t of ['t1', 't2']) {
      const p = path.join(workDir, `${t}.json`);
      fs.writeFileSync(
        p,
        JSON.stringify({
          task_id: t,
          command: `node "${scriptPath}"`,
          timeout_seconds: 5,
          weight: 1.0,
          retry_policy: { max_attempts: 1, retry_on: [] }
        })
      );
      handleAddTask(p, workDir);
    }

    const res = await runCampaign(workDir);
    assert.strictEqual(res.exitCode, EXIT_CODES.BUDGET_EXCEEDED);
    assert.strictEqual(res.totalAttempts, 2);

    const state = readJson<CampaignState>(path.join(workDir, '.evalcampaign', 'state.json'));
    assert.strictEqual((state as any).total_attempts, 2);
  });

  test('halts with exit code 6 when global wall-clock budget is exceeded', async () => {
    const campConfig = {
      campaign_id: 'walltime_campaign',
      name: 'Wall Time Campaign',
      budget: { max_wall_time_seconds: 1, max_total_attempts: 100, max_output_bytes: 4096 },
      scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));
    handleInit(campPath, workDir);

    const mPath = path.join(workDir, 'm.json');
    fs.writeFileSync(mPath, JSON.stringify({ model_id: 'm1' }));
    handleAddModel(mPath, workDir);

    // Task 1 (ordered first alphabetically) sleeps for 1200ms (exceeding 1s global budget)
    const script1Path = path.join(workDir, 'slow_eval.js');
    fs.writeFileSync(script1Path, `setTimeout(() => { process.stdout.write(JSON.stringify({ score: 1.0 })); }, 1200);`);

    const t1Path = path.join(workDir, 't1.json');
    fs.writeFileSync(
      t1Path,
      JSON.stringify({
        task_id: 'task_1_slow',
        command: `node "${script1Path}"`,
        timeout_seconds: 5,
        weight: 1.0,
        retry_policy: { max_attempts: 1, retry_on: [] }
      })
    );
    handleAddTask(t1Path, workDir);

    // Task 2 (ordered second) would execute next, but should be prevented by wall-time limit
    const script2Path = path.join(workDir, 'next_eval.js');
    fs.writeFileSync(script2Path, `process.stdout.write(JSON.stringify({ score: 1.0 }));`);

    const t2Path = path.join(workDir, 't2.json');
    fs.writeFileSync(
      t2Path,
      JSON.stringify({
        task_id: 'task_2_next',
        command: `node "${script2Path}"`,
        timeout_seconds: 5,
        weight: 1.0,
        retry_policy: { max_attempts: 1, retry_on: [] }
      })
    );
    handleAddTask(t2Path, workDir);

    const res = await runCampaign(workDir);
    assert.strictEqual(res.exitCode, EXIT_CODES.BUDGET_EXCEEDED);
    assert.strictEqual(res.totalAttempts, 1);
  });

  test('detects provenance drift before retry and halts with exit code 5 without dispatching retry', async () => {
    const campConfig = {
      campaign_id: 'drift_retry_campaign',
      name: 'Drift Retry Campaign',
      budget: { max_wall_time_seconds: 60, max_total_attempts: 10, max_output_bytes: 4096 },
      scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));
    handleInit(campPath, workDir);

    const mPath = path.join(workDir, 'm.json');
    fs.writeFileSync(mPath, JSON.stringify({ model_id: 'm1' }));
    handleAddModel(mPath, workDir);

    // Task that tampers with its own definition on disk during attempt 1
    const registeredTaskPath = path.join(workDir, '.evalcampaign', 'tasks', 'task_tamper.json').replace(/\\/g, '/');
    const tamperScriptPath = path.join(workDir, 'tamper.js');
    fs.writeFileSync(
      tamperScriptPath,
      `const fs = require('fs'); fs.appendFileSync('${registeredTaskPath}', '/*tamper*/'); process.exit(1);`
    );

    const tPath = path.join(workDir, 't.json');
    fs.writeFileSync(
      tPath,
      JSON.stringify({
        task_id: 'task_tamper',
        command: `node "${tamperScriptPath}"`,
        timeout_seconds: 5,
        weight: 1.0,
        retry_policy: { max_attempts: 3, retry_on: ['evaluator_crash'] }
      })
    );
    handleAddTask(tPath, workDir);

    const res = await runCampaign(workDir);
    assert.strictEqual(res.exitCode, EXIT_CODES.PROVENANCE_DRIFT);
    assert.strictEqual(res.totalAttempts, 1); // Attempt 2 was NEVER dispatched
  });

  test('rejects execution with exit code 4 when campaign is already completed', async () => {
    const campConfig = {
      campaign_id: 'completed_campaign',
      name: 'Completed Campaign',
      budget: { max_wall_time_seconds: 60, max_total_attempts: 10, max_output_bytes: 4096 },
      scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));
    handleInit(campPath, workDir);

    const mPath = path.join(workDir, 'm.json');
    fs.writeFileSync(mPath, JSON.stringify({ model_id: 'm1' }));
    handleAddModel(mPath, workDir);

    const scriptPath = path.join(workDir, 'eval_success.js');
    fs.writeFileSync(scriptPath, `process.stdout.write(JSON.stringify({ score: 1.0 }));`);

    const tPath = path.join(workDir, 't.json');
    fs.writeFileSync(
      tPath,
      JSON.stringify({
        task_id: 't1',
        command: `node "${scriptPath}"`,
        timeout_seconds: 5,
        weight: 1.0,
        retry_policy: { max_attempts: 1, retry_on: [] }
      })
    );
    handleAddTask(tPath, workDir);

    // First run -> completes
    const code1 = await handleRun(workDir);
    assert.strictEqual(code1, EXIT_CODES.SUCCESS);

    // Second run -> forbidden by lifecycle guard
    const code2 = await handleRun(workDir);
    assert.strictEqual(code2, EXIT_CODES.INVALID_STATE);
  });
});
