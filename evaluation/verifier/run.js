#!/usr/bin/env node
const path = require('path');
const { runAllChecks, runCheck, CHECKS } = require('./index');

function parseArgs(args) {
  let cliPath = null;
  let checkId = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--cli' && i + 1 < args.length) {
      cliPath = path.resolve(args[++i]);
    } else if (args[i] === '--check' && i + 1 < args.length) {
      checkId = args[++i];
    }
  }
  return { cliPath, checkId };
}

function main() {
  const { cliPath, checkId } = parseArgs(process.argv.slice(2));

  console.log(`[VERIFIER] Target CLI: ${cliPath || 'REFERENCE (dist/src/bin/evalcampaign.js)'}`);

  if (checkId) {
    const res = runCheck(checkId, cliPath);
    console.log(`[${res.pass ? 'PASS' : 'FAIL'}] ${res.id} - ${res.name} (${res.durationMs}ms)`);
    if (!res.pass) {
      console.error(`  Error: ${res.error}`);
      process.exit(1);
    }
    process.exit(0);
  }

  const { pass, results } = runAllChecks(cliPath);
  console.log('\n--- VERIFIER RESULTS ---');
  for (const r of results) {
    console.log(`[${r.pass ? 'PASS' : 'FAIL'}] ${r.id} - ${r.name} (${r.durationMs}ms)`);
    if (!r.pass) {
      console.error(`  Reason: ${r.error}`);
    }
  }

  const passedCount = results.filter(r => r.pass).length;
  console.log(`\nSummary: ${passedCount}/${results.length} checks passed.`);
  process.exit(pass ? 0 : 1);
}

main();
