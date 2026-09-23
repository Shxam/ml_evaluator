import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { handleInit } from '../src/cli/commands/init';
import { handleRegisterPut } from '../src/cli/commands/registerPut';
import { handleRegisterGet } from '../src/cli/commands/registerGet';
import { putRegister, getRegister, validateRegisterName } from '../src/core/registers/register';
import { getCampaignStatus } from '../src/core/status/status';
import { acquireCampaignLock, releaseCampaignLock } from '../src/core/concurrency/lock';
import { EXIT_CODES } from '../src/core/constants';

describe('Named Scratch Registers (register-put & register-get)', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalcampaign-reg-test-'));
    const campConfig = {
      campaign_id: 'reg_test_camp',
      name: 'Register Test Campaign',
      repetitions: 1,
      budget: { max_wall_time_seconds: 60, max_total_attempts: 10, max_output_bytes: 1024 },
      scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
    };
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2));
    handleInit(campPath, workDir);
  });

  afterEach(() => {
    if (fs.existsSync(workDir)) {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    }
  });

  test('validates register naming strictly: ^[a-zA-Z0-9]$', () => {
    assert.strictEqual(validateRegisterName('a'), true);
    assert.strictEqual(validateRegisterName('Z'), true);
    assert.strictEqual(validateRegisterName('0'), true);
    assert.strictEqual(validateRegisterName('9'), true);

    assert.strictEqual(validateRegisterName(''), false);
    assert.strictEqual(validateRegisterName('aa'), false);
    assert.strictEqual(validateRegisterName('reg1'), false);
    assert.strictEqual(validateRegisterName(' '), false);
    assert.strictEqual(validateRegisterName('-'), false);
    assert.strictEqual(validateRegisterName('/'), false);
    assert.strictEqual(validateRegisterName('../'), false);
  });

  test('rejects invalid register name with exit code 1', () => {
    const srcFile = path.join(workDir, 'test.txt');
    fs.writeFileSync(srcFile, 'hello');

    const codePut = handleRegisterPut(['--reg', 'invalid_name', srcFile], workDir);
    assert.strictEqual(codePut, EXIT_CODES.USAGE_ERROR);

    const codeGet = handleRegisterGet(['--reg', 'invalid_name'], workDir);
    assert.strictEqual(codeGet, EXIT_CODES.USAGE_ERROR);
  });

  test('fails with exit code 1 when source file does not exist', () => {
    const code = handleRegisterPut(['--reg', 'a', path.join(workDir, 'nonexistent.txt')], workDir);
    assert.strictEqual(code, EXIT_CODES.USAGE_ERROR);
  });

  test('fails with exit code 1 when getting non-existent register', () => {
    const code = handleRegisterGet(['--reg', 'x'], workDir);
    assert.strictEqual(code, EXIT_CODES.USAGE_ERROR);
  });

  test('fails with exit code 1 when register is empty (0 bytes)', () => {
    const emptyFile = path.join(workDir, 'empty.bin');
    fs.writeFileSync(emptyFile, Buffer.alloc(0));

    putRegister('e', emptyFile, workDir);

    const code = handleRegisterGet(['--reg', 'e'], workDir);
    assert.strictEqual(code, EXIT_CODES.USAGE_ERROR);
  });

  test('preserves arbitrary binary data byte-for-byte without encoding transformation', () => {
    // Generate binary buffer containing all byte values 0x00 through 0xFF
    const binaryData = Buffer.alloc(256);
    for (let i = 0; i < 256; i++) {
      binaryData[i] = i;
    }

    const binFile = path.join(workDir, 'binary.dat');
    fs.writeFileSync(binFile, binaryData);

    putRegister('b', binFile, workDir);

    const retrieved = getRegister('b', workDir);
    assert.strictEqual(retrieved.length, 256);
    assert.ok(binaryData.equals(retrieved));
  });

  test('replaces an existing register atomically without leaving temporary artifacts', () => {
    const f1 = path.join(workDir, 'f1.txt');
    fs.writeFileSync(f1, 'version 1');
    putRegister('r', f1, workDir);
    assert.strictEqual(getRegister('r', workDir).toString('utf8'), 'version 1');

    const f2 = path.join(workDir, 'f2.txt');
    fs.writeFileSync(f2, 'version 2 updated');
    putRegister('r', f2, workDir);
    assert.strictEqual(getRegister('r', workDir).toString('utf8'), 'version 2 updated');

    // Verify no lingering temp files in registers dir
    const regDir = path.join(workDir, '.evalcampaign', 'registers');
    const files = fs.readdirSync(regDir);
    assert.strictEqual(files.includes('reg_r.blob'), true);
    assert.strictEqual(files.some(f => f.endsWith('.tmp')), false);
  });

  test('registers do not mutate or interfere with campaign status or state', () => {
    const beforeStatus = getCampaignStatus(workDir);

    const f = path.join(workDir, 'data.txt');
    fs.writeFileSync(f, 'trace artifact');
    putRegister('z', f, workDir);

    const afterStatus = getCampaignStatus(workDir);
    assert.deepStrictEqual(beforeStatus, afterStatus);
  });

  test('register-put and register-get respect advisory lock contention (exit code 3)', () => {
    const lock = acquireCampaignLock(workDir);
    try {
      const srcFile = path.join(workDir, 'trace.txt');
      fs.writeFileSync(srcFile, 'trace data');

      const codePut = handleRegisterPut(['--reg', 'c', srcFile], workDir);
      assert.strictEqual(codePut, EXIT_CODES.LOCK_CONTENTION);

      const codeGet = handleRegisterGet(['--reg', 'c'], workDir);
      assert.strictEqual(codeGet, EXIT_CODES.LOCK_CONTENTION);
    } finally {
      releaseCampaignLock(lock);
    }
  });

  test('fails safely with exit code 1 when campaign is not initialized', () => {
    const uninitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uninit-reg-'));
    try {
      const codePut = handleRegisterPut(['--reg', 'a', 'file.txt'], uninitDir);
      assert.strictEqual(codePut, EXIT_CODES.USAGE_ERROR);

      const codeGet = handleRegisterGet(['--reg', 'a'], uninitDir);
      assert.strictEqual(codeGet, EXIT_CODES.USAGE_ERROR);
    } finally {
      fs.rmSync(uninitDir, { recursive: true, force: true });
    }
  });
});
