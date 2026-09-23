Task Instruction: Evaluation Campaign Manager (evalcampaign)

Problem Overview

Implement a deterministic command-line systems utility named evalcampaign that manages multi-model evaluation campaigns with immutable configurations, resumable execution, atomic state persistence, artifact provenance, and crash recovery under SIGKILL.

The executable must be named evalcampaign and must be present on the system PATH following the completion of your build script.

Directory Structure and State Storage

All internal engine data must reside inside a .evalcampaign/ directory at the project root:

.evalcampaign/campaign.json: Immutable campaign definition.

.evalcampaign/state.json: Active lifecycle state, current revision, and budget counters.

.evalcampaign/tasks/: Registered task specifications (<task_id>.json).

.evalcampaign/models/: Registered model definitions (<model_id>.json).

.evalcampaign/runs/: Completed attempt results (<run_id>_att<N>.json).

.evalcampaign/registers/: Named register files (reg_<name>.blob).

.evalcampaign/locks/campaign.lock: File descriptor target for POSIX advisory locking.

Command-Line Interface Specification

1. evalcampaign init <campaign_json_path>

Initializes a new evaluation campaign using the provided JSON configuration.

Exit 0: Initialized successfully.

Exit 1: Campaign already exists or invalid configuration path.

Exit 2: Schema validation error (e.g., negative budget parameters).

2. evalcampaign add-task <task_json_path>

Registers an evaluation task into the campaign.

Verifies that task_id is unique and task weights are positive numbers.

Once the campaign has entered running or completed mode, adding tasks is strictly prohibited.

Exit 0: Task registered.

Exit 2: Validation error (duplicate task ID, invalid weight).

Exit 4: Campaign is already running or completed.

3. evalcampaign add-model <model_json_path>

Registers a model to be evaluated across campaign tasks.

Exit 0: Model registered.

Exit 2: Duplicate model ID or schema error.

Exit 4: Campaign is already running or completed.

4. evalcampaign run

Transitions the campaign from configured to running and begins executing scheduled runs.

Acquires a non-blocking POSIX advisory lock (flock) on .evalcampaign/locks/campaign.lock.

Computes and records baseline SHA-256 hashes for all registered task files.

Iterates through all combinations of model x task x repetition.

Derives deterministic 16-character run IDs:

RunID=SHA-256(campaign_id∥campaign_rev∥model_id∥task_id∥repetition)[:16]

Executes each task command in a subprocess. Captures exit codes, stdout, and execution times.

Before executing each run, audits task configuration files on disk. If external drift is detected against baseline hashes, halts immediately.

Exit 0: All scheduled runs completed cleanly.

Exit 3: POSIX lock contention (another runner process is active).

Exit 5: Provenance drift detected (task definition tampered with on disk out-of-band).

Exit 6: Budget boundary reached (wall-clock or attempt limit hit).

5. evalcampaign resume

Resumes an interrupted or paused campaign from the last completed run.

Inspects .evalcampaign/runs/ and identifies incomplete, interrupted, or retryable runs.

Resumes scheduling from the first unexecuted run without re-executing completed runs.

Cannot be invoked on a campaign whose status is completed.

Exit 0: Cleanly resumed and completed.

Exit 4: Campaign is already completed.

Exit 5: Provenance drift detected.

6. evalcampaign status [--json]

Emits current status: lifecycle state, active revision, completed runs, remaining runs, and budget consumption.

Exit 0: Success.

7. evalcampaign score

Aggregates completed run manifests and computes weighted normalized rankings across models.

Emits deterministic JSON output with canonically sorted keys.

Properly handles legitimate scores of 0.0 without treating them as failures.

Exit 0: Success.

Exit 4: Runs are incomplete or campaign is in a broken state.

8. evalcampaign register-put --reg <name> <file_path>

Stores a model log, failure trace, or diff artifact in .evalcampaign/registers/reg_<name>.blob.

<name> is a single alphanumeric character.

Exit 0: Register saved.

Exit 1: File not found or invalid register name.

9. evalcampaign register-get --reg <name>

Streams the raw content of the named register directly to stdout.

Exit 0: Success.

Exit 1: Register not found or empty.

10. evalcampaign rollback [n]

Reverts the campaign state by n completed attempt batches (default 1), restoring previous run counters and cleaning invalid results.

Exit 0: Reverted successfully.

Exit 4: Cannot rollback past initial configured revision.

11. evalcampaign export --format json

Emits an immutable evaluation report containing campaign configuration, task hashes, raw scores, normalized averages, and model rankings.

All JSON keys must be lexicographically sorted to guarantee deterministic export hashes.

Exit 0: Export complete.

Systems Invariants & Fault Tolerance

Atomic State Swaps: Never overwrite JSON manifests in place. Always write to a hidden .tmp file and execute an atomic POSIX rename(2).

Crash Resilience: The test harness injects unannounced SIGKILL (signal 9) signals during active execution and aggregation. Resuming the campaign must recover cleanly without raising JSON parsing errors or leaving truncated 0-byte files.


Flaky vs. Model Failure: Do not conflate a model scoring 0.0 with an evaluator crash. A non-zero exit code or timeout is an infrastructure failure subject to task retry policies; a zero exit code with score 0.0 is a valid result.