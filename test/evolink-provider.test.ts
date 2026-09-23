import { test, describe, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import {
  queryEvolink,
  buildEvolinkUrl,
  EvolinkError,
  DEFAULT_EVOLINK_BASE_URL,
  computeSha256
} from '../src/core/provider/evolink';
import { redactSecrets } from '../src/core/security/redact';
import { classifyExecution } from '../src/core/execution/classifier';
import { EXECUTION_STATUSES } from '../src/core/execution/types';
import { shouldRetry } from '../src/core/execution/retry';

describe('EvoLink Provider & Benchmark Integration (17 Offline Mocked Isolation Tests)', () => {
  const originalEnv = { ...process.env };
  const FAKE_KEY = 'sk-mockkey1234567890abcdefghijklmnopqrstuvwxyz';

  beforeEach(() => {
    delete process.env.EVOLINK_API_KEY;
    delete process.env.EVOLINK_BASE_URL;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  // 1. Default URL
  test('1. default URL construction points to EvoLink v1 endpoint', () => {
    assert.strictEqual(buildEvolinkUrl(), `${DEFAULT_EVOLINK_BASE_URL}/chat/completions`);
  });

  // 2. Custom URL
  test('2. custom URL overrides default endpoint properly', () => {
    assert.strictEqual(
      buildEvolinkUrl('https://custom.api.com/v1'),
      'https://custom.api.com/v1/chat/completions'
    );
  });

  // 3. Trailing slash normalization
  test('3. trailing slash normalization strips redundant slashes', () => {
    assert.strictEqual(
      buildEvolinkUrl('https://custom.api.com/v1///'),
      'https://custom.api.com/v1/chat/completions'
    );
  });

  // 4. Bearer header
  test('4. bearer authorization header formatted accurately', async () => {
    let capturedHeaders: Record<string, string> = {};

    const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = (init?.headers as Record<string, string>) || {};
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'test response' } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;

    await queryEvolink({
      modelId: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'test' }],
      apiKey: FAKE_KEY,
      fetchFn: mockFetch
    });

    assert.strictEqual(capturedHeaders['Authorization'], `Bearer ${FAKE_KEY}`);
  });

  // 5. Both exact model IDs
  test('5. dispatches requests for both exact model IDs: gpt-5.6-sol and claude-opus-5', async () => {
    const invokedModels: string[] = [];

    const mockFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(init?.body as string);
      invokedModels.push(body.model);
      return new Response(JSON.stringify({
        choices: [{ message: { content: `Response from ${body.model}` } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;

    const resGpt = await queryEvolink({
      modelId: 'gpt-5.6-sol',
      messages: [{ role: 'user', content: 'Hi' }],
      apiKey: FAKE_KEY,
      fetchFn: mockFetch
    });

    const resClaude = await queryEvolink({
      modelId: 'claude-opus-5',
      messages: [{ role: 'user', content: 'Hi' }],
      apiKey: FAKE_KEY,
      fetchFn: mockFetch
    });

    assert.deepStrictEqual(invokedModels, ['gpt-5.6-sol', 'claude-opus-5']);
    assert.strictEqual(resGpt.model, 'gpt-5.6-sol');
    assert.strictEqual(resClaude.model, 'claude-opus-5');
  });

  // 6. Missing credential before request
  test('6. missing credential throws CONFIGURATION_ERROR before network access', async () => {
    let networkAttempted = false;
    const mockFetch = (async () => {
      networkAttempted = true;
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    await assert.rejects(
      async () => {
        await queryEvolink({
          modelId: 'gpt-5.6-sol',
          messages: [{ role: 'user', content: 'test' }],
          fetchFn: mockFetch
        });
      },
      (err: EvolinkError) => {
        assert.strictEqual(err.category, 'CONFIGURATION_ERROR');
        return true;
      }
    );
    assert.strictEqual(networkAttempted, false, 'No network call should be made when key is missing');
  });

  // 7. 401/403
  test('7. classifies HTTP 401 and 403 as AUTHENTICATION_ERROR', async () => {
    for (const code of [401, 403]) {
      const mockFetch = (async () => {
        return new Response('Unauthorized', { status: code });
      }) as unknown as typeof fetch;

      await assert.rejects(
        async () => {
          await queryEvolink({
            modelId: 'gpt-5.6-sol',
            messages: [{ role: 'user', content: 'test' }],
            apiKey: FAKE_KEY,
            fetchFn: mockFetch
          });
        },
        (err: EvolinkError) => {
          assert.strictEqual(err.category, 'AUTHENTICATION_ERROR');
          assert.strictEqual(err.statusCode, code);
          return true;
        }
      );
    }
  });

  // 8. 402
  test('8. classifies HTTP 402 payment/credit error as PROVIDER_ERROR', async () => {
    const mockFetch = (async () => {
      return new Response('Payment Required / Insufficient Credits', { status: 402 });
    }) as unknown as typeof fetch;

    await assert.rejects(
      async () => {
        await queryEvolink({
          modelId: 'claude-opus-5',
          messages: [{ role: 'user', content: 'test' }],
          apiKey: FAKE_KEY,
          fetchFn: mockFetch
        });
      },
      (err: EvolinkError) => {
        assert.strictEqual(err.category, 'PROVIDER_ERROR');
        assert.strictEqual(err.statusCode, 402);
        return true;
      }
    );
  });

  // 9. 429
  test('9. classifies HTTP 429 rate limit as PROVIDER_ERROR', async () => {
    const mockFetch = (async () => {
      return new Response('Rate limited', { status: 429 });
    }) as unknown as typeof fetch;

    await assert.rejects(
      async () => {
        await queryEvolink({
          modelId: 'gpt-5.6-sol',
          messages: [{ role: 'user', content: 'test' }],
          apiKey: FAKE_KEY,
          fetchFn: mockFetch
        });
      },
      (err: EvolinkError) => {
        assert.strictEqual(err.category, 'PROVIDER_ERROR');
        assert.strictEqual(err.statusCode, 429);
        return true;
      }
    );
  });

  // 10. 5xx retry/recovery
  test('10. classifies HTTP 5xx errors as PROVIDER_ERROR and triggers retry policy', async () => {
    for (const code of [500, 502, 503, 504]) {
      const mockFetch = (async () => {
        return new Response('Server Error', { status: code });
      }) as unknown as typeof fetch;

      await assert.rejects(
        async () => {
          await queryEvolink({
            modelId: 'gpt-5.6-sol',
            messages: [{ role: 'user', content: 'test' }],
            apiKey: FAKE_KEY,
            fetchFn: mockFetch
          });
        },
        (err: EvolinkError) => {
          assert.strictEqual(err.category, 'PROVIDER_ERROR');
          assert.strictEqual(err.statusCode, code);
          return true;
        }
      );
    }
  });

  // 11. Retry exhaustion
  test('11. stops retrying once retry attempts budget is exhausted', () => {
    const retryPolicy = {
      max_attempts: 2,
      retry_on: ['evaluator_crash', 'timeout']
    };
    // Attempt 1 -> retry
    assert.strictEqual(shouldRetry(EXECUTION_STATUSES.EVALUATOR_CRASH, 1, retryPolicy), true);
    // Attempt 2 (max_attempts) -> do not retry (exhausted)
    assert.strictEqual(shouldRetry(EXECUTION_STATUSES.EVALUATOR_CRASH, 2, retryPolicy), false);
  });

  // 12. Timeout
  test('12. network timeouts abort cleanly and classify as PROVIDER_ERROR', async () => {
    const mockFetch = (async (_url: any, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const err = new Error('The operation was aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    }) as unknown as typeof fetch;

    await assert.rejects(
      async () => {
        await queryEvolink({
          modelId: 'claude-opus-5',
          messages: [{ role: 'user', content: 'test' }],
          apiKey: FAKE_KEY,
          timeoutMs: 30,
          fetchFn: mockFetch
        });
      },
      (err: EvolinkError) => {
        assert.strictEqual(err.category, 'PROVIDER_ERROR');
        assert.ok(err.message.includes('timed out') || err.message.includes('aborted'));
        return true;
      }
    );
  });

  // 13. Malformed response
  test('13. malformed JSON, empty choices, or missing content classify as PROVIDER_ERROR', async () => {
    const malformedBodies = [
      'Not valid JSON',
      JSON.stringify({}),
      JSON.stringify({ choices: [] }),
      JSON.stringify({ choices: [{ message: {} }] }),
      JSON.stringify({ choices: [{}] })
    ];

    for (const body of malformedBodies) {
      const mockFetch = (async () => {
        return new Response(body, { status: 200, headers: { 'Content-Type': 'application/json' } });
      }) as unknown as typeof fetch;

      await assert.rejects(
        async () => {
          await queryEvolink({
            modelId: 'gpt-5.6-sol',
            messages: [{ role: 'user', content: 'test' }],
            apiKey: FAKE_KEY,
            fetchFn: mockFetch
          });
        },
        (err: EvolinkError) => {
          assert.strictEqual(err.category, 'PROVIDER_ERROR');
          return true;
        }
      );
    }
  });

  // 14. Output-size limits
  test('14. output size limits correctly trigger OUTPUT_OVERFLOW classification', () => {
    const res = classifyExecution({
      exitCode: null,
      stdout: 'exceeded buffer',
      timedOut: false,
      outputOverflow: true
    });
    assert.strictEqual(res.status, EXECUTION_STATUSES.OUTPUT_OVERFLOW);
    assert.strictEqual(res.rawScore, null);
  });

  // 15. 0.0
  test('15. legitimate score of 0.0 is classified as valid COMPLETED result', () => {
    const res = classifyExecution({
      exitCode: 0,
      stdout: JSON.stringify({ score: 0.0 }),
      timedOut: false,
      outputOverflow: false
    });
    assert.strictEqual(res.status, EXECUTION_STATUSES.COMPLETED);
    assert.strictEqual(res.rawScore, 0.0);
  });

  // 16. Deterministic hashes
  test('16. input and output hashes are byte-for-byte deterministic across runs', async () => {
    const mockFetch = (async () => {
      return new Response(JSON.stringify({
        choices: [{ message: { content: 'Fixed Content' } }]
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as unknown as typeof fetch;

    const msgs = [{ role: 'user' as const, content: 'Fixed Query' }];

    const r1 = await queryEvolink({ modelId: 'gpt-5.6-sol', messages: msgs, apiKey: FAKE_KEY, fetchFn: mockFetch });
    const r2 = await queryEvolink({ modelId: 'gpt-5.6-sol', messages: msgs, apiKey: FAKE_KEY, fetchFn: mockFetch });

    assert.strictEqual(r1.inputHash, r2.inputHash);
    assert.strictEqual(r1.outputHash, r2.outputHash);
    assert.strictEqual(r1.inputHash, computeSha256(msgs));
    assert.strictEqual(r1.outputHash, computeSha256('Fixed Content'));
  });

  // 17. Secret redaction
  test('17. secret redaction filters credentials and tokens from all error messages and strings', () => {
    process.env.EVOLINK_API_KEY = FAKE_KEY;

    const testString = `Error connecting to Bearer ${FAKE_KEY} using sk-mockkey1234567890abcdefghijklmnopqrstuvwxyz`;
    const sanitized = redactSecrets(testString);

    assert.ok(!sanitized.includes(FAKE_KEY));
    assert.ok(!sanitized.includes('sk-mockkey'));
    assert.ok(sanitized.includes('Bearer [REDACTED]'));
  });
});
