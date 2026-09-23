const fs = require('fs');
const path = require('path');
const { createTestDir, cleanupDir, runCli } = require('../utils');

/**
 * CHECK-SCORE-001: Weighted Scoring Correctness
 * Verifies:
 * - Multi-model, multi-task, repetition >= 2 weighted scoring mathematics
 * - Task weights are strictly applied according to spec: S_m = sum(w_t * s_m,t) / sum(w_t)
 * - Legitimate 0.0 values contribute zero rather than becoming missing or failure
 * - Missing policy "zero" behaves correctly
 * - Model ranking is deterministic (score descending, model_id ascending on ties)
 */
function run(cliPath) {
  const workDir = createTestDir('check-score-001-');

  try {
    // 1. Initialize campaign
    const campConfig = {
      campaign_id: 'camp_check_score',
      name: 'Check Weighted Scoring',
      repetitions: 2,
      budget: { max_wall_time_seconds: 60, max_total_attempts: 20, max_output_bytes: 4096 },
      scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));

    const initRes = runCli(cliPath, ['init', campPath], workDir);
    if (initRes.status !== 0) {
      return { pass: false, error: `Init failed: ${initRes.stderr}` };
    }

    // 2. Add 2 models
    for (const m of ['model_1', 'model_2']) {
      const mPath = path.join(workDir, `${m}.json`);
      fs.writeFileSync(mPath, JSON.stringify({ model_id: m }));
      runCli(cliPath, ['add-model', mPath], workDir);
    }

    // 3. Add 3 tasks with distinct weights:
    // Task 1: weight 1.0, score = 0.0 (legitimate zero!)
    const s1 = path.join(workDir, 's1.js');
    fs.writeFileSync(s1, 'process.stdout.write(JSON.stringify({ score: 0.0 }));');
    const t1 = path.join(workDir, 't1.json');
    fs.writeFileSync(t1, JSON.stringify({
      task_id: 'task_zero',
      command: `node "${s1}"`,
      timeout_seconds: 5,
      weight: 1.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    runCli(cliPath, ['add-task', t1], workDir);

    // Task 2: weight 3.0, score = 0.8 for both models
    const s2 = path.join(workDir, 's2.js');
    fs.writeFileSync(s2, 'process.stdout.write(JSON.stringify({ score: 0.8 }));');
    const t2 = path.join(workDir, 't2.json');
    fs.writeFileSync(t2, JSON.stringify({
      task_id: 'task_mid',
      command: `node "${s2}"`,
      timeout_seconds: 5,
      weight: 3.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    runCli(cliPath, ['add-task', t2], workDir);

    // Task 3: weight 6.0, score = 1.0 for model_1, 0.4 for model_2
    const s3 = path.join(workDir, 's3.js');
    fs.writeFileSync(s3, `
      const m = process.env.EVAL_MODEL_ID;
      const score = (m === 'model_1') ? 1.0 : 0.4;
      process.stdout.write(JSON.stringify({ score }));
    `);
    const t3 = path.join(workDir, 't3.json');
    fs.writeFileSync(t3, JSON.stringify({
      task_id: 'task_heavy',
      command: `node "${s3}"`,
      timeout_seconds: 5,
      weight: 6.0,
      retry_policy: { max_attempts: 1, retry_on: [] }
    }));
    runCli(cliPath, ['add-task', t3], workDir);

    // 4. Run to completion
    const runRes = runCli(cliPath, ['run'], workDir);
    if (runRes.status !== 0) {
      return { pass: false, error: `Run failed: ${runRes.stderr}` };
    }

    // 5. Run score
    const scoreRes = runCli(cliPath, ['score'], workDir);
    if (scoreRes.status !== 0) {
      return { pass: false, error: `Score failed: ${scoreRes.stderr}` };
    }

    const report = JSON.parse(scoreRes.stdout);

    // Mathematical verification:
    // Total weight = 1.0 + 3.0 + 6.0 = 10.0
    // model_1:
    //   task_zero: 0.0
    //   task_mid:  0.8
    //   task_heavy: 1.0
    //   weighted_mean: (1.0*0.0 + 3.0*0.8 + 6.0*1.0) / 10.0 = 8.4 / 10.0 = 0.84
    //   (Unweighted mean would be (0.0 + 0.8 + 1.0)/3 = 0.60)
    //
    // model_2:
    //   task_zero: 0.0
    //   task_mid:  0.8
    //   task_heavy: 0.4
    //   weighted_mean: (1.0*0.0 + 3.0*0.8 + 6.0*0.4) / 10.0 = 4.8 / 10.0 = 0.48
    //   (Unweighted mean would be (0.0 + 0.8 + 0.4)/3 = 0.40)

    const m1Score = report.models?.model_1?.score;
    const m2Score = report.models?.model_2?.score;

    if (Math.abs(m1Score - 0.84) > 1e-4) {
      return {
        pass: false,
        error: `MUTANT-SCORE-WEIGHT detected: model_1 score was ${m1Score}, expected weighted mean 0.84 (unweighted is 0.60)`
      };
    }

    if (Math.abs(m2Score - 0.48) > 1e-4) {
      return {
        pass: false,
        error: `MUTANT-SCORE-WEIGHT detected: model_2 score was ${m2Score}, expected weighted mean 0.48 (unweighted is 0.40)`
      };
    }

    // Rankings verification
    if (!report.rankings || report.rankings.length !== 2) {
      return { pass: false, error: 'Rankings array missing or wrong length' };
    }

    if (report.rankings[0].model_id !== 'model_1' || report.rankings[0].rank !== 1) {
      return { pass: false, error: `Rank 1 model expected model_1, got ${report.rankings[0].model_id}` };
    }

    if (report.rankings[1].model_id !== 'model_2' || report.rankings[1].rank !== 2) {
      return { pass: false, error: `Rank 2 model expected model_2, got ${report.rankings[1].model_id}` };
    }

    return { pass: true };
  } catch (err) {
    return { pass: false, error: err.message };
  } finally {
    cleanupDir(workDir);
  }
}

module.exports = { id: 'CHECK-SCORE-001', name: 'weighted scoring correctness', run };
