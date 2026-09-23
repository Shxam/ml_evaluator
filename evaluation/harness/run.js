#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runAllChecks, runCheck } = require('../verifier/index');
const { REFERENCE_CLI, PROJECT_ROOT } = require('../verifier/utils');

const MUTANTS = [
  {
    id: 'MUTANT-ZERO-SCORE',
    targetCheck: 'CHECK-EXEC-001',
    cliPath: path.resolve(PROJECT_ROOT, 'evaluation/mutants/mutant_zero_score/bin/evalcampaign.js'),
    description: 'Interprets valid score 0.0 as failure / malformed output'
  },
  {
    id: 'MUTANT-DIRECT-WRITE',
    targetCheck: 'CHECK-CRASH-001',
    cliPath: path.resolve(PROJECT_ROOT, 'evaluation/mutants/mutant_direct_write/bin/evalcampaign.js'),
    description: 'Replaces atomic state/manifest persistence with direct in-place writes'
  },
  {
    id: 'MUTANT-DRIFT-BLIND',
    targetCheck: 'CHECK-DRIFT-001',
    cliPath: path.resolve(PROJECT_ROOT, 'evaluation/mutants/mutant_drift_blind/bin/evalcampaign.js'),
    description: 'Disables task definition SHA-256 provenance check'
  },
  {
    id: 'MUTANT-UNSORTED-JSON',
    targetCheck: 'CHECK-DET-001',
    cliPath: path.resolve(PROJECT_ROOT, 'evaluation/mutants/mutant_unsorted_json/bin/evalcampaign.js'),
    description: 'Emits JSON without canonical deterministic key ordering'
  },
  {
    id: 'MUTANT-PERMISSIVE-RESUME',
    targetCheck: 'CHECK-STATE-001',
    cliPath: path.resolve(PROJECT_ROOT, 'evaluation/mutants/mutant_permissive_resume/bin/evalcampaign.js'),
    description: 'Allows resume execution when campaign is already in completed state'
  },
  {
    id: 'MUTANT-LOCK-OMISSION',
    targetCheck: 'CHECK-LOCK-001',
    cliPath: path.resolve(PROJECT_ROOT, 'evaluation/mutants/mutant_lock_omission/bin/evalcampaign.js'),
    description: 'Omits genuine POSIX advisory locking and kernel contention'
  },
  {
    id: 'MUTANT-SCORE-WEIGHT',
    targetCheck: 'CHECK-SCORE-001',
    cliPath: path.resolve(PROJECT_ROOT, 'evaluation/mutants/mutant_score_weight/bin/evalcampaign.js'),
    description: 'Computes unweighted score average, ignoring task weights'
  },
  {
    id: 'MUTANT-ROLLBACK-BROAD',
    targetCheck: 'CHECK-ROLLBACK-001',
    cliPath: path.resolve(PROJECT_ROOT, 'evaluation/mutants/mutant_rollback_broad/bin/evalcampaign.js'),
    description: 'Overly broad rollback that deletes all run manifests'
  },
  {
    id: 'MUTANT-REGISTER-TEXT',
    targetCheck: 'CHECK-REGISTER-001',
    cliPath: path.resolve(PROJECT_ROOT, 'evaluation/mutants/mutant_register_text/bin/evalcampaign.js'),
    description: 'Corrupts binary register payloads with UTF-8 text encoding and newlines'
  }
];

function main() {
  const startTime = Date.now();

  // 1. Evaluate Reference Implementation
  const refResult = runAllChecks(REFERENCE_CLI);
  if (!refResult.pass) {
    console.error('REFERENCE: FAIL');
    for (const r of refResult.results) {
      if (!r.pass) console.error(`  [${r.id}] ${r.name}: ${r.error}`);
    }
    process.exit(1);
  }

  // 2. Evaluate Each Mutant Against Its Target Check
  const mutantResults = [];
  let allMutantsKilled = true;

  for (const m of MUTANTS) {
    const res = runCheck(m.targetCheck, m.cliPath);
    // A mutant is KILLED if its targeted observable check FAILS (!res.pass)
    const killed = !res.pass;
    if (!killed) {
      allMutantsKilled = false;
    }
    mutantResults.push({
      mutant_id: m.id,
      targeted_check: m.targetCheck,
      description: m.description,
      status: killed ? 'KILLED' : 'SURVIVED',
      killed_by_error: res.error,
      check_duration_ms: res.durationMs
    });
  }

  // 3. Emit Required Clean Standard Output
  console.log('REFERENCE: PASS\n');
  for (const mr of mutantResults) {
    console.log(`${mr.mutant_id}: ${mr.status}`);
  }

  // 4. Generate Proof-of-Work / Verification Evidence Artifact
  const evidenceDir = path.resolve(PROJECT_ROOT, 'evaluation/evidence');
  if (!fs.existsSync(evidenceDir)) {
    fs.mkdirSync(evidenceDir, { recursive: true });
  }

  const evidenceData = {
    evaluation_id: 'STAGE-8-VERIFICATION-EVIDENCE',
    timestamp: new Date().toISOString(),
    reference_result: 'PASS',
    total_checks: refResult.results.length,
    reference_checks: refResult.results.map(r => ({
      id: r.id,
      name: r.name,
      status: r.pass ? 'PASS' : 'FAIL',
      duration_ms: r.durationMs
    })),
    mutants_total: MUTANTS.length,
    mutants_killed: mutantResults.filter(m => m.status === 'KILLED').length,
    mutants_survived: mutantResults.filter(m => m.status === 'SURVIVED').length,
    mutants: mutantResults,
    overall_outcome: (refResult.pass && allMutantsKilled) ? 'SUCCESS' : 'FAILURE'
  };

  const canonicalEvidenceJson = JSON.stringify(evidenceData, Object.keys(evidenceData).sort(), 2);
  const evidenceHash = crypto.createHash('sha256').update(canonicalEvidenceJson).digest('hex');
  evidenceData.evidence_sha256 = evidenceHash;

  const finalEvidenceJson = JSON.stringify(evidenceData, null, 2);
  fs.writeFileSync(path.join(evidenceDir, 'evidence.json'), finalEvidenceJson, 'utf8');

  if (!allMutantsKilled) {
    process.exit(1);
  }
  process.exit(0);
}

main();
