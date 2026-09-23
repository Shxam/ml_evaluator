Architecture Specification: evalcampaign

1. System Topology & Directory Structure

The application stores all operational data inside .evalcampaign/ at the project root.

Directory structure:

.evalcampaign/: Root state directory.

.evalcampaign/campaign.json: Immutable campaign definition and baseline configuration.

.evalcampaign/state.json: Active lifecycle state, current revision, and budget tracking.

.evalcampaign/tasks/: Copy of registered task configurations named <task_id>.json.

.evalcampaign/models/: Copy of registered model configurations named <model_id>.json.

.evalcampaign/runs/: Directory storing individual attempt manifests named <run_id>_att<N>.json.

.evalcampaign/registers/: Named register files (reg_<name>.blob).

.evalcampaign/locks/campaign.lock: Advisory lock file for POSIX concurrency control.

2. Component Architecture

2.1 Lifecycle State Machine

Campaign progression is strictly linear:

created: Initialized, awaiting tasks and models.

configured: Tasks, models, and budgets registered; configuration locked; SHA-256 baselines captured.

running: Execution active; runner process holds advisory lock.

paused: Execution temporarily halted by operator; state clean.

completed: All runs finished and aggregates computed; terminal state.

failed: Unrecoverable error or campaign-level failure policy triggered.

State transition guards:

Calling add-task or add-model in running, completed, or paused exits with code 4.

Calling resume on a completed campaign exits with code 4.

2.2 Subprocess Driver & Mock Evaluator Protocol

The runner executes task commands as child processes.

The child process receives model inputs and execution parameters via environment variables:
EVAL_TASK_ID, EVAL_MODEL_ID, EVAL_REPETITION, EVAL_ATTEMPT.

Standard output and standard error are captured into separate buffers.

Output payload length is bounded by max_output_bytes; exceeding the limit marks the run as failed due to output overflow.

2.3 Concurrency & Advisory Locking

Every command that reads or writes campaign state opens .evalcampaign/locks/campaign.lock and executes flock(fd, LOCK_EX | LOCK_NB).

If the lock is held, the command emits an error to stderr and terminates with exit code 3.

Lock expiration: The lock file records an expiration timestamp. If the holding process dies without unlocking, the stale file is safely overwritten.

2.4 Provenance & Inode Drift Verification

Before every run attempt, the engine computes:

CurrentHash=SHA-256(read_bytes(task_path))

If CurrentHash=BaselineHash, execution immediately halts with exit code 5.