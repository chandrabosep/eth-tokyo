#!/usr/bin/env bash
#
# One command to get back to a known-good demo: fresh fork, fresh deploy, fresh seed.
#
#   ./demo/restart.sh [0xAddressToFund ...]
#
# Stops anything already running on the RPC port, starts anvil forking Base, deploys, seeds, and
# funds any addresses you pass. Then start the frontend separately:
#
#   cd frontend && npm run dev
#
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
RPC="${RPC:-http://127.0.0.1:8545}"
LOG="${ANVIL_LOG:-/tmp/recycled-anvil.log}"

echo "==> stopping anything already running"
pkill -f "anvil --fork-url" 2>/dev/null || true
sleep 1

echo "==> starting anvil (fork of Base, chain id 31337)"
nohup ./demo/anvil.sh > "$LOG" 2>&1 &
ANVIL_PID=$!

for _ in $(seq 1 90); do
  if cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then break; fi
  sleep 1
done
if ! cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "error: anvil did not come up. Log: $LOG" >&2
  tail -20 "$LOG" >&2 || true
  exit 1
fi
echo "    anvil pid $ANVIL_PID, chain id $(cast chain-id --rpc-url "$RPC"), block $(cast block-number --rpc-url "$RPC")"
echo "    log: $LOG"

echo "==> deploying + seeding"
./demo/setup.sh >/dev/null
echo "    optionsManager $(python3 -c "import json;print(json.load(open('deployments/base-fork.json'))['optionsManager'])")"

for ADDR in "$@"; do
  ./demo/fund.sh "$ADDR" | sed 's/^/    /'
done

cat <<EOF

==> ready.

   RPC        http://127.0.0.1:8545
   Chain id   31337          <- add this network in your wallet
   Frontend   cd frontend && npm run dev   then http://127.0.0.1:3000

   Do NOT run 'npm run build' while 'npm run dev' is running: the production build
   overwrites .next/ and the dev server then 404s on every chunk.
EOF
