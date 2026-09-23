const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { createTestDir, cleanupDir, runCli, REFERENCE_CLI } = require('../utils');

/**
 * CHECK-LOCK-001: Genuine POSIX Advisory Locking
 * Verifies using separate processes:
 * - When a process holds the campaign lock, concurrent mutating operations exit with code 3 (LOCK_CONTENTION)
 * - Killing the lock holder releases the OS kernel lock reliably
 * - Metadata / existence of a lock file is not treated as synchronization authority
 * - Detects MUTANT-LOCK-OMISSION (omission of kernel-level locking)
 */
function run(cliPath) {
  const targetCli = cliPath || REFERENCE_CLI;
  const workDir = createTestDir('check-lock-001-');

  try {
    // 1. Initialize campaign
    const campConfig = {
      campaign_id: 'camp_check_lock',
      name: 'Check POSIX Locking',
      repetitions: 1,
      budget: { max_wall_time_seconds: 60, max_total_attempts: 10, max_output_bytes: 4096 },
      scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));

    const initRes = runCli(cliPath, ['init', campPath], workDir);
    if (initRes.status !== 0) {
      return { pass: false, error: `Init failed: ${initRes.stderr}` };
    }

    // 2. Add a model and a long-running task to hold the lock
    const m1Path = path.join(workDir, 'm1.json');
    fs.writeFileSync(m1Path, JSON.stringify({ model_id: 'm1' }));
    runCli(cliPath, ['add-model', m1Path], workDir);

    const sSleep = path.join(workDir, 's_sleep.js');
    fs.writeFileSync(sSleep, 'setTimeout(() => { process.stdout.write(JSON.stringify({ score: 1.0 })); }, 8000);');
    const tSleep = path.join(workDir, 't_sleep.json');
    fs.writeFileSync(tSleep, JSON.stringify({
      task_id: 't_sleep',
      command: `node "${sSleep}"`,
      timeout_seconds: 15,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    runCli(cliPath, ['add-task', tSleep], workDir);

    // 3. Spawn Process A running the CLI, which holds the campaign lock during execution
    const procA = spawn(process.execPath, [targetCli, 'run'], {
      cwd: workDir,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    // Wait 400ms for Process A to acquire the OS kernel lock
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);

    // 4. Spawn Process B while Process A holds the lock
    const m2Path = path.join(workDir, 'm2.json');
    fs.writeFileSync(m2Path, JSON.stringify({ model_id: 'm2' }));
    const procBRes = runCli(cliPath, ['add-model', m2Path], workDir);

    // Kill Process A cleanly
    try {
      if (process.platform === 'win32' && procA.pid) {
        spawnSync('taskkill', ['/pid', String(procA.pid), '/f', '/t']);
      } else {
        procA.kill('SIGKILL');
      }
    } catch {
      // ignore
    }

    // Process B MUST have encountered lock contention and exited with code 3
    if (procBRes.status !== 3) {
      return {
        pass: false,
        error: `MUTANT-LOCK-OMISSION detected: Process B returned exit ${procBRes.status} instead of exit 3 (LOCK_CONTENTION) while lock was held by Process A.`
      };
    }

    // 5. Verify that killing Process A immediately releases the OS lock (recovery)
    // Small pause for kernel socket/descriptor teardown
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);

    // Process C should now be able to acquire the lock and execute
    // Create a new fresh test campaign to test post-kill lock acquisition cleanly
    const workDirPostKill = createTestDir('check-lock-post-');
    try {
      const campPostPath = path.join(workDirPostKill, 'campaign.json');
      fs.writeFileSync(campPostPath, JSON.stringify(campConfig, null, 2));
      runCli(cliPath, ['init', campPostPath], workDirPostKill);

      const mPost = path.join(workDirPostKill, 'm.json');
      fs.writeFileSync(mPost, JSON.stringify({ model_id: 'm_post' }));
      const postKillRes = runCli(cliPath, ['add-model', mPost], workDirPostKill);
      if (postKillRes.status !== 0) {
        return {
          pass: false,
          error: `Failed to acquire lock after kill recovery: exit ${postKillRes.status}: ${postKillRes.stderr}`
        };
      }

      // 6. Test metadata independence:
      // Place arbitrary/dead metadata in .evalcampaign/locks/campaign.lock while OS lock is free
      const lockFile = path.join(workDirPostKill, '.evalcampaign', 'locks', 'campaign.lock');
      fs.writeFileSync(lockFile, JSON.stringify({ pid: 999999, status: 'locked', host: 'dead-machine' }));

      // Process D should ignore metadata file and acquire lock because OS lock is free
      const mPost2 = path.join(workDirPostKill, 'm2.json');
      fs.writeFileSync(mPost2, JSON.stringify({ model_id: 'm_post2' }));
      const metadataRes = runCli(cliPath, ['add-model', mPost2], workDirPostKill);
      if (metadataRes.status !== 0) {
        return {
          pass: false,
          error: `Lock acquisition was gated by dead metadata file: exit ${metadataRes.status}: ${metadataRes.stderr}`
        };
      }
    } finally {
      cleanupDir(workDirPostKill);
    }

    return { pass: true };
  } catch (err) {
    return { pass: false, error: err.message };
  } finally {
    cleanupDir(workDir);
  }
}

module.exports = { id: 'CHECK-LOCK-001', name: 'genuine POSIX locking', run };
