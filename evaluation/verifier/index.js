const checkExec001 = require('./checks/check_exec_001');
const checkCrash001 = require('./checks/check_crash_001');
const checkDrift001 = require('./checks/check_drift_001');
const checkDet001 = require('./checks/check_det_001');
const checkState001 = require('./checks/check_state_001');
const checkLock001 = require('./checks/check_lock_001');
const checkScore001 = require('./checks/check_score_001');
const checkRollback001 = require('./checks/check_rollback_001');
const checkRegister001 = require('./checks/check_register_001');

const CHECKS = [
  checkExec001,
  checkCrash001,
  checkDrift001,
  checkDet001,
  checkState001,
  checkLock001,
  checkScore001,
  checkRollback001,
  checkRegister001
];

const CHECKS_BY_ID = new Map(CHECKS.map(c => [c.id, c]));

function runCheck(checkId, cliPath) {
  const check = CHECKS_BY_ID.get(checkId);
  if (!check) {
    throw new Error(`Unknown verifier check ID: "${checkId}"`);
  }
  const startTime = Date.now();
  const res = check.run(cliPath);
  const durationMs = Date.now() - startTime;
  return {
    id: check.id,
    name: check.name,
    pass: res.pass,
    error: res.error || null,
    durationMs
  };
}

function runAllChecks(cliPath) {
  const results = [];
  for (const check of CHECKS) {
    const res = runCheck(check.id, cliPath);
    results.push(res);
  }
  const allPassed = results.every(r => r.pass);
  return {
    pass: allPassed,
    results
  };
}

module.exports = {
  CHECKS,
  CHECKS_BY_ID,
  runCheck,
  runAllChecks
};
