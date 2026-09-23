#!/usr/bin/env node

/**
 * Live multi-model evaluation harness for EvoLink.
 * Evaluates gpt-5.6-sol and claude-opus-5 end-to-end via evalcampaign.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const CLI_BIN = path.join(PROJECT_ROOT, 'dist/src/bin/evalcampaign.js');
const EVAL_TASK_BIN = path.join(PROJECT_ROOT, 'dist/src/bin/evalTask.js');
const EVIDENCE_DIR = path.join(PROJECT_ROOT, 'evaluation/evidence');

const MODELS_TO_EVALUATE = ['gpt-5.6-sol', 'claude-opus-5'];

function redact(text) {
  if (!text || typeof text !== 'string') return text;
  let res = text;
  const key = process.env.EVOLINK_API_KEY;
  if (key && key.length >= 4) {
    res = res.split(key).join('[REDACTED]');
  }
  res = res.replace(/Bearer\s+[A-Za-z0-9_\-\.]+/gi, 'Bearer [REDACTED]');
  res = res.replace(/sk-[A-Za-z0-9_\-]{8,}/gi, '[REDACTED]');
  return res;
}

function classifyErrorFromStderr(stderr) {
  const clean = redact(stderr || '');
  if (/AUTHENTICATION_ERROR|HTTP 401|HTTP 403|Unauthorized|Forbidden/i.test(clean)) {
    return 'AUTHENTICATION_ERROR';
  }
  if (/CONFIGURATION_ERROR|missing or empty/i.test(clean)) {
    return 'CONFIGURATION_ERROR';
  }
  // HTTP 402, 429, 5xx, timeouts, network issues all map to PROVIDER_ERROR
  return 'PROVIDER_ERROR';
}

async function main() {
  // 1. Mandatory Pre-flight check: Key must exist before any network access
  const apiKey = process.env.EVOLINK_API_KEY;
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
    for (const m of MODELS_TO_EVALUATE) {
      console.log(`LIVE ${m}: CONFIGURATION_ERROR`);
    }
    console.log('OVERALL: FAIL');
    process.stderr.write('CONFIGURATION_ERROR: EVOLINK_API_KEY environment variable is not set.\n');
    process.exit(1);
  }

  // 2. Set up temporary campaign directory
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evalcampaign-live-'));

  try {
    // 3. Initialize campaign
    const campConfig = {
      campaign_id: 'live_evolink_benchmark',
      name: 'EvoLink Live Multi-Model Benchmark',
      repetitions: 1,
      budget: {
        max_wall_time_seconds: 120,
        max_total_attempts: 10,
        max_output_bytes: 4096
      },
      scoring: {
        aggregation: 'weighted_mean',
        missing_policy: 'zero'
      }
    };

    const campPath = path.join(workDir, 'campaign.json');
    fs.writeFileSync(campPath, JSON.stringify(campConfig, null, 2), 'utf8');

    const initRes = spawnSync(process.execPath, [CLI_BIN, 'init', campPath], {
      cwd: workDir,
      encoding: 'utf8'
    });

    if (initRes.status !== 0) {
      process.stderr.write(`Failed to initialize campaign: ${redact(initRes.stderr)}\n`);
      for (const m of MODELS_TO_EVALUATE) {
        console.log(`LIVE ${m}: CONFIGURATION_ERROR`);
      }
      console.log('OVERALL: FAIL');
      process.exit(1);
    }

    // 4. Register benchmark models
    for (const modelId of MODELS_TO_EVALUATE) {
      const modelDef = {
        model_id: modelId,
        name: `EvoLink Candidate: ${modelId}`,
        provider: 'evolink'
      };
      const modelPath = path.join(workDir, `model_${modelId.replace(/[^a-zA-Z0-9]/g, '_')}.json`);
      fs.writeFileSync(modelPath, JSON.stringify(modelDef, null, 2), 'utf8');

      const addModelRes = spawnSync(process.execPath, [CLI_BIN, 'add-model', modelPath], {
        cwd: workDir,
        encoding: 'utf8'
      });
      if (addModelRes.status !== 0) {
        process.stderr.write(`Failed to add model ${modelId}: ${redact(addModelRes.stderr)}\n`);
        process.exit(1);
      }
    }

    // 5. Register benchmark task: instruction_following
    const taskDef = {
      task_id: 'instruction_following',
      command: `node "${EVAL_TASK_BIN}"`,
      timeout_seconds: 40,
      weight: 1.0,
      retry_policy: {
        max_attempts: 2,
        retry_on: ['evaluator_crash', 'timeout']
      }
    };
    const taskPath = path.join(workDir, 'task_instruction_following.json');
    fs.writeFileSync(taskPath, JSON.stringify(taskDef, null, 2), 'utf8');

    const addTaskRes = spawnSync(process.execPath, [CLI_BIN, 'add-task', taskPath], {
      cwd: workDir,
      encoding: 'utf8'
    });
    if (addTaskRes.status !== 0) {
      process.stderr.write(`Failed to add task: ${redact(addTaskRes.stderr)}\n`);
      process.exit(1);
    }

    // 6. Execute campaign
    const runRes = spawnSync(process.execPath, [CLI_BIN, 'run'], {
      cwd: workDir,
      encoding: 'utf8',
      env: { ...process.env }
    });

    // 7. Parse attempt manifests from .evalcampaign/runs/
    const runsDir = path.join(workDir, '.evalcampaign', 'runs');
    const runFiles = fs.existsSync(runsDir)
      ? fs.readdirSync(runsDir).filter(f => f.endsWith('.json'))
      : [];

    const manifests = runFiles.map(f => {
      try {
        return JSON.parse(fs.readFileSync(path.join(runsDir, f), 'utf8'));
      } catch {
        return null;
      }
    }).filter(Boolean);

    const modelClassifications = {};
    const modelRunsEvidence = {};

    for (const modelId of MODELS_TO_EVALUATE) {
      const modelManifests = manifests.filter(m => m.model_id === modelId);

      if (modelManifests.length === 0) {
        // Run failed before producing manifest
        const category = classifyErrorFromStderr(runRes.stderr);
        modelClassifications[modelId] = category;
        modelRunsEvidence[modelId] = [{
          model: modelId,
          task_id: 'instruction_following',
          attempt: 1,
          status: category,
          latency: 0,
          input_sha256: null,
          output_sha256: null,
          error_category: category
        }];
        continue;
      }

      // Check latest attempt manifest for this model
      const latestManifest = modelManifests[modelManifests.length - 1];
      const runsMetadata = modelManifests.map(m => {
        let parsedStdout = {};
        try {
          parsedStdout = JSON.parse(m.stdout.trim());
        } catch {
          // ignore
        }
        return {
          model: modelId,
          task_id: m.task_id,
          attempt: m.attempt,
          status: m.status,
          latency: parsedStdout.latency_ms || m.execution_time_ms || 0,
          input_sha256: parsedStdout.input_sha256 || null,
          output_sha256: parsedStdout.output_sha256 || null,
          error_category: m.status === 'COMPLETED' ? null : classifyErrorFromStderr(m.stderr)
        };
      });

      modelRunsEvidence[modelId] = runsMetadata;

      if (latestManifest.status === 'COMPLETED') {
        modelClassifications[modelId] = 'PASS';
      } else {
        const category = classifyErrorFromStderr(latestManifest.stderr || runRes.stderr);
        modelClassifications[modelId] = category;
      }
    }

    // 8. Print clean classified output
    for (const modelId of MODELS_TO_EVALUATE) {
      const status = modelClassifications[modelId] || 'PROVIDER_ERROR';
      console.log(`LIVE ${modelId}: ${status}`);
    }

    const allPassed = MODELS_TO_EVALUATE.every(m => modelClassifications[m] === 'PASS');
    console.log(`OVERALL: ${allPassed ? 'PASS' : 'FAIL'}`);

    // 9. Generate and persist sanitized live evidence artifact
    if (!fs.existsSync(EVIDENCE_DIR)) {
      fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    }

    const flatEvidenceList = [];
    for (const modelId of MODELS_TO_EVALUATE) {
      const runs = modelRunsEvidence[modelId] || [];
      for (const r of runs) {
        flatEvidenceList.push({
          model: r.model,
          task_id: r.task_id,
          attempt: r.attempt,
          status: r.status,
          latency: r.latency,
          input_sha256: r.input_sha256,
          output_sha256: r.output_sha256,
          error_category: r.error_category
        });
      }
    }

    const liveEvidence = {
      evaluation_id: 'STAGE-9-LIVE-EVALUATION-EVIDENCE',
      timestamp: new Date().toISOString(),
      provider: 'evolink',
      endpoint: 'https://direct.evolink.ai/v1/chat/completions',
      models_evaluated: MODELS_TO_EVALUATE,
      evidence_records: flatEvidenceList,
      overall_outcome: allPassed ? 'PASS' : 'FAIL'
    };

    const evidenceJson = JSON.stringify(liveEvidence, null, 2);
    const sanitizedEvidenceJson = redact(evidenceJson);
    const evidencePath = path.join(EVIDENCE_DIR, 'live_evidence.json');
    fs.writeFileSync(evidencePath, sanitizedEvidenceJson, 'utf8');

    // 10. Exit code contract
    if (!allPassed) {
      process.exit(1);
    }
    process.exit(0);

  } finally {
    // Clean up temporary workspace
    try {
      if (fs.existsSync(workDir)) {
        fs.rmSync(workDir, { recursive: true, force: true });
      }
    } catch {
      // ignore
    }
  }
}

main();
