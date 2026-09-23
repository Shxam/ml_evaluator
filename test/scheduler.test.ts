import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { buildSchedule, getCampaignSchedule } from '../src/core/scheduler/scheduler';
import { handleInit } from '../src/cli/commands/init';
import { handleAddTask } from '../src/cli/commands/addTask';
import { handleAddModel } from '../src/cli/commands/addModel';

describe('Deterministic Cartesian Scheduler', () => {
  let workDir: string;

  beforeEach(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalcampaign-sched-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(workDir)) {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  test('generates Cartesian product in sorted model, sorted task, and repetition order', () => {
    const models = ['gpt_4', 'claude_3', 'mistral_large'];
    const tasks = ['task_z', 'task_a'];
    const reps = 2;

    const schedule = buildSchedule('eval_test', 1, models, tasks, reps);

    assert.strictEqual(schedule.length, 3 * 2 * 2); // 12 runs

    // Expected order:
    // model: claude_3 -> task: task_a (rep 1, rep 2), task_z (rep 1, rep 2)
    // model: gpt_4 -> task: task_a (rep 1, rep 2), task_z (rep 1, rep 2)
    // model: mistral_large -> task: task_a (rep 1, rep 2), task_z (rep 1, rep 2)
    assert.strictEqual(schedule[0].model_id, 'claude_3');
    assert.strictEqual(schedule[0].task_id, 'task_a');
    assert.strictEqual(schedule[0].repetition, 1);

    assert.strictEqual(schedule[1].model_id, 'claude_3');
    assert.strictEqual(schedule[1].task_id, 'task_a');
    assert.strictEqual(schedule[1].repetition, 2);

    assert.strictEqual(schedule[2].model_id, 'claude_3');
    assert.strictEqual(schedule[2].task_id, 'task_z');
    assert.strictEqual(schedule[2].repetition, 1);

    assert.strictEqual(schedule[4].model_id, 'gpt_4');
    assert.strictEqual(schedule[4].task_id, 'task_a');
    assert.strictEqual(schedule[4].repetition, 1);

    assert.strictEqual(schedule[8].model_id, 'mistral_large');
    assert.strictEqual(schedule[8].task_id, 'task_a');
    assert.strictEqual(schedule[8].repetition, 1);
  });

  test('produces identical schedule regardless of registration insertion order on disk', () => {
    // Setup Campaign 1: Register Model B then Model A; Task Z then Task A
    const dir1 = path.join(workDir, 'camp1');
    fs.mkdirSync(dir1);
    const campPath1 = path.join(dir1, 'camp.json');
    fs.writeFileSync(
      campPath1,
      JSON.stringify({
        campaign_id: 'order_test',
        name: 'Order Invariance Test',
        budget: { max_wall_time_seconds: 100, max_total_attempts: 10, max_output_bytes: 1024 },
        scoring: { aggregation: 'weighted_mean', missing_policy: 'zero' }
      })
    );
    handleInit(campPath1, dir1);

    const taskZPath = path.join(dir1, 'task_z.json');
    fs.writeFileSync(
      taskZPath,
      JSON.stringify({
        task_id: 'task_z',
        command: 'echo z',
        timeout_seconds: 5,
        weight: 1,
        retry_policy: { max_attempts: 1, retry_on: ['timeout'] }
      })
    );
    const taskAPath = path.join(dir1, 'task_a.json');
    fs.writeFileSync(
      taskAPath,
      JSON.stringify({
        task_id: 'task_a',
        command: 'echo a',
        timeout_seconds: 5,
        weight: 1,
        retry_policy: { max_attempts: 1, retry_on: ['timeout'] }
      })
    );

    const modelBPath = path.join(dir1, 'model_b.json');
    fs.writeFileSync(modelBPath, JSON.stringify({ model_id: 'model_b' }));
    const modelAPath = path.join(dir1, 'model_a.json');
    fs.writeFileSync(modelAPath, JSON.stringify({ model_id: 'model_a' }));

    // Register in reverse order
    handleAddTask(taskZPath, dir1);
    handleAddTask(taskAPath, dir1);
    handleAddModel(modelBPath, dir1);
    handleAddModel(modelAPath, dir1);

    // Setup Campaign 2: Register Model A then Model B; Task A then Task Z
    const dir2 = path.join(workDir, 'camp2');
    fs.mkdirSync(dir2);
    const campPath2 = path.join(dir2, 'camp.json');
    fs.writeFileSync(campPath2, JSON.stringify(JSON.parse(fs.readFileSync(campPath1, 'utf8'))));
    handleInit(campPath2, dir2);

    handleAddTask(taskAPath, dir2);
    handleAddTask(taskZPath, dir2);
    handleAddModel(modelAPath, dir2);
    handleAddModel(modelBPath, dir2);

    const schedule1 = getCampaignSchedule(dir1, 3);
    const schedule2 = getCampaignSchedule(dir2, 3);

    assert.deepStrictEqual(schedule1, schedule2);
  });
});
