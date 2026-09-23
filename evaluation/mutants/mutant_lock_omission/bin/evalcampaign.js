#!/usr/bin/env node
const path = require('path');
const projectRoot = path.resolve(__dirname, '../../../..');

// Mutate concurrency locking: omit genuine POSIX kernel locking
const lockMod = require(path.join(projectRoot, 'dist/src/core/concurrency/lock.js'));

// Non-authoritative no-op lock
lockMod.withCampaignLock = function(fn, cwd) {
  // Omission of kernel locking: directly runs fn without acquiring kernel lock
  return fn();
};

lockMod.acquireCampaignLock = function(cwd) {
  return {
    handle: { fd: 9999, lockPath: 'dummy' },
    release: () => {}
  };
};

lockMod.posixFlock = function() {
  // No-op
};

// Delegate to reference CLI
const { runCli } = require(path.join(projectRoot, 'dist/src/cli/index.js'));
const res = runCli(process.argv);
if (res instanceof Promise) {
  res.then(c => process.exit(c)).catch(e => { process.stderr.write(`${e.message}\n`); process.exit(1); });
} else {
  process.exit(res);
}
