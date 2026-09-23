#!/usr/bin/env node
const path = require('path');
const projectRoot = path.resolve(__dirname, '../../../..');

// Mutate classifier: treat score 0.0 as falsy / missing / failure
const classifierMod = require(path.join(projectRoot, 'dist/src/core/execution/classifier.js'));
const origClassify = classifierMod.classifyExecution;

classifierMod.classifyExecution = function(result) {
  const orig = origClassify(result);
  if (orig.rawScore === 0 || orig.rawScore === 0.0) {
    return {
      status: 'MALFORMED_OUTPUT',
      rawScore: null
    };
  }
  return orig;
};

// Delegate to reference CLI
const { runCli } = require(path.join(projectRoot, 'dist/src/cli/index.js'));
const res = runCli(process.argv);
if (res instanceof Promise) {
  res.then(c => process.exit(c)).catch(e => { process.stderr.write(`${e.message}\n`); process.exit(1); });
} else {
  process.exit(res);
}
