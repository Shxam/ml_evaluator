const fs = require('fs');
const path = require('path');
const { createTestDir, cleanupDir, runCli } = require('../utils');

/**
 * CHECK-DRIFT-001: Provenance Enforcement
 * Verifies:
 * - Detects SHA-256 drift when a registered task file is mutated on disk
 * - Exits with code 5 before launching any evaluator subprocess
 * - Fails closed on export when task provenance baseline check fails
 */
function run(cliPath) {
  const workDir = createTestDir('check-drift-001-');

  try {
    // 1. Initialize campaign
    const campConfig = {
      campaign_id: 'camp_check_drift',
      name: 'Check Provenance Drift',
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

    // 2. Add model and task
    const mPath = path.join(workDir, 'model.json');
    fs.writeFileSync(mPath, JSON.stringify({ model_id: 'm1' }));
    runCli(cliPath, ['add-model', mPath], workDir);

    const markerFile = path.join(workDir, 'evaluator_launched.marker');
    const s1 = path.join(workDir, 's1.js');
    fs.writeFileSync(
      s1,
      `const fs = require('fs'); fs.writeFileSync('${markerFile.replace(/\\/g, '/')}', 'executed'); process.stdout.write(JSON.stringify({ score: 0.9 }));`
    );

    const t1 = path.join(workDir, 't1.json');
    fs.writeFileSync(t1, JSON.stringify({
      task_id: 'task_drift_test',
      command: `node "${s1}"`,
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    runCli(cliPath, ['add-task', t1], workDir);

    // 3. Establish baseline provenance by initial run or baseline capture
    // Run campaign once so baseline is recorded
    const initialRunRes = runCli(cliPath, ['run'], workDir);
    if (initialRunRes.status !== 0) {
      return { pass: false, error: `Initial run failed: ${initialRunRes.stderr}` };
    }

    // Clean marker file
    if (fs.existsSync(markerFile)) {
      fs.unlinkSync(markerFile);
    }

    // 4. Directly mutate the registered task definition in .evalcampaign/tasks/
    const registeredTaskPath = path.join(workDir, '.evalcampaign', 'tasks', 'task_drift_test.json');
    if (!fs.existsSync(registeredTaskPath)) {
      return { pass: false, error: 'Registered task file does not exist' };
    }

    const taskData = JSON.parse(fs.readFileSync(registeredTaskPath, 'utf8'));
    taskData.timeout_seconds = 999; // Drift the task definition
    fs.writeFileSync(registeredTaskPath, JSON.stringify(taskData, null, 2));

    // 5. Subsequent execution must detect provenance drift and exit 5
    // Note: We create a second model to have pending scheduled runs
    const m2Path = path.join(workDir, 'model2.json');
    // But adding model after run is rejected (exit 4), so we test resume or export on drifted task:
    const exportRes = runCli(cliPath, ['export', '--format', 'json'], workDir);
    if (exportRes.status !== 5) {
      return {
        pass: false,
        error: `Export with drifted task provenance returned exit ${exportRes.status}, expected 5 (PROVENANCE_DRIFT)`
      };
    }

    // 6. Test run with drifted task on a new campaign
    const workDir2 = createTestDir('check-drift-run-');
    try {
      const camp2Path = path.join(workDir2, 'campaign.json');
      fs.writeFileSync(camp2Path, JSON.stringify(campConfig, null, 2));
      runCli(cliPath, ['init', camp2Path], workDir2);

      const mPath2 = path.join(workDir2, 'm.json');
      fs.writeFileSync(mPath2, JSON.stringify({ model_id: 'm1' }));
      runCli(cliPath, ['add-model', mPath2], workDir2);

      const marker2 = path.join(workDir2, 'launched.marker');
      const s2 = path.join(workDir2, 's2.js');
      fs.writeFileSync(s2, `require('fs').writeFileSync('${marker2.replace(/\\/g, '/')}', '1'); process.stdout.write(JSON.stringify({ score: 1.0 }));`);

      const t2 = path.join(workDir2, 't2.json');
      fs.writeFileSync(t2, JSON.stringify({
        task_id: 't_drift2',
        command: `node "${s2}"`,
        timeout_seconds: 5,
        weight: 1.0,
        retry_policy: { max_attempts: 1, retry_on: [] }
      }));
      runCli(cliPath, ['add-task', t2], workDir2);

      // Create fake provenance.json with mismatched baseline hash
      const provPath2 = path.join(workDir2, '.evalcampaign', 'provenance.json');
      fs.writeFileSync(provPath2, JSON.stringify({ t_drift2: '0000000000000000000000000000000000000000000000000000000000000000' }));

      // Execute run: MUST exit 5 and NEVER launch the evaluator!
      const runDriftRes = runCli(cliPath, ['run'], workDir2);
      if (runDriftRes.status !== 5) {
        return {
          pass: false,
          error: `Run with drifted task provenance returned exit ${runDriftRes.status}, expected 5 (PROVENANCE_DRIFT)`
        };
      }

      if (fs.existsSync(marker2)) {
        return {
          pass: false,
          error: 'Evaluator subprocess was executed despite provenance drift! Must fail-closed before execution.'
        };
      }
    } finally {
      cleanupDir(workDir2);
    }

    return { pass: true };
  } catch (err) {
    return { pass: false, error: err.message };
  } finally {
    cleanupDir(workDir);
  }
}

module.exports = { id: 'CHECK-DRIFT-001', name: 'provenance enforcement', run };
