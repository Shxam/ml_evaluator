import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { handleInit } from '../src/cli/commands/init';
import { runCli } from '../src/cli/index';
import { EXIT_CODES, LIFECYCLE_STATES } from '../src/core/constants';
import { readJson } from '../src/core/storage/atomic';
import { CampaignState, CampaignConfig } from '../src/core/types';

describe('evalcampaign init Command', () => {
  let workDir: string;
  let validConfigPath: string;

  const validConfig = {
    campaign_id: 'coding_eval_v1',
    name: 'Frontier Agent Coding Evaluation',
    budget: {
      max_wall_time_seconds: 1800,
      max_total_attempts: 100,
      max_output_bytes: 1048576
    },
    scoring: {
      aggregation: 'weighted_mean',
      missing_policy: 'zero'
    }
  };

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalcampaign-init-test-'));
    validConfigPath = path.join(workDir, 'valid_campaign.json');
    fs.writeFileSync(validConfigPath, JSON.stringify(validConfig, null, 2));
  });

  afterEach(() => {
    if (fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('initializes campaign successfully (exit 0) and creates all required directories and files', () => {
    const code = handleInit(validConfigPath, workDir);
    assert.strictEqual(code, EXIT_CODES.SUCCESS);

    const evalDir = path.join(workDir, '.evalcampaign');
    assert.ok(fs.existsSync(evalDir), '.evalcampaign should exist');
    assert.ok(fs.existsSync(path.join(evalDir, 'campaign.json')), 'campaign.json should exist');
    assert.ok(fs.existsSync(path.join(evalDir, 'state.json')), 'state.json should exist');
    assert.ok(fs.existsSync(path.join(evalDir, 'tasks')), 'tasks dir should exist');
    assert.ok(fs.existsSync(path.join(evalDir, 'models')), 'models dir should exist');
    assert.ok(fs.existsSync(path.join(evalDir, 'runs')), 'runs dir should exist');
    assert.ok(fs.existsSync(path.join(evalDir, 'registers')), 'registers dir should exist');
    assert.ok(fs.existsSync(path.join(evalDir, 'locks')), 'locks dir should exist');

    const state = readJson<CampaignState>(path.join(evalDir, 'state.json'));
    assert.strictEqual(state.campaign_id, 'coding_eval_v1');
    assert.strictEqual(state.campaign_rev, 1);
    assert.strictEqual(state.lifecycle_state, LIFECYCLE_STATES.CREATED);
    assert.strictEqual(state.budget.max_wall_time_seconds, 1800);

    const savedConfig = readJson<CampaignConfig>(path.join(evalDir, 'campaign.json'));
    assert.strictEqual(savedConfig.campaign_id, 'coding_eval_v1');
    assert.strictEqual(savedConfig.name, 'Frontier Agent Coding Evaluation');
  });

  test('rejects repeated initialization with exit code 1', () => {
    const code1 = handleInit(validConfigPath, workDir);
    assert.strictEqual(code1, EXIT_CODES.SUCCESS);

    const code2 = handleInit(validConfigPath, workDir);
    assert.strictEqual(code2, EXIT_CODES.USAGE_ERROR);
  });

  test('rejects missing configuration path with exit code 1', () => {
    const code = handleInit(undefined, workDir);
    assert.strictEqual(code, EXIT_CODES.USAGE_ERROR);
  });

  test('rejects non-existent file path with exit code 1', () => {
    const code = handleInit(path.join(workDir, 'non_existent.json'), workDir);
    assert.strictEqual(code, EXIT_CODES.USAGE_ERROR);
  });

  test('rejects malformed JSON with exit code 2', () => {
    const badJsonPath = path.join(workDir, 'bad.json');
    fs.writeFileSync(badJsonPath, '{ invalid json');

    const code = handleInit(badJsonPath, workDir);
    assert.strictEqual(code, EXIT_CODES.VALIDATION_ERROR);
    assert.ok(!fs.existsSync(path.join(workDir, '.evalcampaign')));
  });

  test('rejects invalid schema (e.g. negative budget) with exit code 2 and does not create .evalcampaign', () => {
    const invalidSchemaPath = path.join(workDir, 'invalid_schema.json');
    fs.writeFileSync(
      invalidSchemaPath,
      JSON.stringify({ ...validConfig, budget: { ...validConfig.budget, max_wall_time_seconds: -10 } })
    );

    const code = handleInit(invalidSchemaPath, workDir);
    assert.strictEqual(code, EXIT_CODES.VALIDATION_ERROR);
    assert.ok(!fs.existsSync(path.join(workDir, '.evalcampaign')), '.evalcampaign should not be partially created');
  });

  test('CLI router rejects unknown commands with exit code 1', () => {
    const code = runCli(['node', 'evalcampaign', 'unknown-cmd'], workDir);
    assert.strictEqual(code, EXIT_CODES.USAGE_ERROR);
  });

  test('CLI router rejects invocation without arguments with exit code 1', () => {
    const code = runCli(['node', 'evalcampaign'], workDir);
    assert.strictEqual(code, EXIT_CODES.USAGE_ERROR);
  });
});
