# evalcampaign (ml_evaluator)

[![Build & Tests](https://img.shields.io/badge/Tests-155%2F155%20PASS-brightgreen.svg)](#benchmark--verification-results)
[![Private Verifier](https://img.shields.io/badge/Private%20Verifier-9%2F9%20PASS-brightgreen.svg)](#benchmark--verification-results)
[![Mutant Kill Rate](https://img.shields.io/badge/Mutants-9%2F9%20KILLED%20(100%25)-brightgreen.svg)](#benchmark--verification-results)
[![Live Multi-Model Benchmark](https://img.shields.io/badge/Live%20EvoLink-PASS-blue.svg)](#live-multi-model-evaluation)

A deterministic, headless systems utility and benchmark execution engine designed to manage multi-model evaluation campaigns with immutable configurations, resumable scheduling, atomic state persistence, cryptographic artifact provenance, and crash resilience under unannounced process termination (`SIGKILL`).

---

## Table of Contents
1. [Core Architectural Invariants](#core-architectural-invariants)
2. [EvoLink Multi-Model Integration](#evolink-multi-model-integration)
3. [Benchmark & Verification Results](#benchmark--verification-results)
4. [Command-Line Interface (CLI) Reference](#command-line-interface-cli-reference)
5. [CLI Exit Code Specification](#cli-exit-code-specification)
6. [Getting Started & Installation](#getting-started--installation)
7. [Running Tests & Verifiers](#running-tests--verifiers)
8. [Live Multi-Model Evaluation](#live-multi-model-evaluation)
9. [Evidence & Proof-of-Work Artifacts](#evidence--proof-of-work-artifacts)
10. [Security & Credential Policy](#security--credential-policy)

---

## Core Architectural Invariants

`evalcampaign` is engineered as a robust systems utility adhering to strict invariants:

* **Genuine POSIX Advisory Locking (`flock`)**:
  Protects `.evalcampaign/locks/campaign.lock` against concurrent runner execution. Uses genuine non-blocking kernel locking (`LOCK_EX | LOCK_NB`), immediately exiting with code `3` on contention regardless of on-disk metadata states.
* **Cryptographic Task Provenance**:
  Takes SHA-256 digests of all registered task configurations. Prior to executing *any* attempt (including retry attempts and resumed runs), audits files against baseline hashes. If out-of-band tampering or filesystem drift occurs, execution halts fail-closed with exit code `5`.
* **Atomic Filesystem Swaps & SIGKILL Crash Resilience**:
  State files (`state.json`) and run manifests (`<run_id>_att<N>.json`) are never written in place. Data is written to hidden temporary staging files (`.tmp`) and swapped atomically using POSIX `rename(2)`. Ungraceful process termination leaves no corrupt or truncated files.
* **Resumable Scheduling & Recovery**:
  Interrupted campaigns reconstruct logical runs and attempt counts from disk manifests upon `evalcampaign resume`, resuming only unfinished logical runs without duplicate executions.
* **Deterministic Run IDs & Key Ordering**:
  Run IDs are deterministically derived via:
  $$\text{RunID} = \text{SHA-256}(\text{campaign\_id} \parallel \text{campaign\_rev} \parallel \text{model\_id} \parallel \text{task\_id} \parallel \text{repetition})[:16]$$
  All JSON outputs (`status --json`, `score`, `export`) use canonically sorted keys to guarantee bit-for-bit reproducibility.
* **Weighted-Mean Scoring & Valid 0.0 Handling**:
  Evaluators scoring `0.0` are classified as valid `COMPLETED` runs rather than infrastructure crashes. Campaign scores aggregate via weighted means across tasks.
* **Scratch Binary Registers & Rollback**:
  Operators can isolate failure traces, diffs, or binary blobs in `.evalcampaign/registers/reg_<name>.blob` with byte-for-byte fidelity (preserving null bytes, high bytes, and invalid UTF-8). Rollback cleanly reverts attempt batches and reconciles state counters.

---

## EvoLink Multi-Model Integration

`evalcampaign` includes unified evaluation integration with the **EvoLink Gateway** supporting modern frontier models:
* **`gpt-5.6-sol`**
* **`claude-opus-5`**

### Unified Architecture
```
                         +-----------------------+
                         |  evalcampaign runner  |
                         +-----------+-----------+
                                     |
               +---------------------+---------------------+
               | (EVAL_MODEL_ID=gpt-5.6-sol)               | (EVAL_MODEL_ID=claude-opus-5)
               v                                           v
     +-------------------+                       +-------------------+
     |  evalTask worker  |                       |  evalTask worker  |
     +---------+---------+                       +---------+---------+
               |                                           |
               +---------------------+---------------------+
                                     |
                                     v
                        POST /v1/chat/completions
                    Authorization: Bearer $API_KEY
                                     |
                        +------------+------------+
                        |  direct.evolink.ai/v1   |
                        +------------+------------+
                                     |
                  +------------------+------------------+
                  |                                     |
                  v                                     v
           [ gpt-5.6-sol ]                       [ claude-opus-5 ]
```

* **Zero Credential Fallback**: Relies exclusively on `EVOLINK_API_KEY` from the environment. Literal fallback tokens are strictly forbidden.
* **Classification Pipeline**:
  - Missing key: `CONFIGURATION_ERROR` (exits before network call)
  - HTTP 401 / 403: `AUTHENTICATION_ERROR`
  - HTTP 402, 429, 5xx, timeouts, network faults: `PROVIDER_ERROR`
  - Valid task completion: `COMPLETED` / `PASS`
* **Response Isolation**: Evaluator processes evaluate responses in memory and output numeric scores and input/output SHA-256 hashes only. Raw responses are never persisted in logs or evidence.

---

## Benchmark & Verification Results

The test and verification harness executes across three independent evaluation layers:

### 1. Public Unit & Integration Test Suite (`npm test`)
* **Total Tests**: **155**
* **Total Suites**: **25**
* **Passing**: **155**
* **Failing**: **0**
* **Duration**: ~18–20s
* **Coverage**: Init, task registration, model registration, lifecycle guards, POSIX advisory locking, subprocess driver, classifier, runner budgets, recovery/resume, status reporting, weighted scoring, binary registers, atomic rollback, deterministic export, and 17 EvoLink offline isolation tests.

### 2. Private Invariant Verifier (`npm run verify`)
Tests black-box behavior, exit code contracts, and filesystem atomicity:
* `CHECK-EXEC-001` - Evaluator result classification (COMPLETED, valid 0.0, CRASH, TIMEOUT, MALFORMED): **PASS**
* `CHECK-CRASH-001` - Atomic persistence protocol (`.tmp` swap) and stale staging cleanup: **PASS**
* `CHECK-DRIFT-001` - Task configuration SHA-256 provenance drift enforcement (exit 5): **PASS**
* `CHECK-DET-001` - Deterministic output formatting and lexicographical key order: **PASS**
* `CHECK-STATE-001` - Lifecycle state machine boundary guards (exit 4): **PASS**
* `CHECK-LOCK-001` - Cross-process POSIX advisory locking and kernel contention (exit 3): **PASS**
* `CHECK-SCORE-001` - Exact weighted-mean score mathematics: **PASS**
* `CHECK-ROLLBACK-001` - Batch manifest unlinking, state counter reconciliation: **PASS**
* `CHECK-REGISTER-001` - Binary byte preservation (`0x00`, high bytes, trailing newlines): **PASS**
* **Summary**: **9/9 checks passed**.

### 3. Mutation Testing & Defect Killing (`npm run evaluate`)
Evaluates 9 controlled defect mutants against observable black-box checks:
* `MUTANT-ZERO-SCORE` (Interprets valid 0.0 score as failure): **KILLED**
* `MUTANT-DIRECT-WRITE` (Replaces atomic swap with in-place writes): **KILLED**
* `MUTANT-DRIFT-BLIND` (Disables task provenance SHA-256 checks): **KILLED**
* `MUTANT-UNSORTED-JSON` (Emits non-deterministic unsorted JSON): **KILLED**
* `MUTANT-PERMISSIVE-RESUME` (Allows resume on completed campaign): **KILLED**
* `MUTANT-LOCK-OMISSION` (Omits POSIX locking): **KILLED**
* `MUTANT-SCORE-WEIGHT` (Ignores task weights, computes unweighted mean): **KILLED**
* `MUTANT-ROLLBACK-BROAD` (Over-deletes all run manifests on rollback): **KILLED**
* `MUTANT-REGISTER-TEXT` (Corrupts binary registers with UTF-8 text conversion): **KILLED**
* **Mutant Kill Rate**: **9/9 KILLED (100% kill rate)**.

### 4. Live Multi-Model Benchmark (`npm run evaluate:live`)
* `LIVE gpt-5.6-sol`: **PASS**
* `LIVE claude-opus-5`: **PASS**
* `OVERALL`: **PASS** (Exit Code: `0`)

---

## Command-Line Interface (CLI) Reference

```bash
evalcampaign <command> [options]
```

| Command | Arguments / Options | Description |
| :--- | :--- | :--- |
| `init` | `<campaign_json_path>` | Initializes a new campaign directory (`.evalcampaign/`). |
| `add-task` | `<task_json_path>` | Registers a task definition (immutable once running). |
| `add-model` | `<model_json_path>` | Registers an evaluation model (immutable once running). |
| `run` | *(none)* | Executes the deterministic campaign schedule. |
| `resume` | *(none)* | Resumes an interrupted campaign from where it stopped. |
| `status` | `[--json]` | Emits lifecycle state, run counts, and budget consumption. |
| `score` | *(none)* | Computes normalized, weighted rankings across models. |
| `register-put` | `--reg <name> <path>` | Stores binary artifact in named scratch register. |
| `register-get` | `--reg <name>` | Streams raw byte payload of register to stdout. |
| `rollback` | `[n]` | Reverts campaign state by `n` completed attempt batches. |
| `export` | `--format json` | Emits immutable evaluation report with sorted keys. |

---

## CLI Exit Code Specification

| Code | Identifier | Triggering Condition |
| :---: | :--- | :--- |
| **`0`** | `SUCCESS` | Command completed cleanly with all invariants satisfied. |
| **`1`** | `USAGE_ERROR` | Missing parameters, unknown CLI command, or uninitialized campaign. |
| **`2`** | `VALIDATION_ERROR` | Schema failure, negative budget values, or duplicate task/model ID. |
| **`3`** | `LOCK_CONTENTION` | Another process holds active POSIX lock on `campaign.lock`. |
| **`4`** | `INVALID_STATE` | Lifecycle guard violation (e.g. adding task while running, resuming completed campaign). |
| **`5`** | `PROVENANCE_DRIFT` | Task definition modified or tampered with on disk out-of-band. |
| **`6`** | `BUDGET_EXCEEDED` | Total attempt limit or wall-clock budget reached. |
| **`7`** | `UNRECOVERABLE_CORRUPTION`| Missing mandatory state files or corrupt internal configuration. |

---

## Getting Started & Installation

### Prerequisites
* Node.js $\ge$ v20.11.0 (Tested on Node v24.17.0)
* bash (Linux / macOS / Git Bash on Windows)

### Build & Setup Scripts
```bash
# 1. Reset campaign runtime state
bash app-setup/reset.sh

# 2. Compile TypeScript and link binary
bash app-setup/build.sh

# 3. Verify runtime availability
bash app-setup/start.sh
```

---

## Running Tests & Verifiers

### 1. Offline Public Test Suite (155 tests)
```bash
npm test
```

### 2. Private Invariant Verifier (9 checks)
```bash
npm run verify
```

### 3. Mutant-Kill Evaluation & Proof-of-Work
```bash
npm run evaluate
```

---

## Live Multi-Model Evaluation

To execute live evaluations against **`gpt-5.6-sol`** and **`claude-opus-5`**:

### Environment Setup
```bash
# Linux / macOS / Git Bash
export EVOLINK_API_KEY="YOUR_EVOLINK_API_KEY"
export EVOLINK_BASE_URL="https://direct.evolink.ai/v1"

# Windows PowerShell
$env:EVOLINK_API_KEY = "YOUR_EVOLINK_API_KEY"
$env:EVOLINK_BASE_URL = "https://direct.evolink.ai/v1"
```

### Execute Live Benchmark
```bash
npm run evaluate:live
```

Expected Output:
```text
LIVE gpt-5.6-sol: PASS
LIVE claude-opus-5: PASS
OVERALL: PASS
```

### Missing Credential Guard (Offline Enforcement)
If `EVOLINK_API_KEY` is omitted, the command immediately aborts before any network request:
```bash
unset EVOLINK_API_KEY
npm run evaluate:live
```
Output:
```text
LIVE gpt-5.6-sol: CONFIGURATION_ERROR
LIVE claude-opus-5: CONFIGURATION_ERROR
OVERALL: FAIL
CONFIGURATION_ERROR: EVOLINK_API_KEY environment variable is not set.
```
*(Exits with status code 1).*

---

## Evidence & Proof-of-Work Artifacts

All benchmark and verification evidence is committed under `evaluation/evidence/`:
* **[`evaluation/evidence/evidence.json`](evaluation/evidence/evidence.json)**:
  Records canonical reference pass logs, mutant kill outcomes, and SHA-256 digest verification.
* **[`evaluation/evidence/live_evidence.json`](evaluation/evidence/live_evidence.json)**:
  Contains sanitized execution records for live model evaluations:
  - Model identifiers (`gpt-5.6-sol`, `claude-opus-5`)
  - Latency measurements
  - Input message SHA-256 hashes
  - Output message SHA-256 hashes
  - Evaluator outcome statuses

---

## Security & Credential Policy

* **No Hardcoded Credentials**: No API keys, Authorization headers, or bearer tokens exist in source code, tests, scripts, or evidence artifacts.
* **Automatic Redaction**: Outbound error strings and traces are filtered via `redactSecrets()` in `src/core/security/redact.ts`.
* **Zero Response Leaks**: Provider responses are evaluated strictly in memory; no raw completion text is logged or exported.
