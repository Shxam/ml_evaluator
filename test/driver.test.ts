import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { executeEvaluator } from '../src/core/execution/driver';

describe('Subprocess Execution Driver & Environment Protocol', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('injects all required environment variables with exact string values', async () => {
    const scriptPath = path.join(workDir, 'env_echo.js');
    fs.writeFileSync(
      scriptPath,
      `process.stdout.write(JSON.stringify({
        task: process.env.EVAL_TASK_ID,
        model: process.env.EVAL_MODEL_ID,
        rep: process.env.EVAL_REPETITION,
        att: process.env.EVAL_ATTEMPT,
        score: 1.0
      }));`
    );

    const res = await executeEvaluator({
      command: `node "${scriptPath}"`,
      taskId: 'task_alpha',
      modelId: 'model_beta',
      repetition: 2,
      attempt: 3,
      timeoutSeconds: 5,
      maxOutputBytes: 1024,
      cwd: workDir
    });

    assert.strictEqual(res.exitCode, 0);
    assert.strictEqual(res.timedOut, false);
    assert.strictEqual(res.outputOverflow, false);

    const parsed = JSON.parse(res.stdout);
    assert.strictEqual(parsed.task, 'task_alpha');
    assert.strictEqual(parsed.model, 'model_beta');
    assert.strictEqual(parsed.rep, '2');
    assert.strictEqual(parsed.att, '3');
  });

  test('captures stdout and stderr into separate buffers', async () => {
    const scriptPath = path.join(workDir, 'streams.js');
    fs.writeFileSync(
      scriptPath,
      `process.stdout.write('OUT_DATA'); process.stderr.write('ERR_DATA');`
    );

    const res = await executeEvaluator({
      command: `node "${scriptPath}"`,
      taskId: 't1',
      modelId: 'm1',
      repetition: 1,
      attempt: 1,
      timeoutSeconds: 5,
      maxOutputBytes: 1024,
      cwd: workDir
    });

    assert.strictEqual(res.stdout, 'OUT_DATA');
    assert.strictEqual(res.stderr, 'ERR_DATA');
  });

  test('enforces task timeout and terminates sleeping child process', async () => {
    const scriptPath = path.join(workDir, 'sleep.js');
    fs.writeFileSync(
      scriptPath,
      `setTimeout(() => { process.stdout.write(JSON.stringify({ score: 1.0 })); }, 10000);`
    );

    const start = Date.now();
    const res = await executeEvaluator({
      command: `node "${scriptPath}"`,
      taskId: 'sleep_task',
      modelId: 'm1',
      repetition: 1,
      attempt: 1,
      timeoutSeconds: 1,
      maxOutputBytes: 1024,
      cwd: workDir
    });
    const elapsed = Date.now() - start;

    assert.strictEqual(res.timedOut, true);
    assert.ok(elapsed >= 900 && elapsed < 8000, `Elapsed time was ${elapsed}ms`);
  });

  test('enforces per-attempt output bounding (max_output_bytes) and flags output overflow', async () => {
    const scriptPath = path.join(workDir, 'overflow.js');
    fs.writeFileSync(
      scriptPath,
      `process.stdout.write('A'.repeat(5000));`
    );

    const res = await executeEvaluator({
      command: `node "${scriptPath}"`,
      taskId: 'big_output_task',
      modelId: 'm1',
      repetition: 1,
      attempt: 1,
      timeoutSeconds: 5,
      maxOutputBytes: 100,
      cwd: workDir
    });

    assert.strictEqual(res.outputOverflow, true);
    assert.ok(res.stdout.length <= 100, `Output length ${res.stdout.length} should not exceed 100 bytes`);
  });
});
