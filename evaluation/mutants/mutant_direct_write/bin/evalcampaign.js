#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const projectRoot = path.resolve(__dirname, '../../../..');

// Mutate atomicWriteJson to use direct in-place writes without temporary files or atomic rename
const atomicMod = require(path.join(projectRoot, 'dist/src/core/storage/atomic.js'));
atomicMod.atomicWriteJson = function(filePath, data, indent = 2) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // Direct in-place write: overwrites existing file directly, preserving birthtime and risking corruption on crash
  const content = typeof data === 'string' ? data : JSON.stringify(data, null, indent);
  fs.writeFileSync(filePath, content, 'utf8');
};

// Also in registers: putRegister direct in-place write
const regMod = require(path.join(projectRoot, 'dist/src/core/registers/register.js'));
regMod.putRegister = function(name, sourceFilePath, cwd = process.cwd()) {
  const { isCampaignInitialized, getCampaignPaths } = require(path.join(projectRoot, 'dist/src/core/storage/layout.js'));
  const { validateRegisterName, RegisterError } = require(path.join(projectRoot, 'dist/src/core/registers/register.js'));
  if (!isCampaignInitialized(cwd)) {
    throw new RegisterError('Campaign is not initialized', 1);
  }
  if (!validateRegisterName(name)) {
    throw new RegisterError(`Invalid register name "${name}"`, 1);
  }
  const resolved = path.isAbsolute(sourceFilePath) ? sourceFilePath : path.resolve(cwd, sourceFilePath);
  if (!fs.existsSync(resolved)) {
    throw new RegisterError(`Source file not found`, 1);
  }
  const paths = getCampaignPaths(cwd);
  if (!fs.existsSync(paths.registersDir)) {
    fs.mkdirSync(paths.registersDir, { recursive: true });
  }
  const targetPath = path.join(paths.registersDir, `reg_${name}.blob`);
  // Direct in-place write without .tmp staging
  fs.writeFileSync(targetPath, fs.readFileSync(resolved));
};

// Delegate to reference CLI
const { runCli } = require(path.join(projectRoot, 'dist/src/cli/index.js'));
const res = runCli(process.argv);
if (res instanceof Promise) {
  res.then(c => process.exit(c)).catch(e => { process.stderr.write(`${e.message}\n`); process.exit(1); });
} else {
  process.exit(res);
}
