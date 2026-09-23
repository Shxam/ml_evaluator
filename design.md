Technical Design Document: evalcampaign

1. Data Schemas & Serialization

1.1 Campaign Configuration (campaign.json)

JSON

{
  "campaign_id": "coding_eval_v1",
  "name": "Frontier Agent Coding Evaluation",
  "budget": {
    "max_wall_time_seconds": 1800,
    "max_total_attempts": 100,
    "max_output_bytes": 1048576
  },
  "scoring": {
    "aggregation": "weighted_mean",
    "missing_policy": "zero"
  }
}


1.2 Task Definition Schema (tasks/<task_id>.json)

JSON

{
  "task_id": "syntax_validation",
  "command": "python3 mock_eval.py --task=syntax",
  "timeout_seconds": 10,
  "weight": 0.25,
  "retry_policy": {
    "max_attempts": 3,
    "retry_on": ["timeout", "evaluator_crash"]
  }
}


1.3 Run Result Manifest Schema (runs/<run_id>_att<N>.json)

JSON

{
  "run_id": "a1b2c3d4e5f60718",
  "attempt": 1,
  "campaign_id": "coding_eval_v1",
  "campaign_rev": 1,
  "model_id": "claude_opus_5",
  "task_id": "syntax_validation",
  "repetition": 1,
  "status": "COMPLETED",
  "raw_score": 0.0,
  "normalized_score": 0.0,
  "exit_code": 0,
  "execution_time_ms": 1420,
  "stdout_hash": "e3b0c44...",
  "stderr_hash": "a8f5c2d...",
  "completed_at": 1726000020150
}


2. Invariants & Implementation Specifics

2.1 Deterministic Run Derivation

The run ID derivation algorithm must be executed identically across all platforms:

Construct the canonical seed string:
seed = f"{campaign_id}:{campaign_rev}:{model_id}:{task_id}:{repetition}"

Compute the SHA-256 digest in hexadecimal format.

Extract the first 16 characters: run_id = digest[:16].

2.2 Score 0.0 vs. Failure Disambiguation

Python

def classify_execution(exit_code, stdout_data, timed_out):
    if timed_out:
        return ("TIMEOUT", None)
    if exit_code != 0:
        return ("EVALUATOR_CRASH", None)
    
    try:
        parsed = json.loads(stdout_data)
        score = float(parsed["score"])
        # Explicitly check for valid 0.0
        if math.isnan(score) or math.isinf(score):
            return ("MALFORMED_OUTPUT", None)
        return ("COMPLETED", score)
    except (json.JSONDecodeError, KeyError, ValueError):
        return ("MALFORMED_OUTPUT", None)


2.3 Atomic Manifest Writing & Crash Consistency

All state files (state.json, run results, score exports) must adhere to the atomic write contract:

Open a hidden temporary file in the destination folder: f = open(".evalcampaign/state.json.tmp", "w").

Serialize JSON with sort_keys=True and indent formatting.

Flush application buffers: f.flush().

Flush kernel buffers: os.fsync(f.fileno()).

Close file descriptor.

Atomically replace the destination: os.replace(".evalcampaign/state.json.tmp", ".evalcampaign/state.json").

3. Verifier Mutants & Detection Mapping

Mutant Identifier

Subsystem

Targeted Verification Check

Fault Mechanism Injected

MUTANT-ZERO-SCORE

Evaluator Classifier

CHECK-EXEC-001

Evaluates if not score: and treats legitimate score of 0.0 as an evaluator failure.

MUTANT-DIRECT-WRITE

Storage Subsystem

CHECK-CRASH-001

Overwrites state.json directly with open(path, 'w') without temporary atomic swap.

MUTANT-DRIFT-BLIND

Provenance Engine

CHECK-DRIFT-001

Omits checking task SHA-256 hashes against initial baselines prior to execution.

MUTANT-UNSORTED-JSON

Export Subsystem

CHECK-DET-001

Dumps JSON dictionaries without sorting keys, breaking deterministic hash comparisons.

MUTANT-PERMISSIVE-RESUME

Lifecycle Machine

CHECK-STATE-001

Permits resume to execute on a campaign marked as completed.

MUTANT-LOCK-OMISSION

Concurrency Arbiter

CHECK-LOCK-001

Replaces POSIX flock with a basic boolean flag in memory, allowing race conditions.