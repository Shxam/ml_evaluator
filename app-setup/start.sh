#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Verify evalcampaign is executable
if [ -f "${PROJECT_ROOT}/dist/src/bin/evalcampaign.js" ]; then
  echo "evalcampaign runtime is available."
else
  echo "Error: evalcampaign is not built. Run app-setup/build.sh first." >&2
  exit 1
fi
