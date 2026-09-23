const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync, spawn } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const REFERENCE_CLI = path.resolve(PROJECT_ROOT, 'dist/src/bin/evalcampaign.js');

function createTestDir(prefix = 'evalcampaign-verifier-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function cleanupDir(dir) {
  if (dir && fs.existsSync(dir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors on ephemeral directories
    }
  }
}

function runCli(cliPath, args, cwd, options = {}) {
  const targetCli = cliPath || REFERENCE_CLI;
  return spawnSync(process.execPath, [targetCli, ...args], {
    cwd,
    encoding: 'utf8',
    timeout: options.timeout || 120000,
    env: { ...process.env, ...options.env },
    ...options
  });
}

function runCliBuffer(cliPath, args, cwd, options = {}) {
  const targetCli = cliPath || REFERENCE_CLI;
  return spawnSync(process.execPath, [targetCli, ...args], {
    cwd,
    encoding: 'buffer',
    timeout: options.timeout || 120000,
    env: { ...process.env, ...options.env },
    ...options
  });
}

module.exports = {
  PROJECT_ROOT,
  REFERENCE_CLI,
  createTestDir,
  cleanupDir,
  runCli,
  runCliBuffer
};
