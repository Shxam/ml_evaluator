import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { atomicWriteJson, readJson } from '../src/core/storage/atomic';

describe('Atomic JSON Persistence Utility', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalcampaign-atomic-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true, force: true });
    }
  });

  test('successfully writes deterministic JSON to destination', () => {
    const filePath = path.join(testDir, 'test.json');
    const payload = { b: 2, a: 1 };

    atomicWriteJson(filePath, payload);

    assert.ok(fs.existsSync(filePath));
    const loaded = readJson<{ a: number; b: number }>(filePath);
    assert.deepStrictEqual(loaded, { a: 1, b: 2 });

    const raw = fs.readFileSync(filePath, 'utf8');
    assert.strictEqual(raw, '{\n  "a": 1,\n  "b": 2\n}\n');
  });

  test('does not leave temporary files behind after successful write', () => {
    const filePath = path.join(testDir, 'clean.json');
    atomicWriteJson(filePath, { status: 'ok' });

    const files = fs.readdirSync(testDir);
    assert.strictEqual(files.length, 1);
    assert.strictEqual(files[0], 'clean.json');
  });

  test('overwrites existing file atomically without truncating destination copy beforehand', () => {
    const filePath = path.join(testDir, 'overwrite.json');
    atomicWriteJson(filePath, { version: 1 });
    assert.strictEqual(readJson<{ version: number }>(filePath).version, 1);

    atomicWriteJson(filePath, { version: 2 });
    assert.strictEqual(readJson<{ version: number }>(filePath).version, 2);

    const files = fs.readdirSync(testDir);
    assert.strictEqual(files.length, 1);
  });
});
