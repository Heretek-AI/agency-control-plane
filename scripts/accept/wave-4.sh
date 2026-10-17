#!/usr/bin/env bash
# Wave 4 acceptance: pinned-key approvals, real workers + Director, durable
# board, NATS bridge, and a browser-run WebUI served by the dispatcher.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

echo "[wave-4] bun install"
bun install --frozen-lockfile --ignore-scripts

echo "[wave-4] typecheck (dispatcher + web)"
bun run check

echo "[wave-4] zero-stub grep (must print nothing)"
W1='TO'"DO"
W2='FI'"XME"
W3='X'"XX"
W4='HA'"CK"
W5='not implemen'"ted"
W8='ret'"urn true;"
P_STUB="${W1}|${W2}|${W3}|${W4}|${W5}|${W8}|catch *\(.*\) *\{\}"
STUBS="$(grep -rn --include='*.ts' --include='*.tsx' -E "${P_STUB}" dispatcher/src web/src scripts/build-web.ts scripts/e2e || [ $? -eq 1 ])"
if [ -n "$STUBS" ]; then
  echo "$STUBS"
  echo "[wave-4] FAIL: stub patterns found" >&2
  exit 1
fi

echo "[wave-4] no client-trusted approval keys or passphrase verification on the server"
if grep -n -E 'record\["publicKey|passphraseToKeypair|verifyApprovalSignature' dispatcher/src/*.ts; then
  echo "[wave-4] FAIL: server still trusts client key material" >&2
  exit 1
fi

echo "[wave-4] approval attacks, es-core key compatibility, launcher, Director, persistence, NATS"
bun test dispatcher/test/approvals.test.ts dispatcher/test/human-key.test.ts dispatcher/test/launcher.test.ts dispatcher/test/nats-bridge.test.ts dispatcher/test/lifecycle.test.ts

echo "[wave-4] browser build"
bun run build:web

echo "[wave-4] Chromium smoke test against a served dispatcher (writes docs/evidence/ui.png)"
bun run e2e:ui

echo "[wave-4] PASS"
