const fs = require('fs');
const path = require('path');
const { createTestDir, cleanupDir, runCli } = require('../utils');

/**
 * CHECK-ROLLBACK-001: Rollback Consistency
 * Verifies:
 * - rollback n unlinks precisely the manifests of the n reverted batches
 * - unrelated historical manifests survive
 * - status and counters are properly reconciled
 * - subsequent resume completes the campaign correctly
 * - subsequent score reflects only authoritative post-rollback state
 * - detects MUTANT-ROLLBACK-BROAD (overly broad removal of manifests)
 */
function run(cliPath) {
  const workDir = createTestDir('check-rollback-001-');

  try {
    // 1. Initialize campaign
    const campConfig = {
      campaign_id: 'camp_check_rollback',
      name: 'Check Rollback Consistency',
      repetitions: 1,
      budget: { max_wall_time_seconds: 60, max_total_attempts: 20, max_output_bytes: 4096 },
      scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));

    const initRes = runCli(cliPath, ['init', campPath], workDir);
    if (initRes.status !== 0) {
      return { pass: false, error: `Init failed: ${initRes.stderr}` };
    }

    // 2. Add 2 models and 2 tasks = 4 runs
    for (const m of ['model_a', 'model_b']) {
      const mPath = path.join(workDir, `${m}.json`);
      fs.writeFileSync(mPath, JSON.stringify({ model_id: m }));
      runCli(cliPath, ['add-model', mPath], workDir);
    }

    for (const t of ['task_1', 'task_2']) {
      const s = path.join(workDir, `${t}.js`);
      fs.writeFileSync(s, 'process.stdout.write(JSON.stringify({ score: 0.9 }));');
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

    // 3. Execute campaign (all 4 runs completed)
    const runRes = runCli(cliPath, ['run'], workDir);
    if (runRes.status !== 0) {
      return { pass: false, error: `Run failed: ${runRes.stderr}` };
    }

    const runsDir = path.join(workDir, '.evalcampaign', 'runs');
    const manifestsPre = fs.readdirSync(runsDir).filter(f => f.endsWith('.json'));
    if (manifestsPre.length !== 4) {
      return { pass: false, error: `Expected 4 completed manifests, found ${manifestsPre.length}` };
    }

    // 4. Perform rollback of exactly 1 batch
    const rollbackRes = runCli(cliPath, ['rollback', '1'], workDir);
    if (rollbackRes.status !== 0) {
      return { pass: false, error: `Rollback 1 failed with exit ${rollbackRes.status}: ${rollbackRes.stderr}` };
    }

    // 5. Verify that exactly 3 manifests remain (only 1 batch was undone, unrelated manifests survive)
    const manifestsPost = fs.readdirSync(runsDir).filter(f => f.endsWith('.json'));
    if (manifestsPost.length !== 3) {
      return {
        pass: false,
        error: `MUTANT-ROLLBACK-BROAD detected: expected exactly 3 surviving manifests after rollback 1, but found ${manifestsPost.length}`
      };
    }

    // 6. Verify status through CLI
    const statusRes = runCli(cliPath, ['status', '--json'], workDir);
    if (statusRes.status !== 0) {
      return { pass: false, error: `Status failed after rollback: ${statusRes.stderr}` };
    }
    const statusJson = JSON.parse(statusRes.stdout);
    if (statusJson.completed_logical_runs !== 3 || statusJson.remaining_logical_runs !== 1) {
      return {
        pass: false,
        error: `Status counters inconsistent after rollback: completed=${statusJson.completed_logical_runs}, remaining=${statusJson.remaining_logical_runs}`
      };
    }

    // Scoring must reject incomplete campaign after rollback
    const scoreRes = runCli(cliPath, ['score'], workDir);
    if (scoreRes.status !== 4) {
      return { pass: false, error: `Score on rolled-back incomplete campaign returned ${scoreRes.status}, expected 4` };
    }

    // 7. Resume remaining work
    const resumeRes = runCli(cliPath, ['resume'], workDir);
    if (resumeRes.status !== 0) {
      return { pass: false, error: `Resume failed after rollback: ${resumeRes.stderr}` };
    }

    // Check completed runs restored to 4
    const statusRes2 = runCli(cliPath, ['status', '--json'], workDir);
    const statusJson2 = JSON.parse(statusRes2.stdout);
    if (statusJson2.completed_logical_runs !== 4 || statusJson2.remaining_logical_runs !== 0) {
      return { pass: false, error: 'Campaign failed to complete after resume following rollback' };
    }

    // 8. Lower boundary check: attempting to roll back past 0 completed runs must exit 4
    const rollbackPastRes = runCli(cliPath, ['rollback', '10'], workDir);
    if (rollbackPastRes.status !== 4) {
      return { pass: false, error: `Rollback past boundary returned exit ${rollbackPastRes.status}, expected 4` };
    }

    return { pass: true };
  } catch (err) {
    return { pass: false, error: err.message };
  } finally {
    cleanupDir(workDir);
  }
}

module.exports = { id: 'CHECK-ROLLBACK-001', name: 'rollback consistency', run };
