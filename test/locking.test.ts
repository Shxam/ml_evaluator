import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawnSync, spawn } from 'child_process';
import { handleInit } from '../src/cli/commands/init';
import { acquireCampaignLock, releaseCampaignLock, LockContentionError } from '../src/core/concurrency/lock';
import { EXIT_CODES } from '../src/core/constants';

describe('Genuine POSIX Advisory Locking & Metadata Independence', () => {
  let workDir: string;
  let taskPath: string;
  let lockFilePath: string;

  const validCampaign = {
    campaign_id: 'lock_test_camp',
    name: 'Lock Test Campaign',
    budget: { max_wall_time_seconds: 60, max_total_attempts: 10, max_output_bytes: 1024 },
    scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
  };

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalcampaign-lock-test-'));
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(validCampaign, null, 2));
    handleInit(campPath, workDir);

    lockFilePath = path.join(workDir, '.evalcampaign', 'locks', 'campaign.lock');

    taskPath = path.join(workDir, 'task.json');
    fs.writeFileSync(
      taskPath,
      JSON.stringify({
        task_id: 'sample_task',
        command: 'echo 1',
        timeout_seconds: 5,
        weight: 1.0,
        retry_policy: { max_attempts: 1, retry_on: ['timeout'] }
      })
    );
  });

  afterEach(() => {
    if (fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('acquires real file descriptor lock cleanly and releases lock descriptor', () => {
    const lock = acquireCampaignLock(workDir);
    assert.strictEqual(lock.metadata.pid, process.pid);
    assert.strictEqual(typeof lock.fd, 'number');
    assert.ok(lock.fd !== null && lock.fd >= 0);

    releaseCampaignLock(lock);
    assert.strictEqual(lock.fd, null);
  });

  test('Case A — active-looking metadata but OS lock is free: acquisition succeeds', () => {
    // Write metadata claiming the current (live) process PID is holding the lock,
    // but the OS descriptor is NOT actually held.
    const fakeActiveMetadata = {
      pid: process.pid,
      locked_at: Date.now(),
      expires_at: Date.now() + 600000
    };
    fs.writeFileSync(lockFilePath, JSON.stringify(fakeActiveMetadata, null, 2));

    // A new acquisition must succeed because the OS lock is free
    const lock = acquireCampaignLock(workDir);
    assert.ok(lock !== null);
    assert.strictEqual(typeof lock.fd, 'number');
    releaseCampaignLock(lock);
  });

  test('Case B — dead/stale metadata but OS lock is free: acquisition succeeds', () => {
    const staleMetadata = {
      pid: 99999999,
      locked_at: Date.now() - 100000,
      expires_at: Date.now() - 50000
    };
    fs.writeFileSync(lockFilePath, JSON.stringify(staleMetadata, null, 2));

    const lock = acquireCampaignLock(workDir);
    assert.ok(lock !== null);
    assert.strictEqual(typeof lock.fd, 'number');
    releaseCampaignLock(lock);
  });

  test('Case C — corrupt/invalid metadata but OS lock is free: acquisition succeeds', () => {
    fs.writeFileSync(lockFilePath, 'CORRUPTED_GARBAGE_DATA_{{[INVALID_JSON');

    const lock = acquireCampaignLock(workDir);
    assert.ok(lock !== null);
    assert.strictEqual(typeof lock.fd, 'number');
    releaseCampaignLock(lock);
  });

  test('Case D — arbitrary metadata but OS lock is held: child process receives contention exit code 3', () => {
    const lock = acquireCampaignLock(workDir);

    const cliBin = path.resolve(process.cwd(), 'dist/src/bin/evalcampaign.js');
    const child = spawnSync(process.execPath, [cliBin, 'add-task', taskPath], {
      cwd: workDir,
      encoding: 'utf8'
    });

    assert.strictEqual(child.status, EXIT_CODES.LOCK_CONTENTION);
    assert.ok(child.stderr.includes('Lock contention') || child.stderr.includes('lock'));

    releaseCampaignLock(lock);
  });

  test('Cross-process and SIGKILL recovery: Process B contends on held lock, then succeeds after Process A is killed with SIGKILL', async () => {
    const cliBin = path.resolve(process.cwd(), 'dist/src/bin/evalcampaign.js');

    // Spawn Process A holding lock in background
    const holderScript = `
      const { acquireCampaignLock } = require('${path.resolve(process.cwd(), 'dist/src/core/concurrency/lock.js').replace(/\\/g, '/')}');
      const lock = acquireCampaignLock('${workDir.replace(/\\/g, '/')}');
      console.log('LOCKED');
      setInterval(() => {}, 1000);
    `;

    const procA = spawn(process.execPath, ['-e', holderScript], {
      cwd: workDir,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // Wait for Process A to signal acquisition
    await new Promise<void>((resolve, reject) => {
      procA.stdout.on('data', (chunk: Buffer) => {
        if (chunk.toString().includes('LOCKED')) {
          resolve();
        }
      });
      procA.on('error', reject);
      setTimeout(() => resolve(), 500);
    });

    // Process B attempts lock -> must receive exit code 3
    const procB1 = spawnSync(process.execPath, [cliBin, 'add-task', taskPath], {
      cwd: workDir,
      encoding: 'utf8'
    });
    assert.strictEqual(procB1.status, EXIT_CODES.LOCK_CONTENTION);

    // Terminate Process A with SIGKILL
    procA.kill('SIGKILL');
    await new Promise(r => setTimeout(r, 200));

    // Process B attempts lock again -> must succeed with exit code 0
    const procB2 = spawnSync(process.execPath, [cliBin, 'add-task', taskPath], {
      cwd: workDir,
      encoding: 'utf8'
    });
    assert.strictEqual(procB2.status, EXIT_CODES.SUCCESS);
  });
});
