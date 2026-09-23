#!/usr/bin/env node

import { runCli } from '../cli';

const result = runCli(process.argv);
if (result instanceof Promise) {
  result
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      process.stderr.write(`Unexpected fatal error: ${err.message}\n`);
      process.exit(1);
    });
} else {
  process.exit(result);
}
