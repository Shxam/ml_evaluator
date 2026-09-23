#!/usr/bin/env node
const path = require('path');
const projectRoot = path.resolve(__dirname, '../../../..');

// Mutate scoring to compute unweighted mean instead of weighted mean
const scorerMod = require(path.join(projectRoot, 'dist/src/core/scoring/scorer.js'));
const origCompute = scorerMod.computeCampaignScores;

scorerMod.computeCampaignScores = function(cwd = process.cwd()) {
  const report = origCompute(cwd);
  // Break weight application: compute simple unweighted average of task scores
  for (const modelId of Object.keys(report.models)) {
    const m = report.models[modelId];
    const scores = Object.values(m.task_scores);
    const unweighted = scores.reduce((sum, s) => sum + s, 0) / (scores.length || 1);
    const rounded = Math.round(unweighted * 1e6) / 1e6;
    m.score = rounded;
    m.weighted_mean = rounded;
    m.normalized_score = rounded;
  }
  // Re-sort rankings based on unweighted score
  report.rankings.sort((a, b) => report.models[b.model_id].score - report.models[a.model_id].score);
  for (let i = 0; i < report.rankings.length; i++) {
    report.rankings[i].rank = i + 1;
    report.rankings[i].score = report.models[report.rankings[i].model_id].score;
    report.rankings[i].normalized_score = report.rankings[i].score;
  }
  return report;
};

// Delegate to reference CLI
const { runCli } = require(path.join(projectRoot, 'dist/src/cli/index.js'));
const res = runCli(process.argv);
if (res instanceof Promise) {
  res.then(c => process.exit(c)).catch(e => { process.stderr.write(`${e.message}\n`); process.exit(1); });
} else {
  process.exit(res);
}
