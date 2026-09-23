const fs = require('fs');
const path = require('path');
const { createTestDir, cleanupDir, runCli } = require('../utils');

/**
 * CHECK-STATE-001: Lifecycle Guards
 * Verifies:
 * - resume on a completed campaign is rejected with exit code 4 (INVALID_STATE)
 * - task/model registration is rejected with exit code 4 after execution has commenced
 * - score rejects incomplete campaigns with exit code 4
 * - rollback rejects attempts to roll back past the initial revision with exit code 4
 * - invalid lifecycle transitions fail closed
 */
function run(cliPath) {
  const workDir = createTestDir('check-state-001-');

  try {
    // 1. Initialize campaign
    const campConfig = {
      campaign_id: 'camp_check_state',
      name: 'Check Lifecycle Guards',
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

    // 2. Fresh campaign guards:
    // Scoring before runs are complete must fail with exit 4
    const earlyScoreRes = runCli(cliPath, ['score'], workDir);
    if (earlyScoreRes.status !== 4) {
      return { pass: false, error: `Score on unexecuted campaign returned exit ${earlyScoreRes.status}, expected 4` };
    }

    // Rollback with 0 completed batches must fail with exit 4
    const earlyRollbackRes = runCli(cliPath, ['rollback', '1'], workDir);
    if (earlyRollbackRes.status !== 4) {
      return { pass: false, error: `Rollback on fresh campaign returned exit ${earlyRollbackRes.status}, expected 4` };
    }

    // 3. Configure campaign
    const m1Path = path.join(workDir, 'm1.json');
    fs.writeFileSync(m1Path, JSON.stringify({ model_id: 'm1' }));
    runCli(cliPath, ['add-model', m1Path], workDir);

    const s1 = path.join(workDir, 's1.js');
    fs.writeFileSync(s1, 'process.stdout.write(JSON.stringify({ score: 1.0 }));');
    const t1Path = path.join(workDir, 't1.json');
    fs.writeFileSync(t1Path, JSON.stringify({
      task_id: 't1',
      command: `node "${s1}"`,
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    runCli(cliPath, ['add-task', t1Path], workDir);

    // 4. Run to completion
    const runRes = runCli(cliPath, ['run'], workDir);
    if (runRes.status !== 0) {
      return { pass: false, error: `Run failed: ${runRes.stderr}` };
    }

    // 5. Post-completion guards:
    // Resume on completed campaign MUST be rejected with exit code 4 (CRITICAL GATE FOR MUTANT-PERMISSIVE-RESUME)
    const resumeRes = runCli(cliPath, ['resume'], workDir);
    if (resumeRes.status !== 4) {
      return {
        pass: false,
        error: `MUTANT-PERMISSIVE-RESUME detected: resume on completed campaign returned exit ${resumeRes.status}, expected 4 (INVALID_STATE)`
      };
    }

    // add-task on completed campaign MUST be rejected with exit code 4
    const lateTaskPath = path.join(workDir, 't_late.json');
    fs.writeFileSync(lateTaskPath, JSON.stringify({
      task_id: 't_late',
      command: 'echo 1',
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    const lateTaskRes = runCli(cliPath, ['add-task', lateTaskPath], workDir);
    if (lateTaskRes.status !== 4) {
      return { pass: false, error: `add-task on completed campaign returned exit ${lateTaskRes.status}, expected 4` };
    }

    // add-model on completed campaign MUST be rejected with exit code 4
    const lateModelPath = path.join(workDir, 'm_late.json');
    fs.writeFileSync(lateModelPath, JSON.stringify({ model_id: 'm_late' }));
    const lateModelRes = runCli(cliPath, ['add-model', lateModelPath], workDir);
    if (lateModelRes.status !== 4) {
      return { pass: false, error: `add-model on completed campaign returned exit ${lateModelRes.status}, expected 4` };
    }

    return { pass: true };
  } catch (err) {
    return { pass: false, error: err.message };
  } finally {
    cleanupDir(workDir);
  }
}

module.exports = { id: 'CHECK-STATE-001', name: 'lifecycle guards', run };
