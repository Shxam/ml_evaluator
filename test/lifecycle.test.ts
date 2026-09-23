import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { handleInit } from '../src/cli/commands/init';
import { LIFECYCLE_STATES, EXIT_CODES } from '../src/core/constants';
import { readJson } from '../src/core/storage/atomic';
import { CampaignState } from '../src/core/types';

describe('Lifecycle State Machine Initial State', () => {
  let workDir: string;
  let configPath: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalcampaign-lifecycle-test-'));
    configPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(
      configPath,
      JSON.stringify({
        campaign_id: 'test_lifecycle',
        name: 'Lifecycle Verification',
        budget: { max_wall_time_seconds: 60, max_total_attempts: 10, max_output_bytes: 4096 },
        scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
      })
    );
  });

  afterEach(() => {
    if (fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('initializes strictly with state "created" and revision 1', () => {
    const code = handleInit(configPath, workDir);
    assert.strictEqual(code, EXIT_CODES.SUCCESS);

    const state = readJson<CampaignState>(path.join(workDir, '.evalcampaign', 'state.json'));
    assert.strictEqual(state.lifecycle_state, LIFECYCLE_STATES.CREATED);
    assert.strictEqual(state.lifecycle_state, 'created');
    assert.strictEqual(state.campaign_rev, 1);

    // Assert that no undocumented public state like 'interrupted' is ever set
    assert.notStrictEqual(state.lifecycle_state, 'interrupted');
  });
});
