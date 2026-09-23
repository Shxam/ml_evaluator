const fs = require('fs');
const path = require('path');
const { createTestDir, cleanupDir, runCli } = require('../utils');

/**
 * CHECK-EXEC-001: Evaluator Result Classification
 * Verifies observable execution classification through CLI run and manifests:
 * - exit 0 + finite score -> COMPLETED
 * - valid 0.0 score -> COMPLETED (catches falsy 0.0 bugs)
 * - non-zero exit -> EVALUATOR_CRASH
 * - timeout -> TIMEOUT
 * - malformed JSON -> MALFORMED_OUTPUT
 * - missing score -> MALFORMED_OUTPUT
 * - NaN / Infinity -> MALFORMED_OUTPUT
 */
function run(cliPath) {
  const workDir = createTestDir('check-exec-001-');

  try {
    // 1. Initialize campaign
    const campConfig = {
      campaign_id: 'camp_check_exec',
      name: 'Check Exec Classification',
      repetitions: 1,
      budget: { max_wall_time_seconds: 60, max_total_attempts: 20, max_output_bytes: 4096 },
      scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));

    const initRes = runCli(cliPath, ['init', campPath], workDir);
    if (initRes.status !== 0) {
      return { pass: false, error: `Init failed with exit ${initRes.status}: ${initRes.stderr}` };
    }

    // 2. Add model
    const modelPath = path.join(workDir, 'model.json');
    fs.writeFileSync(modelPath, JSON.stringify({ model_id: 'm1' }));
    const addModelRes = runCli(cliPath, ['add-model', modelPath], workDir);
    if (addModelRes.status !== 0) {
      return { pass: false, error: `Add model failed: ${addModelRes.stderr}` };
    }

    // 3. Define tasks
    // Task A: normal positive score
    const sNormal = path.join(workDir, 'task_normal.js');
    fs.writeFileSync(sNormal, 'process.stdout.write(JSON.stringify({ score: 0.85 }));');
    const tNormal = path.join(workDir, 't_normal.json');
    fs.writeFileSync(tNormal, JSON.stringify({
      task_id: 't_normal',
      command: `node "${sNormal}"`,
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    runCli(cliPath, ['add-task', tNormal], workDir);

    // Task B: score 0.0 (legitimate zero score!)
    const sZero = path.join(workDir, 'task_zero.js');
    fs.writeFileSync(sZero, 'process.stdout.write(JSON.stringify({ score: 0.0 }));');
    const tZero = path.join(workDir, 't_zero.json');
    fs.writeFileSync(tZero, JSON.stringify({
      task_id: 't_zero',
      command: `node "${sZero}"`,
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    runCli(cliPath, ['add-task', tZero], workDir);

    // Task C: evaluator crash (non-zero exit)
    const sCrash = path.join(workDir, 'task_crash.js');
    fs.writeFileSync(sCrash, 'process.stderr.write("Fatal crash"); process.exit(2);');
    const tCrash = path.join(workDir, 't_crash.json');
    fs.writeFileSync(tCrash, JSON.stringify({
      task_id: 't_crash',
      command: `node "${sCrash}"`,
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    runCli(cliPath, ['add-task', tCrash], workDir);

    // Task D: timeout
    const sTimeout = path.join(workDir, 'task_timeout.js');
    fs.writeFileSync(sTimeout, 'setTimeout(() => {}, 5000);');
    const tTimeout = path.join(workDir, 't_timeout.json');
    fs.writeFileSync(tTimeout, JSON.stringify({
      task_id: 't_timeout',
      command: `node "${sTimeout}"`,
      timeout_seconds: 1,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    runCli(cliPath, ['add-task', tTimeout], workDir);

    // Task E: malformed JSON
    const sMalformed = path.join(workDir, 'task_malformed.js');
    fs.writeFileSync(sMalformed, 'process.stdout.write("{not valid json");');
    const tMalformed = path.join(workDir, 't_malformed.json');
    fs.writeFileSync(tMalformed, JSON.stringify({
      task_id: 't_malformed',
      command: `node "${sMalformed}"`,
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    runCli(cliPath, ['add-task', tMalformed], workDir);

    // Task F: missing score
    const sMissing = path.join(workDir, 'task_missing.js');
    fs.writeFileSync(sMissing, 'process.stdout.write(JSON.stringify({ status: "ok" }));');
    const tMissing = path.join(workDir, 't_missing.json');
    fs.writeFileSync(tMissing, JSON.stringify({
      task_id: 't_missing',
      command: `node "${sMissing}"`,
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    runCli(cliPath, ['add-task', tMissing], workDir);

    // Task G: NaN score
    const sNan = path.join(workDir, 'task_nan.js');
    fs.writeFileSync(sNan, 'process.stdout.write(JSON.stringify({ score: "NaN" }));');
    const tNan = path.join(workDir, 't_nan.json');
    fs.writeFileSync(tNan, JSON.stringify({
      task_id: 't_nan',
      command: `node "${sNan}"`,
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    runCli(cliPath, ['add-task', tNan], workDir);

    // 4. Execute campaign
    const runRes = runCli(cliPath, ['run'], workDir);
    if (runRes.status !== 0) {
      return { pass: false, error: `Run command failed with exit ${runRes.status}: ${runRes.stderr}` };
    }

    // 5. Inspect manifests in .evalcampaign/runs/
    const runsDir = path.join(workDir, '.evalcampaign', 'runs');
    if (!fs.existsSync(runsDir)) {
      return { pass: false, error: 'Runs directory was not created' };
    }

    const manifestFiles = fs.readdirSync(runsDir).filter(f => f.endsWith('.json'));
    const manifestsByTask = {};
    for (const f of manifestFiles) {
      const data = JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8'));
      manifestsByTask[data.task_id] = data;
    }

    // Check Task A (normal)
    if (!manifestsByTask['t_normal'] || manifestsByTask['t_normal'].status !== 'COMPLETED' || manifestsByTask['t_normal'].raw_score !== 0.85) {
      return { pass: false, error: `t_normal: expected COMPLETED with 0.85, got ${JSON.stringify(manifestsByTask['t_normal'])}` };
    }

    // Check Task B (valid 0.0 score!) - CRITICAL GATE
    const zeroManifest = manifestsByTask['t_zero'];
    if (!zeroManifest) {
      return { pass: false, error: 't_zero manifest missing' };
    }
    if (zeroManifest.status !== 'COMPLETED' || zeroManifest.raw_score !== 0.0) {
      return {
        pass: false,
        error: `t_zero treated as failure/missing: status=${zeroManifest.status}, raw_score=${zeroManifest.raw_score} (expected COMPLETED with 0.0)`
      };
    }

    // Check Task C (crash)
    if (!manifestsByTask['t_crash'] || manifestsByTask['t_crash'].status !== 'EVALUATOR_CRASH') {
      return { pass: false, error: `t_crash: expected EVALUATOR_CRASH, got ${manifestsByTask['t_crash']?.status}` };
    }

    // Check Task D (timeout)
    if (!manifestsByTask['t_timeout'] || manifestsByTask['t_timeout'].status !== 'TIMEOUT') {
      return { pass: false, error: `t_timeout: expected TIMEOUT, got ${manifestsByTask['t_timeout']?.status}` };
    }

    // Check Task E (malformed JSON)
    if (!manifestsByTask['t_malformed'] || manifestsByTask['t_malformed'].status !== 'MALFORMED_OUTPUT') {
      return { pass: false, error: `t_malformed: expected MALFORMED_OUTPUT, got ${manifestsByTask['t_malformed']?.status}` };
    }

    // Check Task F (missing score)
    if (!manifestsByTask['t_missing'] || manifestsByTask['t_missing'].status !== 'MALFORMED_OUTPUT') {
      return { pass: false, error: `t_missing: expected MALFORMED_OUTPUT, got ${manifestsByTask['t_missing']?.status}` };
    }

    // Check Task G (NaN score)
    if (!manifestsByTask['t_nan'] || manifestsByTask['t_nan'].status !== 'MALFORMED_OUTPUT') {
      return { pass: false, error: `t_nan: expected MALFORMED_OUTPUT, got ${manifestsByTask['t_nan']?.status}` };
    }

    return { pass: true };
  } catch (err) {
    return { pass: false, error: err.message };
  } finally {
    cleanupDir(workDir);
  }
}

module.exports = { id: 'CHECK-EXEC-001', name: 'evaluator result classification', run };
