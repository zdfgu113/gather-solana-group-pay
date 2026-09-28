#!/usr/bin/env bash
# Preserve the default localhost build before a Devnet feature build replaces target/deploy.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
node - <<'NODE'
const fs = require('node:fs');
const idl = JSON.parse(fs.readFileSync('target/idl/group_pay.json', 'utf8'));
if (idl.address !== '6JrQobtnXBeNv4khZhBGCLEEfXk7pJ8Dw1UozaEhXK8R' ||
    !JSON.stringify(idl).includes('9C6hybhQ6Aycep9jaUnP6uL9ZYvDjUp1aSkFWPUFJtpj')) {
  throw Error('Default build is not the localhost fixture; refusing to preserve it as local.');
}
NODE
if ! cmp -s target/idl/group_pay.json ../src/idl/group_pay.json ||
   ! cmp -s target/types/group_pay.ts ../src/idl/group_pay.ts; then
  echo 'Generated localhost IDL/types differ from the published localhost files; review before staging.' >&2
  exit 2
fi
mkdir -p target/local
cp target/deploy/group_pay.so target/local/group_pay.so
cp target/idl/group_pay.json target/local/group_pay.json
echo 'Preserved localhost program and IDL in target/local; published local IDL/types match.'
