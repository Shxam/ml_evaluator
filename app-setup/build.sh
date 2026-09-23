#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

cd "${PROJECT_ROOT}"

# Install dependencies if node_modules missing
if [ ! -d "node_modules" ]; then
  npm install
fi

# Compile TypeScript
npm run build

# Ensure executable permissions on CLI entrypoint
chmod +x "${PROJECT_ROOT}/dist/src/bin/evalcampaign.js"

# Link or export to PATH
if command -v npm >/dev/null 2>&1; then
  npm link --silent || true
fi

echo "Build complete. evalcampaign is ready."
