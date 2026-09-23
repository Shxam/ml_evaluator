#!/usr/bin/env node

import { queryEvolink, EvolinkError } from '../core/provider/evolink';
import { redactSecrets } from '../core/security/redact';

/**
 * Benchmark Task Evaluator:
 * Invoked as an evaluator command under evalcampaign runner.
 * Reads environment variables passed by driver.ts:
 *   - EVAL_TASK_ID
 *   - EVAL_MODEL_ID
 *   - EVAL_REPETITION
 *   - EVAL_ATTEMPT
 * And API configuration:
 *   - EVOLINK_API_KEY
 *   - EVOLINK_BASE_URL
 */

interface BenchmarkTaskSpec {
  prompt: string;
  expectedPattern: RegExp;
  maxTokens?: number;
}

const BENCHMARK_TASKS: Record<string, BenchmarkTaskSpec> = {
  instruction_following: {
    prompt: 'Say exactly EVOLINK_BENCHMARK_OK without punctuation or explanation.',
    expectedPattern: /EVOLINK_BENCHMARK_OK/,
    maxTokens: 200
  },
  math_reasoning: {
    prompt: 'Calculate 25 * 4. Respond with ONLY the numeric result and nothing else.',
    expectedPattern: /\b100\b/,
    maxTokens: 200
  },
  code_synthesis: {
    prompt: 'Write a Python function `def add(a, b):` that returns their sum. Provide the definition.',
    expectedPattern: /def\s+add\s*\(\s*a\s*,\s*b\s*\)/,
    maxTokens: 200
  }
};

async function main(): Promise<void> {
  const taskId = process.env.EVAL_TASK_ID || 'instruction_following';
  const modelId = process.env.EVAL_MODEL_ID;

  if (!modelId) {
    process.stderr.write('Error: EVAL_MODEL_ID environment variable is missing.\n');
    process.exitCode = 1;
    return;
  }

  const spec = BENCHMARK_TASKS[taskId] || {
    prompt: `Respond with confirmation for task "${taskId}".`,
    expectedPattern: /.+/,
    maxTokens: 200
  };

  try {
    const result = await queryEvolink({
      modelId,
      messages: [{ role: 'user', content: spec.prompt }],
      maxTokens: spec.maxTokens ?? 200
    });

    const isMatch = spec.expectedPattern.test(result.content.trim());
    const score = isMatch ? 1.0 : 0.0;

    const outputPayload = {
      score,
      model_id: modelId,
      task_id: taskId,
      latency_ms: result.latencyMs,
      input_sha256: result.inputHash,
      output_sha256: result.outputHash
    };

    // Output valid JSON containing "score" for evalcampaign classifier
    process.stdout.write(JSON.stringify(outputPayload));
    process.exitCode = 0;
  } catch (err: unknown) {
    const cleanError = redactSecrets(err instanceof Error ? err.message : String(err));
    process.stderr.write(`Evaluator error: ${cleanError}\n`);
    if (err instanceof EvolinkError) {
      if (err.category === 'AUTHENTICATION_ERROR') {
        process.exitCode = 2;
        return;
      }
      if (err.category === 'CONFIGURATION_ERROR') {
        process.exitCode = 3;
        return;
      }
    }
    process.exitCode = 1;
  }
}

main();
