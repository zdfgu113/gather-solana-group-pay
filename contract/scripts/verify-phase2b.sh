#!/usr/bin/env bash
set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR" || exit 1
mkdir -p target
LOG_FILE="$(mktemp "$ROOT_DIR/target/phase2b-verify.XXXXXX.log")"
STATUS_FILE="${LOG_FILE%.log}.status"
echo "Phase 2B full log: $LOG_FILE" | tee "$LOG_FILE"
echo "Phase 2B status: $STATUS_FILE" | tee "$STATUS_FILE"
trap 'result=$?; echo "phase2bExit=$result" | tee -a "$LOG_FILE" "$STATUS_FILE"' EXIT

run_step() {
  local name="$1"
  shift
  echo "=== $name ===" | tee -a "$LOG_FILE"
  "$@" 2>&1 | tee -a "$LOG_FILE"
  local result=${PIPESTATUS[0]}
  echo "${name}Exit=$result" | tee -a "$LOG_FILE" "$STATUS_FILE"
  return "$result"
}

run_step npmCi npm ci --cache .npm-cache || exit 1
run_step build anchor build --ignore-keys || exit 1
run_step stageLocal bash scripts/stage-local-build.sh || exit 1
run_step typecheck node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json || exit 1
run_step unit npm run test:unit || exit 1
run_step integration bash scripts/test-local.sh || exit 1
