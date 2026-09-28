#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
if [[ -z "${SOLANA_BIN:-}" ]]; then
  PINNED_SOLANA_BIN="$HOME/.local/share/solana/install/releases/4.1.2/solana-release/bin"
  if [[ -x "$PINNED_SOLANA_BIN/solana" ]]; then
    SOLANA_BIN="$PINNED_SOLANA_BIN"
  else
    SOLANA="$(command -v solana || true)"
    SOLANA_BIN="${SOLANA:+$(dirname "$SOLANA")}"
  fi
fi
LOCAL_SO="$ROOT_DIR/target/local/group_pay.so"

if [[ ! -f "$LOCAL_SO" || ! -f "$ROOT_DIR/target/local/group_pay.json" ]]; then
  echo 'Preserved localhost build is missing; run bash scripts/verify-phase2b.sh first' >&2
  exit 1
fi

if [[ ! -x "$SOLANA_BIN/solana" || ! -x "$SOLANA_BIN/solana-test-validator" || ! -x "$SOLANA_BIN/solana-keygen" ]]; then
  echo "Solana CLI 4.1.2 is required; install the version pinned in Anchor.toml" >&2
  exit 1
fi
if [[ "$("$SOLANA_BIN/solana" --version)" != solana-cli\ 4.1.2* ]]; then
  echo "Solana CLI 4.1.2 is required; set SOLANA_BIN to its bin directory" >&2
  exit 1
fi

if (: >/dev/tcp/127.0.0.1/8899) 2>/dev/null; then
  echo "Port 8899 is already in use; refusing to use or stop another validator" >&2
  exit 1
fi

mkdir -p "$ROOT_DIR/target"
LEDGER_DIR="$(mktemp -d /tmp/group-pay-local-ledger.XXXXXX)"
VALIDATOR_LOG="$(mktemp "$ROOT_DIR/target/test-validator.XXXXXX.log")"
TEST_LOG="$(mktemp "$ROOT_DIR/target/test-run.XXXXXX.log")"
TEST_WALLET_DIR="$(mktemp -d /tmp/group-pay-test-wallet.XXXXXX)"
TEST_WALLET="$TEST_WALLET_DIR/id.json"
VALIDATOR_PID=""

cleanup() {
  if [[ -n "$VALIDATOR_PID" ]]; then
    kill "$VALIDATOR_PID" 2>/dev/null || true
    wait "$VALIDATOR_PID" 2>/dev/null || true
  fi
  rm -f -- "$TEST_WALLET"
  rmdir -- "$TEST_WALLET_DIR" 2>/dev/null || true
  if [[ "$LEDGER_DIR" == /tmp/group-pay-local-ledger.* && -d "$LEDGER_DIR" ]]; then
    rm -rf -- "$LEDGER_DIR"
  fi
}
trap cleanup EXIT INT TERM

fail_validator() {
  echo "$1" >&2
  echo "Validator log: $VALIDATOR_LOG" >&2
  tail -n 80 "$VALIDATOR_LOG" >&2 || true
  exit 1
}

if ! "$SOLANA_BIN/solana-keygen" new --no-bip39-passphrase --silent --outfile "$TEST_WALLET" >/dev/null 2>&1; then
  echo "Failed to generate the temporary local test wallet" >&2
  exit 1
fi
TEST_WALLET_ADDRESS="$("$SOLANA_BIN/solana" address --keypair "$TEST_WALLET")"

"$SOLANA_BIN/solana-test-validator" \
  --ledger "$LEDGER_DIR" \
  --reset \
  --mint "$TEST_WALLET_ADDRESS" \
  --bpf-program 6JrQobtnXBeNv4khZhBGCLEEfXk7pJ8Dw1UozaEhXK8R "$LOCAL_SO" \
  >"$VALIDATOR_LOG" 2>&1 &
VALIDATOR_PID=$!

ready=false
for _ in $(seq 1 60); do
  if ! kill -0 "$VALIDATOR_PID" 2>/dev/null; then
    fail_validator "This test validator exited before RPC became ready"
  fi
  if "$SOLANA_BIN/solana" cluster-version --url http://127.0.0.1:8899 >/dev/null 2>&1; then
    if ! kill -0 "$VALIDATOR_PID" 2>/dev/null; then
      fail_validator "This test validator exited while RPC became ready"
    fi
    ready=true
    break
  fi
  sleep 1
done
if [[ "$ready" != true ]]; then
  fail_validator "Timed out waiting for this test validator on port 8899"
fi

if ! "$SOLANA_BIN/solana" account "$TEST_WALLET_ADDRESS" --url http://127.0.0.1:8899 >/dev/null; then
  fail_validator "RPC does not contain this run's unique genesis wallet; refusing a stale validator"
fi
if ! "$SOLANA_BIN/solana" account 6JrQobtnXBeNv4khZhBGCLEEfXk7pJ8Dw1UozaEhXK8R \
  --url http://127.0.0.1:8899 >/dev/null; then
  fail_validator "The expected group-pay program is missing from this test validator"
fi

export ANCHOR_PROVIDER_URL="http://127.0.0.1:8899"
export ANCHOR_WALLET="$TEST_WALLET"
cd "$ROOT_DIR"
echo "Test record: $TEST_LOG"
if npm run test:contract 2>&1 | tee "$TEST_LOG"; then
  echo "Contract test exit code: 0" | tee -a "$TEST_LOG"
else
  status=$?
  echo "Contract test exit code: $status" | tee -a "$TEST_LOG"
  if kill -0 "$VALIDATOR_PID" 2>/dev/null; then
    echo "Validator process $VALIDATOR_PID is still alive after test failure" | tee -a "$TEST_LOG"
  else
    echo "Validator process $VALIDATOR_PID exited during the tests" | tee -a "$TEST_LOG"
  fi
  if [[ -f "$LEDGER_DIR/validator.log" ]]; then
    echo "=== validator internal log tail ===" | tee -a "$TEST_LOG"
    tail -n 80 "$LEDGER_DIR/validator.log" | tee -a "$TEST_LOG"
  fi
  echo "=== validator process / memory ===" | tee -a "$TEST_LOG"
  ps -o pid,stat,rss,cmd -p "$VALIDATOR_PID" 2>&1 | tee -a "$TEST_LOG" || true
  free -m 2>&1 | tee -a "$TEST_LOG" || true
  exit "$status"
fi
