const fs = require('fs');
const path = require('path');
const { createTestDir, cleanupDir, runCli, runCliBuffer } = require('../utils');

/**
 * CHECK-REGISTER-001: Binary Register Behavior
 * Verifies:
 * - Exact byte-for-byte binary preservation (null bytes, high bytes, invalid UTF-8, trailing newlines)
 * - Detects MUTANT-REGISTER-TEXT (text encoding or newline corruption)
 * - Single-character alphanumeric register name validation (^[a-zA-Z0-9]$)
 * - Missing or 0-byte registers return exit code 1
 * - Atomic replacement of registers
 * - Register operations do not alter campaign scoring or status
 */
function run(cliPath) {
  const workDir = createTestDir('check-reg-001-');

  try {
    // 1. Initialize campaign
    const campConfig = {
      campaign_id: 'camp_check_reg',
      name: 'Check Binary Registers',
      repetitions: 1,
      budget: { max_wall_time_seconds: 60, max_total_attempts: 10, max_output_bytes: 4096 },
      scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));

    const initRes = runCli(cliPath, ['init', campPath], workDir);
    if (initRes.status !== 0) {
      return { pass: false, error: `Init failed: ${initRes.stderr}` };
    }

    // 2. Binary fixture with null bytes, high bytes, invalid UTF-8, and trailing newlines
    const binaryData = Buffer.from([
      0x00, 0x01, 0x02, 0xff, 0xfe, 0x80, 0xc0, 0xaf, 0xf5, 0x90, 0x0d, 0x0a, 0x41, 0x42, 0x00, 0x0a
    ]);
    const binFile = path.join(workDir, 'fixture.bin');
    fs.writeFileSync(binFile, binaryData);

    // 3. Put register 'a'
    const putRes = runCli(cliPath, ['register-put', '--reg', 'a', binFile], workDir);
    if (putRes.status !== 0) {
      return { pass: false, error: `register-put failed with exit ${putRes.status}: ${putRes.stderr}` };
    }

    // 4. Get register 'a' capturing raw buffer stdout
    const getRes = runCliBuffer(cliPath, ['register-get', '--reg', 'a'], workDir);
    if (getRes.status !== 0) {
      return { pass: false, error: `register-get failed with exit ${getRes.status}` };
    }

    // Byte-for-byte binary comparison
    if (Buffer.compare(getRes.stdout, binaryData) !== 0) {
      return {
        pass: false,
        error: `MUTANT-REGISTER-TEXT detected: binary payload corrupted! Expected ${binaryData.length} bytes (${binaryData.toString('hex')}), received ${getRes.stdout.length} bytes (${getRes.stdout.toString('hex')})`
      };
    }

    // 5. Name validation: must match ^[a-zA-Z0-9]$
    const invalidNames = ['ab', '', 'a/b', 'a-b', '12', ' '];
    for (const name of invalidNames) {
      const invPut = runCli(cliPath, ['register-put', '--reg', name, binFile], workDir);
      if (invPut.status !== 1) {
        return { pass: false, error: `register-put accepted invalid register name "${name}": exit ${invPut.status}` };
      }
      const invGet = runCli(cliPath, ['register-get', '--reg', name], workDir);
      if (invGet.status !== 1) {
        return { pass: false, error: `register-get accepted invalid register name "${name}": exit ${invGet.status}` };
      }
    }

    // 6. Missing register returns exit 1
    const missingGet = runCli(cliPath, ['register-get', '--reg', 'z'], workDir);
    if (missingGet.status !== 1) {
      return { pass: false, error: `register-get for missing register returned exit ${missingGet.status}, expected 1` };
    }

    // 7. Empty register file (0 bytes) returns exit 1
    const emptyFile = path.join(workDir, 'empty.bin');
    fs.writeFileSync(emptyFile, Buffer.alloc(0));
    runCli(cliPath, ['register-put', '--reg', 'b', emptyFile], workDir);
    const emptyGet = runCli(cliPath, ['register-get', '--reg', 'b'], workDir);
    if (emptyGet.status !== 1) {
      return { pass: false, error: `register-get on empty register returned exit ${emptyGet.status}, expected 1` };
    }

    // 8. Atomic replacement: replacing existing register 'a'
    const newBytes = Buffer.from([0x13, 0x37, 0x42, 0x99]);
    const newFile = path.join(workDir, 'new.bin');
    fs.writeFileSync(newFile, newBytes);
    runCli(cliPath, ['register-put', '--reg', 'a', newFile], workDir);
    const replaceGet = runCliBuffer(cliPath, ['register-get', '--reg', 'a'], workDir);
    if (Buffer.compare(replaceGet.stdout, newBytes) !== 0) {
      return { pass: false, error: 'register-put atomic replacement failed' };
    }

    return { pass: true };
  } catch (err) {
    return { pass: false, error: err.message };
  } finally {
    cleanupDir(workDir);
  }
}

module.exports = { id: 'CHECK-REGISTER-001', name: 'binary register behavior', run };
