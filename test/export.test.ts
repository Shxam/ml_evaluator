import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { handleInit } from '../src/cli/commands/init';
import { handleAddTask } from '../src/cli/commands/addTask';
import { handleAddModel } from '../src/cli/commands/addModel';
import { handleRun } from '../src/cli/commands/run';
import { handleRollback } from '../src/cli/commands/rollback';
import { handleResume } from '../src/cli/commands/resume';
import { handleExport } from '../src/cli/commands/export';
import { generateCampaignExport, formatDeterministicExport } from '../src/core/export/exporter';
import { acquireCampaignLock, releaseCampaignLock } from '../src/core/concurrency/lock';
import { EXIT_CODES } from '../src/core/constants';

describe('Deterministic Campaign Export (evalcampaign export --format json)', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalcampaign-export-test-'));
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

  test('requires --format json flag and rejects missing or unsupported formats with exit code 1', () => {
    const campConfig = {
      campaign_id: 'export_fmt_camp',
      name: 'Format Test Campaign',
      repetitions: 1,
      budget: { max_wall_time_seconds: 60, max_total_attempts: 10, max_output_bytes: 1024 },
      scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));
    handleInit(campPath, workDir);

    assert.strictEqual(handleExport([], workDir), EXIT_CODES.USAGE_ERROR);
    assert.strictEqual(handleExport(['--format', 'csv'], workDir), EXIT_CODES.USAGE_ERROR);
    assert.strictEqual(handleExport(['--format', 'yaml'], workDir), EXIT_CODES.USAGE_ERROR);
    assert.strictEqual(handleExport(['--format=xml'], workDir), EXIT_CODES.USAGE_ERROR);
  });

  test('exports fully completed campaign with deterministic schema, sorted keys, and rankings', async () => {
    const campConfig = {
      campaign_id: 'export_e2e_camp',
      name: 'Export E2E Campaign',
      repetitions: 2,
      budget: { max_wall_time_seconds: 60, max_total_attempts: 20, max_output_bytes: 4096 },
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

    const s1 = path.join(workDir, 's1.js');
    fs.writeFileSync(s1, 'process.stdout.write(JSON.stringify({ score: 0.9 }));');
    const t1 = path.join(workDir, 't1.json');
    fs.writeFileSync(t1, JSON.stringify({
      task_id: 'task_1',
      command: `node "${s1}"`,
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    handleAddTask(t1, workDir);

    const s2 = path.join(workDir, 's2.js');
    fs.writeFileSync(s2, 'process.stdout.write(JSON.stringify({ score: 0.0 }));');
    const t2 = path.join(workDir, 't2.json');
    fs.writeFileSync(t2, JSON.stringify({
      task_id: 'task_2',
      command: `node "${s2}"`,
      timeout_seconds: 5,
      weight: 2.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    handleAddTask(t2, workDir);

    await handleRun(workDir);

    const report = generateCampaignExport(workDir);
    assert.strictEqual(report.campaign_id, 'export_e2e_camp');
    assert.strictEqual(report.lifecycle_state, 'completed');
    assert.strictEqual(report.models.length, 2);
    assert.strictEqual(report.models[0].model_id, 'model_a');
    assert.strictEqual(report.models[1].model_id, 'model_z');
    assert.strictEqual(report.tasks.length, 2);
    assert.strictEqual(report.tasks[0].task_id, 'task_1');
    assert.strictEqual(report.tasks[1].task_id, 'task_2');

    // Provenance baseline hashes
    assert.ok(report.provenance.task_1);
    assert.ok(report.provenance.task_2);

    // Runs length = 2 models * 2 tasks * 2 reps = 8
    assert.strictEqual(report.runs.length, 8);
    assert.strictEqual(report.status.completed_logical_runs, 8);
    assert.strictEqual(report.status.remaining_logical_runs, 0);

    // Rankings present
    assert.ok(report.rankings);
    assert.strictEqual(report.rankings.length, 2);

    const json = formatDeterministicExport(report);
    const parsed = JSON.parse(json);
    const keys = Object.keys(parsed);
    assert.deepStrictEqual(keys, [...keys].sort());

    const exitCode = handleExport(['--format', 'json'], workDir);
    assert.strictEqual(exitCode, EXIT_CODES.SUCCESS);
  });

  test('repeated exports produce byte-for-byte identical output', async () => {
    const campConfig = {
      campaign_id: 'export_det_camp',
      name: 'Deterministic Export Campaign',
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

    const s = path.join(workDir, 's.js');
    fs.writeFileSync(s, 'process.stdout.write(JSON.stringify({ score: 0.8 }));');
    const t = path.join(workDir, 't.json');
    fs.writeFileSync(t, JSON.stringify({
      task_id: 't1',
      command: `node "${s}"`,
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    handleAddTask(t, workDir);

    await handleRun(workDir);

    const export1 = formatDeterministicExport(generateCampaignExport(workDir));
    const export2 = formatDeterministicExport(generateCampaignExport(workDir));

    assert.strictEqual(export1, export2);
  });

  test('detects provenance drift before export and halts with exit code 5', async () => {
    const campConfig = {
      campaign_id: 'export_drift_camp',
      name: 'Drift Export Campaign',
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

    const s = path.join(workDir, 's.js');
    fs.writeFileSync(s, 'process.stdout.write(JSON.stringify({ score: 0.8 }));');
    const t = path.join(workDir, 't.json');
    fs.writeFileSync(t, JSON.stringify({
      task_id: 't1',
      command: `node "${s}"`,
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    handleAddTask(t, workDir);

    await handleRun(workDir);

    // Tamper with task configuration file on disk
    const targetTask = path.join(workDir, '.evalcampaign', 'tasks', 't1.json');
    fs.appendFileSync(targetTask, '/* TAMPERED_DRIFT */');

    const exitCode = handleExport(['--format', 'json'], workDir);
    assert.strictEqual(exitCode, EXIT_CODES.PROVENANCE_DRIFT);
  });

  test('cross-feature consistency: run -> rollback -> export reflects reverted state', async () => {
    const campConfig = {
      campaign_id: 'export_rb_camp',
      name: 'Export Rollback Campaign',
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
      task_id: 't1',
      command: `node "${s}"`,
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    handleAddTask(t, workDir);

    await handleRun(workDir);

    // Rollback 1 batch
    handleRollback(['1'], workDir);

    // Export after rollback
    const report = generateCampaignExport(workDir);
    assert.strictEqual(report.status.completed_logical_runs, 1);
    assert.strictEqual(report.status.remaining_logical_runs, 1);
    assert.strictEqual(report.lifecycle_state, 'running');

    // Resuming to completion
    await handleResume(workDir);

    // Export after resume
    const postResumeReport = generateCampaignExport(workDir);
    assert.strictEqual(postResumeReport.status.completed_logical_runs, 2);
    assert.strictEqual(postResumeReport.status.remaining_logical_runs, 0);
    assert.strictEqual(postResumeReport.lifecycle_state, 'completed');
  });

  test('export respects advisory lock contention (exit code 3)', () => {
    const campConfig = {
      campaign_id: 'export_lock_camp',
      name: 'Export Lock Campaign',
      repetitions: 1,
      budget: { max_wall_time_seconds: 60, max_total_attempts: 10, max_output_bytes: 1024 },
      scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));
    handleInit(campPath, workDir);

    const lock = acquireCampaignLock(workDir);
    try {
      const code = handleExport(['--format', 'json'], workDir);
      assert.strictEqual(code, EXIT_CODES.LOCK_CONTENTION);
    } finally {
      releaseCampaignLock(lock);
    }
  });

  test('fails safely with exit code 1 when campaign is not initialized', () => {
    const uninitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uninit-export-'));
    try {
      const code = handleExport(['--format', 'json'], uninitDir);
      assert.strictEqual(code, EXIT_CODES.USAGE_ERROR);
    } finally {
      fs.rmSync(uninitDir, { recursive: true, force: true });
    }
  });
});
