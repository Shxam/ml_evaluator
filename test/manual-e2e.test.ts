import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync } from 'child_process';
import { handleInit } from '../src/cli/commands/init';
import { handleAddTask } from '../src/cli/commands/addTask';
import { handleAddModel } from '../src/cli/commands/addModel';
import { handleRun } from '../src/cli/commands/run';
import { EXIT_CODES } from '../src/core/constants';
import { readJson } from '../src/core/storage/atomic';
import { CampaignState } from '../src/core/types';
import { AttemptManifest } from '../src/core/execution/types';

describe('Manual Verification: Comprehensive Stage 4 Scenario', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalcampaign-manual-e2e-'));
  });

  afterEach(() => {
    if (fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('performs end-to-end multi-model, multi-task, repetition >= 2 campaign with all outcome types', async () => {
    const campConfig = {
      campaign_id: 'manual_verification_camp',
      name: 'Comprehensive Stage 4 Manual Verification',
      repetitions: 2,
      budget: {
        max_wall_time_seconds: 120,
        max_total_attempts: 50,
        max_output_bytes: 500
      },
      scoring: {
        aggregation: 'weighted_mean',
        missing_policy: 'zero'
      }
    };

    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));
    assert.strictEqual(handleInit(campPath, workDir), EXIT_CODES.SUCCESS);

    // 1. Models: at least 2 models
    for (const mId of ['model_claude', 'model_gpt']) {
      const mPath = path.join(workDir, `${mId}.json`);
      fs.writeFileSync(mPath, JSON.stringify({ model_id: mId, name: `Model ${mId}` }));
      assert.strictEqual(handleAddModel(mPath, workDir), EXIT_CODES.SUCCESS);
    }

    // 2. Tasks:
    // Task A: Successful task (positive score 0.95)
    const scriptSuccess = path.join(workDir, 'task_success.js');
    fs.writeFileSync(
      scriptSuccess,
      `process.stdout.write(JSON.stringify({ score: 0.95 }));`
    );
    const tSuccessPath = path.join(workDir, 'task_success.json');
    fs.writeFileSync(
      tSuccessPath,
      JSON.stringify({
        task_id: 'task_success',
        command: `node "${scriptSuccess}"`,
        timeout_seconds: 15,
        weight: 1.0,
        retry_policy: { max_attempts: 1, retry_on: [] }
      })
    );
    assert.strictEqual(handleAddTask(tSuccessPath, workDir), EXIT_CODES.SUCCESS);

    // Task B: Returns valid 0.0 score (COMPLETED, no retry)
    const scriptZero = path.join(workDir, 'task_zero.js');
    fs.writeFileSync(
      scriptZero,
      `process.stdout.write(JSON.stringify({ score: 0.0 }));`
    );
    const tZeroPath = path.join(workDir, 'task_zero.json');
    fs.writeFileSync(
      tZeroPath,
      JSON.stringify({
        task_id: 'task_zero',
        command: `node "${scriptZero}"`,
        timeout_seconds: 15,
        weight: 1.0,
        retry_policy: { max_attempts: 2, retry_on: ['evaluator_crash'] }
      })
    );
    assert.strictEqual(handleAddTask(tZeroPath, workDir), EXIT_CODES.SUCCESS);

    // Task C: Retryable failure (crashes on attempt 1, succeeds on attempt 2)
    const scriptRetry = path.join(workDir, 'task_retry.js');
    fs.writeFileSync(
      scriptRetry,
      `const att = process.env.EVAL_ATTEMPT; if (att === '1') { process.exit(1); } else { process.stdout.write(JSON.stringify({ score: 0.8 })); }`
    );
    const tRetryPath = path.join(workDir, 'task_retry.json');
    fs.writeFileSync(
      tRetryPath,
      JSON.stringify({
        task_id: 'task_retry',
        command: `node "${scriptRetry}"`,
        timeout_seconds: 15,
        weight: 1.0,
        retry_policy: { max_attempts: 2, retry_on: ['evaluator_crash'] }
      })
    );
    assert.strictEqual(handleAddTask(tRetryPath, workDir), EXIT_CODES.SUCCESS);

    // Task D: Malformed output case
    const scriptMalformed = path.join(workDir, 'task_malformed.js');
    fs.writeFileSync(
      scriptMalformed,
      `process.stdout.write('INVALID_NON_JSON_SYNTAX');`
    );
    const tMalformedPath = path.join(workDir, 'task_malformed.json');
    fs.writeFileSync(
      tMalformedPath,
      JSON.stringify({
        task_id: 'task_malformed',
        command: `node "${scriptMalformed}"`,
        timeout_seconds: 15,
        weight: 1.0,
        retry_policy: { max_attempts: 1, retry_on: [] }
      })
    );
    assert.strictEqual(handleAddTask(tMalformedPath, workDir), EXIT_CODES.SUCCESS);

    // Task E: Output overflow case (exceeds max_output_bytes: 500)
    const scriptOverflow = path.join(workDir, 'task_overflow.js');
    fs.writeFileSync(
      scriptOverflow,
      `process.stdout.write('X'.repeat(2000));`
    );
    const tOverflowPath = path.join(workDir, 'task_overflow.json');
    fs.writeFileSync(
      tOverflowPath,
      JSON.stringify({
        task_id: 'task_overflow',
        command: `node "${scriptOverflow}"`,
        timeout_seconds: 15,
        weight: 1.0,
        retry_policy: { max_attempts: 1, retry_on: [] }
      })
    );
    assert.strictEqual(handleAddTask(tOverflowPath, workDir), EXIT_CODES.SUCCESS);

    // Execute the campaign via CLI handleRun
    const exitCode = await handleRun(workDir);
    assert.strictEqual(exitCode, EXIT_CODES.SUCCESS);

    // Verify State
    const state = readJson<CampaignState>(path.join(workDir, '.evalcampaign', 'state.json'));
    assert.strictEqual(state.lifecycle_state, 'completed');

    // Total scheduled runs = 2 models * 5 tasks * 2 repetitions = 20 logical runs
    assert.strictEqual((state as any).completed_runs, 20);
    // Task C had 1 retry per repetition (2 models * 1 task * 2 reps = 4 retries)
    // Total attempts = 20 + 4 = 24 attempts
    assert.strictEqual((state as any).total_attempts, 24);

    // Inspect Manifests
    const runsDir = path.join(workDir, '.evalcampaign', 'runs');
    const manifestFiles = fs.readdirSync(runsDir).filter(f => f.endsWith('.json'));
    assert.strictEqual(manifestFiles.length, 24);

    let foundSuccess = 0;
    let foundZero = 0;
    let foundCrash = 0;
    let foundMalformed = 0;
    let foundOverflow = 0;

    for (const f of manifestFiles) {
      const m = readJson<AttemptManifest>(path.join(runsDir, f));
      if (m.task_id === 'task_success') {
        assert.strictEqual(m.status, 'COMPLETED');
        assert.strictEqual(m.raw_score, 0.95);
        foundSuccess++;
      } else if (m.task_id === 'task_zero') {
        assert.strictEqual(m.status, 'COMPLETED');
        assert.strictEqual(m.raw_score, 0.0);
        foundZero++;
      } else if (m.task_id === 'task_retry') {
        if (m.attempt === 1) {
          assert.strictEqual(m.status, 'EVALUATOR_CRASH');
          foundCrash++;
        } else if (m.attempt === 2) {
          assert.strictEqual(m.status, 'COMPLETED');
          assert.strictEqual(m.raw_score, 0.8);
        }
      } else if (m.task_id === 'task_malformed') {
        assert.strictEqual(m.status, 'MALFORMED_OUTPUT');
        foundMalformed++;
      } else if (m.task_id === 'task_overflow') {
        assert.strictEqual(m.status, 'OUTPUT_OVERFLOW');
        assert.ok(m.stdout.length <= 500);
        foundOverflow++;
      }
    }

    assert.strictEqual(foundSuccess, 4); // 2 models * 2 reps
    assert.strictEqual(foundZero, 4);    // 2 models * 2 reps (never retried despite 0.0)
    assert.strictEqual(foundCrash, 4);   // 2 models * 2 reps attempt 1 crashes
    assert.strictEqual(foundMalformed, 4); // 2 models * 2 reps
    assert.strictEqual(foundOverflow, 4);  // 2 models * 2 reps
  });

  test('Stage 6 Manual CLI Scenario: multi-model, multi-task, 0.0 score, status, status --json, and deterministic score', async () => {
    const cliBin = path.resolve(process.cwd(), 'dist/src/bin/evalcampaign.js');

    // 1. Create a campaign
    const campConfig = {
      campaign_id: 'stage6_cli_verification',
      name: 'Stage 6 CLI Manual Verification',
      repetitions: 1,
      budget: {
        max_wall_time_seconds: 120,
        max_total_attempts: 50,
        max_output_bytes: 4096
      },
      scoring: {
        aggregation: 'weighted_mean',
        missing_policy: 'zero'
      }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));

    const initRes = spawnSync(process.execPath, [cliBin, 'init', campPath], { cwd: workDir, encoding: 'utf8' });
    assert.strictEqual(initRes.status, 0);

    // 2. Register at least two models and multiple tasks
    for (const mId of ['model_alpha', 'model_beta']) {
      const mPath = path.join(workDir, `${mId}.json`);
      fs.writeFileSync(mPath, JSON.stringify({ model_id: mId }));
      const mRes = spawnSync(process.execPath, [cliBin, 'add-model', mPath], { cwd: workDir, encoding: 'utf8' });
      assert.strictEqual(mRes.status, 0);
    }

    // Task 1: score = 0.0 (legitimate zero score)
    const sZero = path.join(workDir, 'task_zero.js');
    fs.writeFileSync(sZero, `process.stdout.write(JSON.stringify({ score: 0.0 }));`);
    const tZero = path.join(workDir, 't_zero.json');
    fs.writeFileSync(tZero, JSON.stringify({
      task_id: 'task_zero',
      command: `node "${sZero}"`,
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    const tZeroRes = spawnSync(process.execPath, [cliBin, 'add-task', tZero], { cwd: workDir, encoding: 'utf8' });
    assert.strictEqual(tZeroRes.status, 0);

    // Task 2: positive score (model_alpha: 0.8, model_beta: 0.6)
    const sPos = path.join(workDir, 'task_pos.js');
    fs.writeFileSync(sPos, `
      const m = process.env.EVAL_MODEL_ID;
      const score = (m === 'model_alpha') ? 0.8 : 0.6;
      process.stdout.write(JSON.stringify({ score }));
    `);
    const tPos = path.join(workDir, 't_pos.json');
    fs.writeFileSync(tPos, JSON.stringify({
      task_id: 'task_pos',
      command: `node "${sPos}"`,
      timeout_seconds: 5,
      weight: 3.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    const tPosRes = spawnSync(process.execPath, [cliBin, 'add-task', tPos], { cwd: workDir, encoding: 'utf8' });
    assert.strictEqual(tPosRes.status, 0);

    // 3. Complete runs
    const runRes = spawnSync(process.execPath, [cliBin, 'run'], { cwd: workDir, encoding: 'utf8' });
    assert.strictEqual(runRes.status, 0);

    // 4. Run status (plaintext)
    const statusPlain = spawnSync(process.execPath, [cliBin, 'status'], { cwd: workDir, encoding: 'utf8' });
    assert.strictEqual(statusPlain.status, 0);
    assert.ok(statusPlain.stdout.includes('Campaign ID:            stage6_cli_verification'));
    assert.ok(statusPlain.stdout.includes('Lifecycle State:        completed'));
    assert.ok(statusPlain.stdout.includes('Completed Logical Runs: 4 / 4'));
    assert.ok(statusPlain.stdout.includes('Remaining Logical Runs: 0'));

    // 5. Run status --json
    const statusJson = spawnSync(process.execPath, [cliBin, 'status', '--json'], { cwd: workDir, encoding: 'utf8' });
    assert.strictEqual(statusJson.status, 0);
    const parsedStatus = JSON.parse(statusJson.stdout);
    assert.strictEqual(parsedStatus.campaign_id, 'stage6_cli_verification');
    assert.strictEqual(parsedStatus.lifecycle_state, 'completed');
    assert.strictEqual(parsedStatus.completed_logical_runs, 4);
    assert.strictEqual(parsedStatus.remaining_logical_runs, 0);
    assert.strictEqual(parsedStatus.cumulative_attempt_count, 4);

    // 6. Run score
    const scoreRes1 = spawnSync(process.execPath, [cliBin, 'score'], { cwd: workDir, encoding: 'utf8' });
    assert.strictEqual(scoreRes1.status, 0);
    const parsedScore1 = JSON.parse(scoreRes1.stdout);
    assert.strictEqual(parsedScore1.campaign_id, 'stage6_cli_verification');
    assert.strictEqual(parsedScore1.aggregation, 'weighted_mean');
    assert.strictEqual(parsedScore1.missing_policy, 'zero');

    // Calculations:
    // Total weight = 1.0 (zero) + 3.0 (pos) = 4.0
    // model_alpha: (1.0 * 0.0 + 3.0 * 0.8) / 4.0 = 2.4 / 4.0 = 0.6
    // model_beta:  (1.0 * 0.0 + 3.0 * 0.6) / 4.0 = 1.8 / 4.0 = 0.45
    assert.strictEqual(parsedScore1.models.model_alpha.score, 0.6);
    assert.strictEqual(parsedScore1.models.model_alpha.rank, 1);
    assert.strictEqual(parsedScore1.models.model_beta.score, 0.45);
    assert.strictEqual(parsedScore1.models.model_beta.rank, 2);

    // 7. Run score again and verify byte-for-byte identical output
    const scoreRes2 = spawnSync(process.execPath, [cliBin, 'score'], { cwd: workDir, encoding: 'utf8' });
    assert.strictEqual(scoreRes2.status, 0);
    assert.strictEqual(scoreRes2.stdout, scoreRes1.stdout);
  });

  test('Stage 7 Clean End-to-End CLI Scenario: init -> tasks/models -> run (with 0.0) -> status -> score -> register-put/get -> export -> rollback -> status -> resume -> score -> export determinism', async () => {
    const cliBin = path.resolve(process.cwd(), 'dist/src/bin/evalcampaign.js');

    // 1. Initialize campaign
    const campConfig = {
      campaign_id: 'stage7_e2e_camp',
      name: 'Stage 7 End-to-End Scenario',
      repetitions: 1,
      budget: {
        max_wall_time_seconds: 120,
        max_total_attempts: 50,
        max_output_bytes: 4096
      },
      scoring: {
        aggregation: 'weighted_mean',
        missing_policy: 'zero'
      }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));

    const initRes = spawnSync(process.execPath, [cliBin, 'init', campPath], { cwd: workDir, encoding: 'utf8' });
    assert.strictEqual(initRes.status, 0);

    // 2. Add multiple models/tasks
    for (const mId of ['model_1', 'model_2']) {
      const mPath = path.join(workDir, `${mId}.json`);
      fs.writeFileSync(mPath, JSON.stringify({ model_id: mId }));
      const mRes = spawnSync(process.execPath, [cliBin, 'add-model', mPath], { cwd: workDir, encoding: 'utf8' });
      assert.strictEqual(mRes.status, 0);
    }

    // Task 1: outputs legitimate 0.0
    const sZero = path.join(workDir, 'task_zero.js');
    fs.writeFileSync(sZero, `process.stdout.write(JSON.stringify({ score: 0.0 }));`);
    const tZero = path.join(workDir, 't_zero.json');
    fs.writeFileSync(tZero, JSON.stringify({
      task_id: 'task_zero',
      command: `node "${sZero}"`,
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    const tZeroRes = spawnSync(process.execPath, [cliBin, 'add-task', tZero], { cwd: workDir, encoding: 'utf8' });
    assert.strictEqual(tZeroRes.status, 0);

    // Task 2: positive score (model_1: 1.0, model_2: 0.5)
    const sPos = path.join(workDir, 'task_pos.js');
    fs.writeFileSync(sPos, `
      const m = process.env.EVAL_MODEL_ID;
      const score = (m === 'model_1') ? 1.0 : 0.5;
      process.stdout.write(JSON.stringify({ score }));
    `);
    const tPos = path.join(workDir, 't_pos.json');
    fs.writeFileSync(tPos, JSON.stringify({
      task_id: 'task_pos',
      command: `node "${sPos}"`,
      timeout_seconds: 5,
      weight: 2.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    const tPosRes = spawnSync(process.execPath, [cliBin, 'add-task', tPos], { cwd: workDir, encoding: 'utf8' });
    assert.strictEqual(tPosRes.status, 0);

    // 3. Execute runs including at least one legitimate 0.0
    const runRes = spawnSync(process.execPath, [cliBin, 'run'], { cwd: workDir, encoding: 'utf8' });
    assert.strictEqual(runRes.status, 0);

    // 4. Run status
    const statusRes1 = spawnSync(process.execPath, [cliBin, 'status', '--json'], { cwd: workDir, encoding: 'utf8' });
    assert.strictEqual(statusRes1.status, 0);
    const parsedStatus1 = JSON.parse(statusRes1.stdout);
    assert.strictEqual(parsedStatus1.lifecycle_state, 'completed');
    assert.strictEqual(parsedStatus1.completed_logical_runs, 4);

    // 5. Run score
    const scoreRes1 = spawnSync(process.execPath, [cliBin, 'score'], { cwd: workDir, encoding: 'utf8' });
    assert.strictEqual(scoreRes1.status, 0);
    const parsedScore1 = JSON.parse(scoreRes1.stdout);
    assert.strictEqual(parsedScore1.rankings.length, 2);

    // 6. Run register-put
    const binaryBytes = Buffer.from([0x00, 0x01, 0xfe, 0xff, 0x7f, 0x80, 0x42, 0x13, 0x37]);
    const binFile = path.join(workDir, 'scratch.bin');
    fs.writeFileSync(binFile, binaryBytes);
    const regPutRes = spawnSync(process.execPath, [cliBin, 'register-put', '--reg', 'x', binFile], { cwd: workDir, encoding: 'utf8' });
    assert.strictEqual(regPutRes.status, 0);

    // 7. Verify register-get byte-for-byte
    const regGetRes = spawnSync(process.execPath, [cliBin, 'register-get', '--reg', 'x'], { cwd: workDir, encoding: 'buffer' });
    assert.strictEqual(regGetRes.status, 0);
    assert.deepStrictEqual(regGetRes.stdout, binaryBytes);

    // 8. Run export --format json
    const exportRes1 = spawnSync(process.execPath, [cliBin, 'export', '--format', 'json'], { cwd: workDir, encoding: 'utf8' });
    assert.strictEqual(exportRes1.status, 0);
    const parsedExport1 = JSON.parse(exportRes1.stdout);
    assert.strictEqual(parsedExport1.campaign_id, 'stage7_e2e_camp');
    assert.strictEqual(parsedExport1.lifecycle_state, 'completed');
    assert.strictEqual(parsedExport1.runs.length, 4);

    // 9. Perform rollback
    const rollbackRes = spawnSync(process.execPath, [cliBin, 'rollback', '1'], { cwd: workDir, encoding: 'utf8' });
    assert.strictEqual(rollbackRes.status, 0);

    // 10. Verify status after rollback
    const statusRes2 = spawnSync(process.execPath, [cliBin, 'status', '--json'], { cwd: workDir, encoding: 'utf8' });
    assert.strictEqual(statusRes2.status, 0);
    const parsedStatus2 = JSON.parse(statusRes2.stdout);
    assert.strictEqual(parsedStatus2.completed_logical_runs, 3);
    assert.strictEqual(parsedStatus2.remaining_logical_runs, 1);
    assert.strictEqual(parsedStatus2.lifecycle_state, 'running');

    // 11. Resume/rerun remaining work
    const resumeRes = spawnSync(process.execPath, [cliBin, 'resume'], { cwd: workDir, encoding: 'utf8' });
    assert.strictEqual(resumeRes.status, 0);
    const statusRes3 = spawnSync(process.execPath, [cliBin, 'status', '--json'], { cwd: workDir, encoding: 'utf8' });
    assert.strictEqual(statusRes3.status, 0);
    assert.strictEqual(JSON.parse(statusRes3.stdout).lifecycle_state, 'completed');
    assert.strictEqual(JSON.parse(statusRes3.stdout).completed_logical_runs, 4);

    // 12. Score again
    const scoreRes2 = spawnSync(process.execPath, [cliBin, 'score'], { cwd: workDir, encoding: 'utf8' });
    assert.strictEqual(scoreRes2.status, 0);
    assert.strictEqual(scoreRes2.stdout, scoreRes1.stdout);

    // 13. Export again
    const exportRes2 = spawnSync(process.execPath, [cliBin, 'export', '--format', 'json'], { cwd: workDir, encoding: 'utf8' });
    assert.strictEqual(exportRes2.status, 0);

    // 14. Repeat export and verify byte-for-byte determinism
    const exportRes3 = spawnSync(process.execPath, [cliBin, 'export', '--format', 'json'], { cwd: workDir, encoding: 'utf8' });
    assert.strictEqual(exportRes3.status, 0);
    assert.strictEqual(exportRes2.stdout, exportRes3.stdout);
  });
});
