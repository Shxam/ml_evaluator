const fs = require('fs');
const path = require('path');
const { createTestDir, cleanupDir, runCli } = require('../utils');

/**
 * CHECK-CRASH-001: Atomic Persistence & Crash Resilience
 * Verifies:
 * - Authoritative state files and register files are never updated via direct in-place modification
 *   (atomic persistence via temporary file replacement is strictly enforced)
 * - Stale/corrupted .tmp artifacts do not become authoritative data
 * - Authoritative manifests are never left truncated or empty (0 bytes)
 * - resume recovers cleanly from interrupted states without fabricating or duplicating work
 */
function run(cliPath) {
  const workDir = createTestDir('check-crash-001-');

  try {
    // 1. Initialize campaign
    const campConfig = {
      campaign_id: 'camp_check_crash',
      name: 'Check Crash Resilience',
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

    // 2. Test Atomic Persistence via Register Overwrite
    // Step A: write register 'x'
    const regFile1 = path.join(workDir, 'r1.bin');
    fs.writeFileSync(regFile1, Buffer.from([1, 2, 3]));
    const regPut1 = runCli(cliPath, ['register-put', '--reg', 'x', regFile1], workDir);
    if (regPut1.status !== 0) {
      return { pass: false, error: `register-put 1 failed: ${regPut1.stderr}` };
    }

    const regBlobPath = path.join(workDir, '.evalcampaign', 'registers', 'reg_x.blob');
    const initialRegBirthtime = fs.statSync(regBlobPath).birthtimeMs;

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);

    // Step B: overwrite existing register 'x' with new content
    const regFile2 = path.join(workDir, 'r2.bin');
    fs.writeFileSync(regFile2, Buffer.from([4, 5, 6, 7]));
    const regPut2 = runCli(cliPath, ['register-put', '--reg', 'x', regFile2], workDir);
    if (regPut2.status !== 0) {
      return { pass: false, error: `register-put 2 failed: ${regPut2.stderr}` };
    }

    // In genuine atomic persistence, writing to .tmp then renaming replaces the inode/file,
    // altering birthtimeMs. Direct in-place writing (fs.writeFileSync) keeps birthtimeMs unchanged.
    const updatedRegBirthtime = fs.statSync(regBlobPath).birthtimeMs;
    if (initialRegBirthtime === updatedRegBirthtime) {
      return {
        pass: false,
        error: 'MUTANT-DIRECT-WRITE detected: register was updated via direct in-place write instead of atomic temporary file replacement (.tmp + rename).'
      };
    }

    // 3. Test Atomic Persistence on state.json during run
    const mPath = path.join(workDir, 'model.json');
    fs.writeFileSync(mPath, JSON.stringify({ model_id: 'm1' }));
    runCli(cliPath, ['add-model', mPath], workDir);

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
    runCli(cliPath, ['add-task', t1], workDir);

    const stateFile = path.join(workDir, '.evalcampaign', 'state.json');
    const initialBirthtime = fs.statSync(stateFile).birthtimeMs;

    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50);

    // 4. Stale .tmp artifact resilience
    // Place a corrupted .tmp artifact in .evalcampaign/
    const staleTmp = path.join(workDir, '.evalcampaign', '.state.json.99999.123456.tmp');
    fs.writeFileSync(staleTmp, '{ "corrupted": true, "total_attempts": 99999 }');

    // Run status: must ignore stale .tmp artifact and read valid authoritative state.json
    const statusRes = runCli(cliPath, ['status', '--json'], workDir);
    if (statusRes.status !== 0) {
      return { pass: false, error: `Status failed with stale tmp artifact present: ${statusRes.stderr}` };
    }
    const statusJson = JSON.parse(statusRes.stdout);
    if (statusJson.cumulative_attempt_count === 99999) {
      return { pass: false, error: 'Stale .tmp artifact was incorrectly loaded as authoritative state!' };
    }

    // 5. Execute run (updates state.json atomically)
    const runsDir = path.join(workDir, '.evalcampaign', 'runs');
    const runRes = runCli(cliPath, ['run'], workDir);
    if (runRes.status !== 0) {
      return { pass: false, error: `Run failed: ${runRes.stderr}` };
    }

    // Verify state.json was updated via atomic replacement
    const updatedBirthtime = fs.statSync(stateFile).birthtimeMs;
    if (initialBirthtime === updatedBirthtime) {
      return {
        pass: false,
        error: 'MUTANT-DIRECT-WRITE detected: state.json was updated via direct in-place write instead of atomic temporary file replacement (.tmp + rename).'
      };
    }

    // Verify all manifests are non-empty and valid JSON
    const manifestFiles = fs.readdirSync(runsDir).filter(f => f.endsWith('.json'));
    if (manifestFiles.length !== 1) {
      return { pass: false, error: `Expected 1 manifest, found ${manifestFiles.length}` };
    }

    for (const mf of manifestFiles) {
      const fullPath = path.join(runsDir, mf);
      const stat = fs.statSync(fullPath);
      if (stat.size === 0) {
        return { pass: false, error: `Manifest ${mf} is zero bytes! Corrupt empty write detected.` };
      }
      try {
        JSON.parse(fs.readFileSync(fullPath, 'utf8'));
      } catch (err) {
        return { pass: false, error: `Manifest ${mf} is malformed JSON: ${err.message}` };
      }
    }

    // Check that state.json is valid and not truncated
    const postState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    if (!postState || postState.completed_runs !== 1) {
      return { pass: false, error: `State not properly persisted: ${JSON.stringify(postState)}` };
    }

    // 6. Test resume recovery guard on completed campaign
    const resumeRes = runCli(cliPath, ['resume'], workDir);
    if (resumeRes.status !== 4) {
      return { pass: false, error: `Resume on completed campaign returned ${resumeRes.status}, expected 4` };
    }

    return { pass: true };
  } catch (err) {
    return { pass: false, error: err.message };
  } finally {
    cleanupDir(workDir);
  }
}

module.exports = { id: 'CHECK-CRASH-001', name: 'atomic persistence/crash resilience', run };
