import { LIFECYCLE_STATES, LifecycleState } from '../constants';

/**
 * Checks whether the campaign configuration can be modified in the given lifecycle state.
 * Task and model registration is allowed strictly in the 'created' state.
 * Any modification in 'running', 'paused', 'completed', 'failed', or 'configured' is forbidden.
 */
export function canModifyConfiguration(lifecycleState: LifecycleState): boolean {
  return lifecycleState === LIFECYCLE_STATES.CREATED;
}

export function canAddTask(lifecycleState: LifecycleState): boolean {
  return canModifyConfiguration(lifecycleState);
}

export function canAddModel(lifecycleState: LifecycleState): boolean {
  return canModifyConfiguration(lifecycleState);
}
