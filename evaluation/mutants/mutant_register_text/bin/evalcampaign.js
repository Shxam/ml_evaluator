#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const projectRoot = path.resolve(__dirname, '../../../..');

// Mutate registers: corrupt binary data with UTF-8 text encoding and newline append
const regMod = require(path.join(projectRoot, 'dist/src/core/registers/register.js'));

const origPut = regMod.putRegister;
regMod.putRegister = function(name, sourceFilePath, cwd = process.cwd()) {
  const { getCampaignPaths, isCampaignInitialized } = require(path.join(projectRoot, 'dist/src/core/storage/layout.js'));
  const { validateRegisterName, RegisterError } = require(path.join(projectRoot, 'dist/src/core/registers/register.js'));
  if (!isCampaignInitialized(cwd)) {
    throw new RegisterError('Campaign is not initialized', 1);
  }
  if (!validateRegisterName(name)) {
    throw new RegisterError(`Invalid register name "${name}"`, 1);
  }
  const resolved = path.isAbsolute(sourceFilePath) ? sourceFilePath : path.resolve(cwd, sourceFilePath);
  if (!fs.existsSync(resolved)) {
    throw new RegisterError('Source file not found', 1);
  }
  const paths = getCampaignPaths(cwd);
  if (!fs.existsSync(paths.registersDir)) {
    fs.mkdirSync(paths.registersDir, { recursive: true });
  }
  const targetPath = path.join(paths.registersDir, `reg_${name}.blob`);
  // Corrupt: read as utf8 text (destroys invalid byte sequences and nulls) and append newline
  const text = fs.readFileSync(resolved, 'utf8') + '\n';
  fs.writeFileSync(targetPath, text, 'utf8');
};

const origGet = regMod.getRegister;
regMod.getRegister = function(name, cwd = process.cwd()) {
  const { getCampaignPaths } = require(path.join(projectRoot, 'dist/src/core/storage/layout.js'));
  const { RegisterError } = require(path.join(projectRoot, 'dist/src/core/registers/register.js'));
  const paths = getCampaignPaths(cwd);
  const targetPath = path.join(paths.registersDir, `reg_${name}.blob`);
  if (!fs.existsSync(targetPath)) {
    throw new RegisterError(`Register not found`, 1);
  }
  const text = fs.readFileSync(targetPath, 'utf8');
  return Buffer.from(text + '\n', 'utf8');
};

// Delegate to reference CLI
const { runCli } = require(path.join(projectRoot, 'dist/src/cli/index.js'));
const res = runCli(process.argv);
if (res instanceof Promise) {
  res.then(c => process.exit(c)).catch(e => { process.stderr.write(`${e.message}\n`); process.exit(1); });
} else {
  process.exit(res);
}
