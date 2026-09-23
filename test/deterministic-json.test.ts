import { test, describe } from 'node:test';
import * as assert from 'node:assert';
import { toDeterministicJson } from '../src/core/storage/json';

describe('Deterministic JSON Serializer', () => {
  test('recursively sorts object keys lexicographically', () => {
    const obj1 = { z: 1, a: 2, m: { y: 10, b: 20 } };
    const obj2 = { a: 2, m: { b: 20, y: 10 }, z: 1 };

    const json1 = toDeterministicJson(obj1);
    const json2 = toDeterministicJson(obj2);

    assert.strictEqual(json1, json2);
    assert.strictEqual(
      json1,
      '{\n  "a": 2,\n  "m": {\n    "b": 20,\n    "y": 10\n  },\n  "z": 1\n}\n'
    );
  });

  test('preserves array element ordering', () => {
    const arrObj1 = { list: ['cherry', 'apple', 'banana'] };
    const arrObj2 = { list: ['cherry', 'apple', 'banana'] };

    assert.strictEqual(toDeterministicJson(arrObj1), toDeterministicJson(arrObj2));
    
    // Arrays must not be sorted automatically
    const parsed = JSON.parse(toDeterministicJson(arrObj1));
    assert.deepStrictEqual(parsed.list, ['cherry', 'apple', 'banana']);
  });

  test('recursively sorts objects within arrays', () => {
    const data = {
      items: [
        { z: 1, a: 2 },
        { d: 4, c: 3 }
      ]
    };

    const serialized = toDeterministicJson(data);
    assert.strictEqual(
      serialized,
      '{\n  "items": [\n    {\n      "a": 2,\n      "z": 1\n    },\n    {\n      "c": 3,\n      "d": 4\n    }\n  ]\n}\n'
    );
  });

  test('maintains serialization stability over repeated runs', () => {
    const complex = {
      scoring: { missing_policy: 'zero', aggregation: 'weighted_mean' },
      campaign_id: 'test_camp',
      budget: { max_wall_time_seconds: 1800, max_output_bytes: 1048576, max_total_attempts: 100 },
      name: 'Test Evaluation'
    };

    const first = toDeterministicJson(complex);
    for (let i = 0; i < 10; i++) {
      assert.strictEqual(toDeterministicJson(complex), first);
    }
  });
});
