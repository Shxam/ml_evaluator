#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const projectRoot = path.resolve(__dirname, '../../../..');

// Mutate rollback: overly broad deletion of manifests (removes ALL manifests in runs/)
const rollbackMod = require(path.join(projectRoot, 'dist/src/core/rollback/rollback.js'));
const origRollback = rollbackMod.rollbackCampaign;

rollbackMod.rollbackCampaign = function(n = 1, cwd = process.cwd()) {
  const { getCampaignPaths } = require(path.join(projectRoot, 'dist/src/core/storage/layout.js'));
  const paths = getCampaignPaths(cwd);
  // Broadly delete all manifests, wiping out unrelated historical manifests
  if (fs.existsSync(paths.runsDir)) {
    const files = fs.readdirSync(paths.runsDir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      try {
        fs.unlinkSync(path.join(paths.runsDir, f));
      } catch {}
    }
  }
  return origRollback(n, cwd);
};

// Delegate to reference CLI
const { runCli } = require(path.join(projectRoot, 'dist/src/cli/index.js'));
const res = runCli(process.argv);
if (res instanceof Promise) {
  res.then(c => process.exit(c)).catch(e => { process.stderr.write(`${e.message}\n`); process.exit(1); });
} else {
  process.exit(res);
}
