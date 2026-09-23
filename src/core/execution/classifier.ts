import { EXECUTION_STATUSES, ClassificationResult, SubprocessExecutionResult } from './types';

/**
 * Classifies the outcome of an evaluator subprocess execution.
 * 
 * Invariants:
 * 1. Score 0.0 is explicitly recognized as a valid COMPLETED execution and is NOT an error.
 * 2. Non-zero exit code maps to EVALUATOR_CRASH.
 * 3. Timeout flag maps to TIMEOUT.
 * 4. Output overflow maps to OUTPUT_OVERFLOW.
 * 5. Malformed JSON, missing score, string error, NaN, Infinity, -Infinity map to MALFORMED_OUTPUT.
 */
export function classifyExecution(
  result: Pick<SubprocessExecutionResult, 'exitCode' | 'stdout' | 'timedOut' | 'outputOverflow'>
): ClassificationResult {
  if (result.timedOut) {
    return {
      status: EXECUTION_STATUSES.TIMEOUT,
      rawScore: null
    };
  }

  if (result.outputOverflow) {
    return {
      status: EXECUTION_STATUSES.OUTPUT_OVERFLOW,
      rawScore: null
    };
  }

  if (result.exitCode !== 0) {
    return {
      status: EXECUTION_STATUSES.EVALUATOR_CRASH,
      rawScore: null
    };
  }

  try {
    const parsed = JSON.parse(result.stdout.trim());
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {
        status: EXECUTION_STATUSES.MALFORMED_OUTPUT,
        rawScore: null
      };
    }

    if (!('score' in parsed)) {
      return {
        status: EXECUTION_STATUSES.MALFORMED_OUTPUT,
        rawScore: null
      };
    }

    const rawScoreVal = (parsed as { score?: unknown }).score;

    if (typeof rawScoreVal !== 'number' && typeof rawScoreVal !== 'string') {
      return {
        status: EXECUTION_STATUSES.MALFORMED_OUTPUT,
        rawScore: null
      };
    }

    if (typeof rawScoreVal === 'string' && rawScoreVal.trim() === '') {
      return {
        status: EXECUTION_STATUSES.MALFORMED_OUTPUT,
        rawScore: null
      };
    }

    const numericScore = Number(rawScoreVal);

    if (Number.isNaN(numericScore) || !Number.isFinite(numericScore)) {
      return {
        status: EXECUTION_STATUSES.MALFORMED_OUTPUT,
        rawScore: null
      };
    }

    return {
      status: EXECUTION_STATUSES.COMPLETED,
      rawScore: numericScore
    };
  } catch {
    return {
      status: EXECUTION_STATUSES.MALFORMED_OUTPUT,
      rawScore: null
    };
  }
}
