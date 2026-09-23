import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { handleInit } from '../src/cli/commands/init';
import { handleAddTask } from '../src/cli/commands/addTask';
import { handleAddModel } from '../src/cli/commands/addModel';
import { cleanupStaleTempFiles, scanRunManifests, reconcileCampaignState, UnrecoverableCorruptionError } from '../src/core/execution/recovery';
import { getCampaignSchedule } from '../src/core/scheduler/scheduler';
import { persistAttemptManifest } from '../src/core/execution/manifest';

describe('Crash Recovery & State Reconciliation Logic', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalcampaign-recovery-test-'));
    const campConfig = {
      campaign_id: 'rec_camp',
      name: 'Recovery Campaign',
      budget: { max_wall_time_seconds: 60, max_total_attempts: 10, max_output_bytes: 4096 },
      scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));
    handleInit(campPath, workDir);

    const mPath = path.join(workDir, 'm1.json');
    fs.writeFileSync(mPath, JSON.stringify({ model_id: 'm1' }));
    handleAddModel(mPath, workDir);

    const tPath = path.join(workDir, 't1.json');
    fs.writeFileSync(
      tPath,
      JSON.stringify({
        task_id: 't1',
        command: 'echo 1',
        timeout_seconds: 5,
        weight: 1.0,
        retry_policy: { max_attempts: 3, retry_on: ['evaluator_crash'] }
      })
    );
    handleAddTask(tPath, workDir);
  });

  afterEach(() => {
    if (fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('cleans up lingering .tmp files safely', () => {
    const runsDir = path.join(workDir, '.evalcampaign', 'runs');
    const staleTmp1 = path.join(runsDir, '.run1_att1.json.1234.tmp');
    const staleTmp2 = path.join(workDir, '.evalcampaign', '.state.json.5678.tmp');
    fs.writeFileSync(staleTmp1, 'incomplete data');
    fs.writeFileSync(staleTmp2, 'incomplete state');

    const cleaned = cleanupStaleTempFiles(workDir);
    assert.strictEqual(cleaned.length, 2);
    assert.ok(!fs.existsSync(staleTmp1));
    assert.ok(!fs.existsSync(staleTmp2));
  });

  test('reconciles state counters with actual valid manifests on disk', () => {
    const schedule = getCampaignSchedule(workDir, 1);
    const runId = schedule[0].run_id;

    // Persist attempt 1 (crash) and attempt 2 (completed)
    persistAttemptManifest({
      runId,
      attempt: 1,
      campaignId: 'rec_camp',
      campaignRev: 1,
      modelId: 'm1',
      taskId: 't1',
      repetition: 1,
      status: 'EVALUATOR_CRASH',
      rawScore: null,
      exitCode: 1,
      executionTimeMs: 50,
      stdout: '',
      stderr: 'error'
    }, workDir);

    persistAttemptManifest({
      runId,
      attempt: 2,
      campaignId: 'rec_camp',
      campaignRev: 1,
      modelId: 'm1',
      taskId: 't1',
      repetition: 1,
      status: 'COMPLETED',
      rawScore: 0.9,
      exitCode: 0,
      executionTimeMs: 60,
      stdout: '{"score": 0.9}',
      stderr: ''
    }, workDir);

    const { state, report } = reconcileCampaignState(workDir, schedule);
    assert.strictEqual(report.totalDispatchedAttempts, 2);
    assert.strictEqual(report.completedLogicalRuns, 1);
    assert.strictEqual((state as any).total_attempts, 2);
    assert.strictEqual((state as any).completed_runs, 1);

    const runInfo = report.runs.get(runId);
    assert.ok(runInfo);
    assert.strictEqual(runInfo?.isCompleted, true);
    assert.strictEqual(runInfo?.highestAttempt, 2);
    assert.strictEqual(runInfo?.nextAttempt, null);
  });

  test('fails closed with UnrecoverableCorruptionError on skipped attempt manifest', () => {
    const schedule = getCampaignSchedule(workDir, 1);
    const runId = schedule[0].run_id;

    // Only persist attempt 2 without attempt 1
    persistAttemptManifest({
      runId,
      attempt: 2,
      campaignId: 'rec_camp',
      campaignRev: 1,
      modelId: 'm1',
      taskId: 't1',
      repetition: 1,
      status: 'COMPLETED',
      rawScore: 1.0,
      exitCode: 0,
      executionTimeMs: 50,
      stdout: '{"score": 1.0}',
      stderr: ''
    }, workDir);

    assert.throws(
      () => scanRunManifests(workDir, schedule),
      UnrecoverableCorruptionError
    );
  });

  test('fails closed with UnrecoverableCorruptionError on corrupt/malformed manifest JSON', () => {
    const schedule = getCampaignSchedule(workDir, 1);
    const runId = schedule[0].run_id;
    const runsDir = path.join(workDir, '.evalcampaign', 'runs');
    const badManifestPath = path.join(runsDir, `${runId}_att1.json`);
    fs.writeFileSync(badManifestPath, 'INVALID_JSON_GARBAGE{{{');

    assert.throws(
      () => scanRunManifests(workDir, schedule),
      UnrecoverableCorruptionError
    );
  });
});
