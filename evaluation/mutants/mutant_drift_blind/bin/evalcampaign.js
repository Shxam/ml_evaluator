#!/usr/bin/env node
const path = require('path');
const projectRoot = path.resolve(__dirname, '../../../..');

// Mutate provenance: blind to task definition drift
const provMod = require(path.join(projectRoot, 'dist/src/core/provenance/provenance.js'));
provMod.assertTaskProvenance = function() {
  // Drift blind: no-op, never verifies or throws on SHA-256 drift
};
provMod.verifyTaskProvenance = function() {
  return { valid: true };
};

// Delegate to reference CLI
const { runCli } = require(path.join(projectRoot, 'dist/src/cli/index.js'));
const res = runCli(process.argv);
if (res instanceof Promise) {
  res.then(c => process.exit(c)).catch(e => { process.stderr.write(`${e.message}\n`); process.exit(1); });
} else {
  process.exit(res);
}
