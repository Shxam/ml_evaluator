#!/usr/bin/env node
const path = require('path');
const projectRoot = path.resolve(__dirname, '../../../..');

// Helper to reverse object keys recursively
function reverseObjectKeys(val) {
  if (val === null || typeof val !== 'object') {
    return val;
  }
  if (Array.isArray(val)) {
    return val.map(reverseObjectKeys);
  }
  const reversed = {};
  const keys = Object.keys(val).reverse();
  for (const k of keys) {
    reversed[k] = reverseObjectKeys(val[k]);
  }
  return reversed;
}

// Mutate deterministic JSON serialization
const atomicMod = require(path.join(projectRoot, 'dist/src/core/storage/atomic.js'));
atomicMod.toDeterministicJson = function(obj, indent = 2) {
  return JSON.stringify(reverseObjectKeys(obj), null, indent);
};

const jsonMod = require(path.join(projectRoot, 'dist/src/core/storage/json.js'));
jsonMod.toDeterministicJson = function(obj, indent = 2) {
  return JSON.stringify(reverseObjectKeys(obj), null, indent);
};

const exportMod = require(path.join(projectRoot, 'dist/src/core/export/exporter.js'));
exportMod.formatDeterministicExport = function(report) {
  return JSON.stringify(reverseObjectKeys(report), null, 2);
};

const statusMod = require(path.join(projectRoot, 'dist/src/core/status/status.js'));
const origFormatJsonStatus = statusMod.formatJsonStatus;
statusMod.formatJsonStatus = function(status) {
  return JSON.stringify(reverseObjectKeys(status), null, 2);
};

// Delegate to reference CLI
const { runCli } = require(path.join(projectRoot, 'dist/src/cli/index.js'));
const res = runCli(process.argv);
if (res instanceof Promise) {
  res.then(c => process.exit(c)).catch(e => { process.stderr.write(`${e.message}\n`); process.exit(1); });
} else {
  process.exit(res);
}
