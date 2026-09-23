import { RetryPolicy } from '../types';
import { EXECUTION_STATUSES, ExecutionStatus } from './types';

/**
 * Determines whether an attempt with the given status should be retried
 * based on the task's retry policy and the current attempt count.
 */
export function shouldRetry(
  status: ExecutionStatus,
  currentAttempt: number,
  retryPolicy?: RetryPolicy
): boolean {
  // Successful completions never retry
  if (status === EXECUTION_STATUSES.COMPLETED) {
    return false;
  }

  if (!retryPolicy) {
    return false;
  }

  // Maximum attempts reached
  if (currentAttempt >= retryPolicy.max_attempts) {
    return false;
  }

  if (!Array.isArray(retryPolicy.retry_on)) {
    return false;
  }

  const normalizedStatus = status.toLowerCase();
  return retryPolicy.retry_on.some(
    condition => condition.trim().toLowerCase() === normalizedStatus
  );
}
