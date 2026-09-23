import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { handleInit } from '../src/cli/commands/init';
import { handleAddModel } from '../src/cli/commands/addModel';
import { EXIT_CODES } from '../src/core/constants';
import { readJson } from '../src/core/storage/atomic';
import { ModelDefinition } from '../src/core/types';
import { validateModelDefinition } from '../src/core/validation/model';

describe('Model Definition Schema & add-model Command', () => {
  let workDir: string;
  let validModelPath: string;

  const validCampaign = {
    campaign_id: 'test_camp',
    name: 'Test Campaign',
    budget: { max_wall_time_seconds: 100, max_total_attempts: 10, max_output_bytes: 1024 },
    scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
  };

  const validModel: ModelDefinition = {
    model_id: 'claude_opus_5',
    name: 'Claude Opus 5 Evaluation Candidate',
    provider: 'anthropic',
    parameters: {
      temperature: 0.0
    }
  };

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalcampaign-model-test-'));
    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(validCampaign, null, 2));
    handleInit(campPath, workDir);

    validModelPath = path.join(workDir, 'model_claude.json');
    fs.writeFileSync(validModelPath, JSON.stringify(validModel, null, 2));
  });

  afterEach(() => {
    if (fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('registers valid model successfully (exit 0) and persists definition deterministically', () => {
    const code = handleAddModel(validModelPath, workDir);
    assert.strictEqual(code, EXIT_CODES.SUCCESS);

    const modelFile = path.join(workDir, '.evalcampaign', 'models', 'claude_opus_5.json');
    assert.ok(fs.existsSync(modelFile), 'Persisted model file should exist');

    const loaded = readJson<ModelDefinition>(modelFile);
    assert.strictEqual(loaded.model_id, 'claude_opus_5');
    assert.strictEqual(loaded.name, 'Claude Opus 5 Evaluation Candidate');
    assert.strictEqual(loaded.provider, 'anthropic');

    // Ensure source file was not mutated
    const sourceContent = fs.readFileSync(validModelPath, 'utf8');
    assert.deepStrictEqual(JSON.parse(sourceContent), validModel);
  });

  test('rejects duplicate model registration with exit code 2 and does not overwrite original', () => {
    const code1 = handleAddModel(validModelPath, workDir);
    assert.strictEqual(code1, EXIT_CODES.SUCCESS);

    // Modify source file with same model_id but different name
    const modifiedModel = { ...validModel, name: 'Modified Model Name' };
    fs.writeFileSync(validModelPath, JSON.stringify(modifiedModel, null, 2));

    const code2 = handleAddModel(validModelPath, workDir);
    assert.strictEqual(code2, EXIT_CODES.VALIDATION_ERROR);

    // Verify original persisted file is untouched
    const modelFile = path.join(workDir, '.evalcampaign', 'models', 'claude_opus_5.json');
    const loaded = readJson<ModelDefinition>(modelFile);
    assert.strictEqual(loaded.name, 'Claude Opus 5 Evaluation Candidate');
  });

  test('validates model schema failure modes', () => {
    assert.strictEqual(validateModelDefinition({}).valid, false);
    assert.strictEqual(validateModelDefinition({ model_id: '' }).valid, false);
    assert.strictEqual(validateModelDefinition({ model_id: '   ' }).valid, false);
    assert.strictEqual(validateModelDefinition({ model_id: 123 }).valid, false);
  });

  test('rejects malformed JSON with exit code 2', () => {
    const malformedPath = path.join(workDir, 'malformed_model.json');
    fs.writeFileSync(malformedPath, '{ not json');

    const code = handleAddModel(malformedPath, workDir);
    assert.strictEqual(code, EXIT_CODES.VALIDATION_ERROR);
  });

  test('rejects missing or non-existent file path with exit code 1', () => {
    assert.strictEqual(handleAddModel(undefined, workDir), EXIT_CODES.USAGE_ERROR);
    assert.strictEqual(
      handleAddModel(path.join(workDir, 'missing.json'), workDir),
      EXIT_CODES.USAGE_ERROR
    );
  });

  test('rejects registration when campaign is not initialized with exit code 1', () => {
    const uninitDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalcampaign-uninit-model-'));
    try {
      const code = handleAddModel(validModelPath, uninitDir);
      assert.strictEqual(code, EXIT_CODES.USAGE_ERROR);
    } finally {
      fs.rmSync(uninitDir, { recursive: true, force: true });
    }
  });
});
