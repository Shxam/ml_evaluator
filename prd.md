Product Requirements Document (PRD): agent-ledger

1. Executive Overview

agent-ledger is a deterministic, headless command-line systems utility designed to record, validate, checkpoint, and replay the execution of tool-using autonomous AI agents. Built on an append-only event-sourced architecture, agent-ledger guarantees causal sequence integrity, cryptographic auditability, crash resilience under unannounced process termination (SIGKILL), and deterministic replay without executing dangerous side-effecting tools a second time.

2. Target Users & Operational Environment

Primary Users: AI agent harnesses, RL gym evaluation runners, and automated benchmarking sandboxes.

Environment: Headless Linux container execution environments (POSIX compliant). Zero external network dependencies; all verification runs strictly local.

3. Functional Requirements

3.1 Event Ingestion and Causal Ordering

FR-1.1: The system must ingest agent execution events via CLI commands and append them to an append-only log file (events.ndjson).

FR-1.2: Events must possess monotonically strictly increasing sequence numbers starting at 1.

FR-1.3: The engine must enforce causal pairing: every tool_result_received event must match an open, unfulfilled tool_request_id from an earlier tool_requested event.

FR-1.4: A run cannot transition to run_completed while any tool request remains unfulfilled.

3.2 Modal Operation & Concurrency

FR-2.1: The engine must operate under three distinct operational modes:

Record Mode: Ingests live events into an active execution branch.

Replay Mode: Traverses historical checkpoints in read-only state; virtualizes external tool side effects.

Branch Mode: Maintains speculative execution branches from prior checkpoints.

FR-2.2: The engine must enforce non-blocking POSIX advisory locking (flock) on .agent-ledger/locks/ledger.lock to prevent concurrent process write interleaving. Contended operations must exit with code 3.

3.3 Cryptographic Provenance & Drift Detection

FR-3.1: Each ingested event must compute a SHA-256 backlink incorporating the previous event's hash, forming a tamper-evident cryptographic hash chain.

FR-3.2: Prior to appending or replaying, the engine must audit the hash chain. If an out-of-band external process mutates or truncates historical events, the command must halt with exit code 5 (TamperDriftDetected).

3.4 Crash Recovery Under SIGKILL

FR-4.1: If the process is terminated ungracefully (SIGKILL) during an append operation, a torn or incomplete JSON line at the physical tail of events.ndjson must be safely isolated.

FR-4.2: Invoking agent-ledger recover must detect the torn line, validate all preceding events against the cryptographic hash chain, truncate the damaged bytes, roll the state forward to the last valid checkpoint, and release dangling locks.

3.5 Virtualized Safe Replay

FR-5.1: Replaying an execution from a checkpoint must reconstruct the exact in-memory state of the agent up to that point.

FR-5.2: Any command or tool invocation during replay must return the recorded output from the event ledger and must never re-execute shell commands, file writes, or network calls.

3.6 Scratch Registers and Multipliers

FR-6.1: The CLI must provide named scratch registers (--reg <name>) allowing operators to extract and isolate tool failure traces, diffs, or standard error buffers into .agent-ledger/registers/reg_<name>.blob.

FR-6.2: The replay and inspection engines must accept integer command multipliers (e.g., step 5 to replay 5 events forward, rollback 3 to revert 3 checkpoints).

4. Non-Functional Requirements

NFR-1 (Determinism): Standard output streams and JSON exports must utilize canonically sorted keys and deterministic field ordering.

NFR-2 (Performance): Event append operations must complete in under 15 milliseconds on local storage.

NFR-3 (Atomicity): Checkpoint manifests and branch pointers must be updated atomically using temporary file swaps and POSIX rename(2).

5. CLI Exit Status Contract

Exit Code

Identifier

Triggering Condition

0

SUCCESS

Command completed cleanly with all invariants satisfied.

1

USAGE_ERROR

Malformed CLI arguments, missing parameters, or missing file paths.

2

CAUSAL_VALIDATION_ERROR

Monotonicity violation, duplicate event ID, or unmatched tool result.

3

LOCK_CONTENTION

Another process holds an active POSIX lock on the ledger.

4

INCOMPLETE_STATE_BLOCKED

Attempted close or branch switch with in-flight unfulfilled tool calls.

5

TAMPER_DRIFT_DETECTED

Hash-chain mismatch indicating out-of-band log mutation.

6

BRANCH_CHECKPOINT_CONFLICT

Branch name collision or non-existent checkpoint identifier.

7

UNRECOVERABLE_CORRUPTION

Log corruption prior to the last valid checkpoint boundary.