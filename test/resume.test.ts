import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync, spawn } from 'child_process';
import { handleInit } from '../src/cli/commands/init';
import { handleAddTask } from '../src/cli/commands/addTask';
import { handleAddModel } from '../src/cli/commands/addModel';
import { handleRun } from '../src/cli/commands/run';
import { handleResume } from '../src/cli/commands/resume';
import { resumeCampaign } from '../src/core/execution/resumer';
import { runCampaign } from '../src/core/execution/runner';
import { EXIT_CODES } from '../src/core/constants';
import { readJson } from '../src/core/storage/atomic';
import { CampaignState } from '../src/core/types';
import { AttemptManifest } from '../src/core/execution/types';
import { persistAttemptManifest } from '../src/core/execution/manifest';
import { getCampaignSchedule } from '../src/core/scheduler/scheduler';

describe('Campaign Resumer & evalcampaign resume Command', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalcampaign-resume-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('resumes interrupted campaign, skips completed runs, and advances retry attempts', async () => {
    const campConfig = {
      campaign_id: 'resume_camp',
      name: 'Resume Campaign',
      budget: { max_wall_time_seconds: 60, max_total_attempts: 20, max_output_bytes: 4096 },
      scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));
    handleInit(campPath, workDir);

    const mPath = path.join(workDir, 'm1.json');
    fs.writeFileSync(mPath, JSON.stringify({ model_id: 'm1' }));
    handleAddModel(mPath, workDir);

    // Task 1: Success
    const s1 = path.join(workDir, 's1.js');
    fs.writeFileSync(s1, `process.stdout.write(JSON.stringify({ score: 1.0 }));`);
    const t1 = path.join(workDir, 't1.json');
    fs.writeFileSync(t1, JSON.stringify({
      task_id: 'task_1',
      command: `node "${s1}"`,
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    handleAddTask(t1, workDir);

    // Task 2: Fails on attempt 1, succeeds on attempt 2
    const s2 = path.join(workDir, 's2.js');
    fs.writeFileSync(s2, `const att = process.env.EVAL_ATTEMPT; if (att === '1') process.exit(1); else process.stdout.write(JSON.stringify({ score: 0.9 }));`);
    const t2 = path.join(workDir, 't2.json');
    fs.writeFileSync(t2, JSON.stringify({
      task_id: 'task_2',
      command: `node "${s2}"`,
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 2, retry_on: ['evaluator_crash'] }
    }));
    handleAddTask(t2, workDir);

    // Task 3: Never started yet
    const s3 = path.join(workDir, 's3.js');
    fs.writeFileSync(s3, `process.stdout.write(JSON.stringify({ score: 0.8 }));`);
    const t3 = path.join(workDir, 't3.json');
    fs.writeFileSync(t3, JSON.stringify({
      task_id: 'task_3',
      command: `node "${s3}"`,
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    handleAddTask(t3, workDir);

    const schedule = getCampaignSchedule(workDir, 1);
    // Pretend Task 1 completed earlier:
    persistAttemptManifest({
      runId: schedule[0].run_id,
      attempt: 1,
      campaignId: 'resume_camp',
      campaignRev: 1,
      modelId: 'm1',
      taskId: 'task_1',
      repetition: 1,
      status: 'COMPLETED',
      rawScore: 1.0,
      exitCode: 0,
      executionTimeMs: 100,
      stdout: '{"score": 1.0}',
      stderr: '',
      completedAt: 1000
    }, workDir);

    // Pretend Task 2 failed on attempt 1 earlier:
    persistAttemptManifest({
      runId: schedule[1].run_id,
      attempt: 1,
      campaignId: 'resume_camp',
      campaignRev: 1,
      modelId: 'm1',
      taskId: 'task_2',
      repetition: 1,
      status: 'EVALUATOR_CRASH',
      rawScore: null,
      exitCode: 1,
      executionTimeMs: 50,
      stdout: '',
      stderr: 'crash',
      completedAt: 2000
    }, workDir);

    // Simulate lingering temporary file from prior crash
    const runsDir = path.join(workDir, '.evalcampaign', 'runs');
    fs.writeFileSync(path.join(runsDir, '.stale_manifest.1234.tmp'), 'partial junk');

    // Run resume
    const res = await resumeCampaign(workDir);
    assert.strictEqual(res.exitCode, EXIT_CODES.SUCCESS);

    // Verify stale temp file was cleaned
    assert.ok(!fs.existsSync(path.join(runsDir, '.stale_manifest.1234.tmp')));

    // Task 1 manifest must be strictly untouched (completedAt preserved)
    const mTask1 = readJson<AttemptManifest>(path.join(runsDir, `${schedule[0].run_id}_att1.json`));
    assert.strictEqual(mTask1.completed_at, 1000);

    // Task 2 must have attempt 2 persisted
    const mTask2Att2 = readJson<AttemptManifest>(path.join(runsDir, `${schedule[1].run_id}_att2.json`));
    assert.strictEqual(mTask2Att2.status, 'COMPLETED');
    assert.strictEqual(mTask2Att2.attempt, 2);
    assert.strictEqual(mTask2Att2.raw_score, 0.9);

    // Task 3 must have attempt 1 persisted
    const mTask3 = readJson<AttemptManifest>(path.join(runsDir, `${schedule[2].run_id}_att1.json`));
    assert.strictEqual(mTask3.status, 'COMPLETED');
    assert.strictEqual(mTask3.attempt, 1);

    // State must be completed
    const state = readJson<CampaignState>(path.join(workDir, '.evalcampaign', 'state.json'));
    assert.strictEqual(state.lifecycle_state, 'completed');
    assert.strictEqual((state as any).completed_runs, 3);
    assert.strictEqual((state as any).total_attempts, 4); // 1 + 2 + 1
  });

  test('recovers from interrupted execution without manifest by re-dispatching unfinished run', async () => {
    const campConfig = {
      campaign_id: 'interrupted_camp',
      name: 'Interrupted Campaign',
      budget: { max_wall_time_seconds: 60, max_total_attempts: 10, max_output_bytes: 4096 },
      scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));
    handleInit(campPath, workDir);

    const mPath = path.join(workDir, 'm1.json');
    fs.writeFileSync(mPath, JSON.stringify({ model_id: 'm1' }));
    handleAddModel(mPath, workDir);

    const sPath = path.join(workDir, 'eval.js');
    fs.writeFileSync(sPath, `process.stdout.write(JSON.stringify({ score: 0.75 }));`);

    const tPath = path.join(workDir, 't1.json');
    fs.writeFileSync(tPath, JSON.stringify({
      task_id: 't1',
      command: `node "${sPath}"`,
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    handleAddTask(tPath, workDir);

    // Mark state as running (as if interrupted while executing before writing manifest)
    const statePath = path.join(workDir, '.evalcampaign', 'state.json');
    const state = readJson<CampaignState>(statePath);
    state.lifecycle_state = 'running';
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    const res = await handleResume(workDir);
    assert.strictEqual(res, EXIT_CODES.SUCCESS);

    const runsDir = path.join(workDir, '.evalcampaign', 'runs');
    const files = fs.readdirSync(runsDir).filter(f => f.endsWith('.json'));
    assert.strictEqual(files.length, 1);

    const manifest = readJson<AttemptManifest>(path.join(runsDir, files[0]));
    assert.strictEqual(manifest.status, 'COMPLETED');
    assert.strictEqual(manifest.raw_score, 0.75);
  });

  test('rejects resume with exit code 4 when campaign is already completed', async () => {
    const campConfig = {
      campaign_id: 'completed_camp',
      name: 'Completed Campaign',
      budget: { max_wall_time_seconds: 60, max_total_attempts: 10, max_output_bytes: 4096 },
      scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));
    handleInit(campPath, workDir);

    const statePath = path.join(workDir, '.evalcampaign', 'state.json');
    const state = readJson<CampaignState>(statePath);
    state.lifecycle_state = 'completed';
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    const code = await handleResume(workDir);
    assert.strictEqual(code, EXIT_CODES.INVALID_STATE);
  });

  test('detects provenance drift before resumed attempt and halts with exit code 5', async () => {
    const campConfig = {
      campaign_id: 'drift_resume_camp',
      name: 'Drift Resume Campaign',
      budget: { max_wall_time_seconds: 60, max_total_attempts: 10, max_output_bytes: 4096 },
      scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));
    handleInit(campPath, workDir);

    const mPath = path.join(workDir, 'm1.json');
    fs.writeFileSync(mPath, JSON.stringify({ model_id: 'm1' }));
    handleAddModel(mPath, workDir);

    const sPath = path.join(workDir, 'eval.js');
    fs.writeFileSync(sPath, `process.stdout.write(JSON.stringify({ score: 1.0 }));`);

    const tPath = path.join(workDir, 't1.json');
    fs.writeFileSync(tPath, JSON.stringify({
      task_id: 'task_drift',
      command: `node "${sPath}"`,
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 2, retry_on: ['evaluator_crash'] }
    }));
    handleAddTask(tPath, workDir);

    // Baseline captured on run
    await runCampaign(workDir);

    // Tamper with task file on disk
    const registeredTaskPath = path.join(workDir, '.evalcampaign', 'tasks', 'task_drift.json');
    fs.appendFileSync(registeredTaskPath, '/* DRIFT */');

    // Reset lifecycle to running so resume can try
    const statePath = path.join(workDir, '.evalcampaign', 'state.json');
    const state = readJson<CampaignState>(statePath);
    state.lifecycle_state = 'running';
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2));

    const res = await resumeCampaign(workDir);
    assert.strictEqual(res.exitCode, EXIT_CODES.PROVENANCE_DRIFT);
  });

  test('enforces cumulative attempt budget across run and resume with exit code 6', async () => {
    const campConfig = {
      campaign_id: 'cumulative_budget_camp',
      name: 'Cumulative Budget Campaign',
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

    const scriptPath = path.join(workDir, 'eval.js');
    fs.writeFileSync(scriptPath, `process.stdout.write(JSON.stringify({ score: 1.0 }));`);

    for (const t of ['t1', 't2']) {
      const p = path.join(workDir, `${t}.json`);
      fs.writeFileSync(p, JSON.stringify({
        task_id: t,
        command: `node "${scriptPath}"`,
        timeout_seconds: 5,
        weight: 1.0,
        retry_policy: { max_attempts: 1, retry_on: [] }
      }));
      handleAddTask(p, workDir);
    }

    // First run hits attempt limit (2 attempts)
    const runRes = await runCampaign(workDir);
    assert.strictEqual(runRes.exitCode, EXIT_CODES.BUDGET_EXCEEDED);
    assert.strictEqual(runRes.totalAttempts, 2);

    // Resume immediately hits cumulative budget limit (2 >= 2)
    const resumeRes = await resumeCampaign(workDir);
    assert.strictEqual(resumeRes.exitCode, EXIT_CODES.BUDGET_EXCEEDED);
    assert.strictEqual(resumeRes.totalAttempts, 2);
  });

  test('enforces resume-specific wall-clock budget with exit code 6', async () => {
    const campConfig = {
      campaign_id: 'walltime_resume_camp',
      name: 'Wall Time Resume Campaign',
      budget: { max_wall_time_seconds: 1, max_total_attempts: 100, max_output_bytes: 4096 },
      scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));
    handleInit(campPath, workDir);

    const mPath = path.join(workDir, 'm1.json');
    fs.writeFileSync(mPath, JSON.stringify({ model_id: 'm1' }));
    handleAddModel(mPath, workDir);

    // Task 1: sleeps 1200ms
    const s1 = path.join(workDir, 'slow.js');
    fs.writeFileSync(s1, `setTimeout(() => { process.stdout.write(JSON.stringify({ score: 1.0 })); }, 1200);`);
    const t1 = path.join(workDir, 't1.json');
    fs.writeFileSync(t1, JSON.stringify({
      task_id: 'task_1_slow',
      command: `node "${s1}"`,
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    handleAddTask(t1, workDir);

    // Task 2: next task
    const s2 = path.join(workDir, 'next.js');
    fs.writeFileSync(s2, `process.stdout.write(JSON.stringify({ score: 1.0 }));`);
    const t2 = path.join(workDir, 't2.json');
    fs.writeFileSync(t2, JSON.stringify({
      task_id: 'task_2_next',
      command: `node "${s2}"`,
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    handleAddTask(t2, workDir);

    const resumeRes = await resumeCampaign(workDir);
    assert.strictEqual(resumeRes.exitCode, EXIT_CODES.BUDGET_EXCEEDED);
    assert.strictEqual(resumeRes.totalAttempts, 1);
  });

  test('Section 20 Manual Verification: multi-model, multi-task, repetitions >= 2 recovery scenario', async () => {
    const campConfig = {
      campaign_id: 'manual_verification_stage5',
      name: 'Stage 5 Comprehensive Recovery Verification',
      repetitions: 2,
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
    handleInit(campPath, workDir);

    for (const mId of ['model_a', 'model_b']) {
      const p = path.join(workDir, `${mId}.json`);
      fs.writeFileSync(p, JSON.stringify({ model_id: mId }));
      handleAddModel(p, workDir);
    }

    // Task 1: Clean pass
    const s1 = path.join(workDir, 's1.js');
    fs.writeFileSync(s1, `process.stdout.write(JSON.stringify({ score: 0.9 }));`);
    const t1 = path.join(workDir, 't1.json');
    fs.writeFileSync(t1, JSON.stringify({
      task_id: 'task_pass',
      command: `node "${s1}"`,
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    handleAddTask(t1, workDir);

    // Task 2: Retryable failure
    const s2 = path.join(workDir, 's2.js');
    fs.writeFileSync(s2, `const att = process.env.EVAL_ATTEMPT; if (att === '1') process.exit(1); else process.stdout.write(JSON.stringify({ score: 0.85 }));`);
    const t2 = path.join(workDir, 't2.json');
    fs.writeFileSync(t2, JSON.stringify({
      task_id: 'task_retryable',
      command: `node "${s2}"`,
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 2, retry_on: ['evaluator_crash'] }
    }));
    handleAddTask(t2, workDir);

    const schedule = getCampaignSchedule(workDir, 2);
    // 2 models x 2 tasks x 2 reps = 8 logical runs.
    // Let's seed initial simulated crash state:
    const runCompleted = schedule.find(s => s.task_id === 'task_pass')!;
    const runRetryable = schedule.find(s => s.task_id === 'task_retryable')!;

    // Run Completed: Completed earlier
    persistAttemptManifest({
      runId: runCompleted.run_id,
      attempt: 1,
      campaignId: 'manual_verification_stage5',
      campaignRev: 1,
      modelId: runCompleted.model_id,
      taskId: runCompleted.task_id,
      repetition: runCompleted.repetition,
      status: 'COMPLETED',
      rawScore: 0.9,
      exitCode: 0,
      executionTimeMs: 100,
      stdout: '{"score": 0.9}',
      stderr: '',
      completedAt: 1000
    }, workDir);

    // Run Retryable: Attempt 1 crashed earlier with retryable failure
    persistAttemptManifest({
      runId: runRetryable.run_id,
      attempt: 1,
      campaignId: 'manual_verification_stage5',
      campaignRev: 1,
      modelId: runRetryable.model_id,
      taskId: runRetryable.task_id,
      repetition: runRetryable.repetition,
      status: 'EVALUATOR_CRASH',
      rawScore: null,
      exitCode: 1,
      executionTimeMs: 80,
      stdout: '',
      stderr: 'crash error',
      completedAt: 2000
    }, workDir);

    // Run Interrupted: Attempt was interrupted with no manifest
    // Other runs: Unstarted

    // Execute evalcampaign resume
    const res = await resumeCampaign(workDir);
    assert.strictEqual(res.exitCode, EXIT_CODES.SUCCESS);

    // Verify all 8 logical runs are completed
    const state = readJson<CampaignState>(path.join(workDir, '.evalcampaign', 'state.json'));
    assert.strictEqual(state.lifecycle_state, 'completed');
    assert.strictEqual((state as any).completed_runs, 8);

    // Verify runCompleted completed_at is still preserved (not re-executed)
    const runsDir = path.join(workDir, '.evalcampaign', 'runs');
    const mRun0 = readJson<AttemptManifest>(path.join(runsDir, `${runCompleted.run_id}_att1.json`));
    assert.strictEqual(mRun0.completed_at, 1000);

    // Verify runRetryable has attempt 2 persisted as COMPLETED
    const mRetryAtt2 = readJson<AttemptManifest>(path.join(runsDir, `${runRetryable.run_id}_att2.json`));
    assert.strictEqual(mRetryAtt2.status, 'COMPLETED');
    assert.strictEqual(mRetryAtt2.attempt, 2);

    // Now test calling resume again on completed campaign -> must return exit code 4
    const resCompleted = await handleResume(workDir);
    assert.strictEqual(resCompleted, EXIT_CODES.INVALID_STATE);
  });
});
