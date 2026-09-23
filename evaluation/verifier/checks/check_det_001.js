const fs = require('fs');
const path = require('path');
const { createTestDir, cleanupDir, runCli } = require('../utils');

/**
 * Recursively checks if all object keys in parsed JSON are strictly sorted lexicographically.
 */
function areKeysSorted(obj) {
  if (obj === null || typeof obj !== 'object') {
    return true;
  }
  if (Array.isArray(obj)) {
    return obj.every(areKeysSorted);
  }
  const keys = Object.keys(obj);
  const sorted = [...keys].sort();
  for (let i = 0; i < keys.length; i++) {
    if (keys[i] !== sorted[i]) {
      return false;
    }
  }
  return Object.values(obj).every(areKeysSorted);
}

/**
 * CHECK-DET-001: Deterministic Output
 * Verifies:
 * - Repeated executions of status --json, score, and export --format json against unchanged
 *   campaign state produce byte-for-byte identical output
 * - Canonical deterministic key sorting is strictly observed
 * - Output contains no dynamic timestamps, PIDs, or host-specific absolute paths
 */
function run(cliPath) {
  const workDir = createTestDir('check-det-001-');

  try {
    // 1. Initialize campaign with multiple models and tasks
    const campConfig = {
      campaign_id: 'camp_check_det',
      name: 'Check Deterministic Output',
      repetitions: 2,
      budget: { max_wall_time_seconds: 60, max_total_attempts: 20, max_output_bytes: 4096 },
      scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));

    runCli(cliPath, ['init', campPath], workDir);

    // Register models in reverse order
    for (const m of ['model_z', 'model_a']) {
      const mPath = path.join(workDir, `${m}.json`);
      fs.writeFileSync(mPath, JSON.stringify({ model_id: m }));
      runCli(cliPath, ['add-model', mPath], workDir);
    }

    // Register tasks
    for (const t of ['task_beta', 'task_alpha']) {
      const s = path.join(workDir, `${t}.js`);
      fs.writeFileSync(s, 'process.stdout.write(JSON.stringify({ score: 0.75 }));');
      const tPath = path.join(workDir, `${t}.json`);
      fs.writeFileSync(tPath, JSON.stringify({
        task_id: t,
        command: `node "${s}"`,
        timeout_seconds: 5,
        weight: 1.0,
        retry_policy: { max_attempts: 1, retry_on: [] }
      }));
      runCli(cliPath, ['add-task', tPath], workDir);
    }

    // Execute run to completion
    const runRes = runCli(cliPath, ['run'], workDir);
    if (runRes.status !== 0) {
      return { pass: false, error: `Run failed: ${runRes.stderr}` };
    }

    // 2. Test status --json determinism
    const statusOutputs = [];
    for (let i = 0; i < 3; i++) {
      const res = runCli(cliPath, ['status', '--json'], workDir);
      if (res.status !== 0) {
        return { pass: false, error: `status --json failed: ${res.stderr}` };
      }
      statusOutputs.push(res.stdout);
    }
    if (statusOutputs[0] !== statusOutputs[1] || statusOutputs[1] !== statusOutputs[2]) {
      return { pass: false, error: 'status --json outputs differ across repeated runs against identical state' };
    }
    const parsedStatus = JSON.parse(statusOutputs[0]);
    if (!areKeysSorted(parsedStatus)) {
      return { pass: false, error: 'status --json output keys are not lexicographically sorted' };
    }

    // 3. Test score determinism
    const scoreOutputs = [];
    for (let i = 0; i < 3; i++) {
      const res = runCli(cliPath, ['score'], workDir);
      if (res.status !== 0) {
        return { pass: false, error: `score failed: ${res.stderr}` };
      }
      scoreOutputs.push(res.stdout);
    }
    if (scoreOutputs[0] !== scoreOutputs[1] || scoreOutputs[1] !== scoreOutputs[2]) {
      return { pass: false, error: 'score outputs differ across repeated runs against identical state' };
    }
    const parsedScore = JSON.parse(scoreOutputs[0]);
    if (!areKeysSorted(parsedScore)) {
      return { pass: false, error: 'score output keys are not lexicographically sorted' };
    }

    // 4. Test export --format json determinism
    const exportOutputs = [];
    for (let i = 0; i < 3; i++) {
      const res = runCli(cliPath, ['export', '--format', 'json'], workDir);
      if (res.status !== 0) {
        return { pass: false, error: `export failed: ${res.stderr}` };
      }
      exportOutputs.push(res.stdout);
    }
    if (exportOutputs[0] !== exportOutputs[1] || exportOutputs[1] !== exportOutputs[2]) {
      return { pass: false, error: 'export --format json outputs differ across repeated runs against identical state' };
    }
    const parsedExport = JSON.parse(exportOutputs[0]);
    if (!areKeysSorted(parsedExport)) {
      return { pass: false, error: 'export --format json output keys are not lexicographically sorted' };
    }

    // 5. Verify no host-specific absolute paths or temporary filenames leak into export
    const exportStr = exportOutputs[0];
    if (exportStr.includes(workDir)) {
      return { pass: false, error: 'Host-specific absolute workspace paths leaked into export output' };
    }

    return { pass: true };
  } catch (err) {
    return { pass: false, error: err.message };
  } finally {
    cleanupDir(workDir);
  }
}

module.exports = { id: 'CHECK-DET-001', name: 'deterministic output', run };
