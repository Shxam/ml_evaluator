#!/usr/bin/env node
const path = require('path');
const projectRoot = path.resolve(__dirname, '../../../..');

// Mutate resumer to permit resume on completed campaigns
const resumerMod = require(path.join(projectRoot, 'dist/src/core/execution/resumer.js'));
const origResume = resumerMod.resumeCampaign;

resumerMod.resumeCampaign = async function(cwd = process.cwd()) {
  const { isCampaignInitialized, getCampaignPaths } = require(path.join(projectRoot, 'dist/src/core/storage/layout.js'));
  const { readJson } = require(path.join(projectRoot, 'dist/src/core/storage/atomic.js'));
  if (isCampaignInitialized(cwd)) {
    const paths = getCampaignPaths(cwd);
    try {
      const state = readJson(paths.stateJson);
      // Permissive: if completed, allow resume by returning success instead of exit 4
      if (state.lifecycle_state === 'completed') {
        process.stdout.write(`Campaign "${state.campaign_id}" resumed successfully (permissive).\n`);
        return {
          exitCode: 0,
          totalAttempts: state.total_attempts || 0,
          completedRuns: state.completed_runs || 0
        };
      }
    } catch {}
  }
  return origResume(cwd);
};

// Delegate to reference CLI
const { runCli } = require(path.join(projectRoot, 'dist/src/cli/index.js'));
const res = runCli(process.argv);
if (res instanceof Promise) {
  res.then(c => process.exit(c)).catch(e => { process.stderr.write(`${e.message}\n`); process.exit(1); });
} else {
  process.exit(res);
}
