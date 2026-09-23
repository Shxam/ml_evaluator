#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Remove campaign state and runtime directories
rm -rf "${PROJECT_ROOT}/.evalcampaign"
rm -f "${PROJECT_ROOT}"/.*.tmp

echo "Workspace reset: .evalcampaign and temporary files removed."
