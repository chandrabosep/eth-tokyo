#!/usr/bin/env bash
#
# Self-heal: make sure the chain actually has the contracts on it.
#
# anvil keeps everything in memory and the unit restarts it on failure, so a reboot, an OOM kill
# or a plain crash all bring the node back forked-but-empty. The frontend is a static build that
# holds the manager address, so the site keeps loading and every read quietly returns nothing.
# Without this, that state persists until the next daily reset.
#
# Runs every couple of minutes and on boot. Cheap: one eth_getCode when healthy, which is the
# overwhelmingly common case.
set -euo pipefail

ROOT="${ROOT:-/opt/recycled}"
RPC="${RPC:-http://127.0.0.1:8545}"
BASELINE="$ROOT/infra/expected-addresses.json"

cd "$ROOT"
export PATH="$HOME/.foundry/bin:$PATH"

cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 || { echo "anvil not up yet; leaving it alone"; exit 0; }

# The baseline is the source of truth for what SHOULD be on chain. Without it nothing has been
# deployed yet on this box and the reset job owns that, not this one.
[[ -f "$BASELINE" ]] || { echo "no baseline yet; nothing to verify"; exit 0; }

MANAGER=$(python3 -c "import json;print(json.load(open('$BASELINE'))['optionsManager'])")

if [[ "$(cast code "$MANAGER" --rpc-url "$RPC")" != "0x" ]]; then
  exit 0   # healthy, the common path
fi

echo "manager $MANAGER has no code — chain came back empty, redeploying"
./demo/setup.sh >/dev/null

GOT=$(python3 -c "import json;print(json.load(open('$ROOT/deployments/base-fork.json'))['optionsManager'])")
if [[ "${GOT,,}" != "${MANAGER,,}" ]]; then
  echo "redeploy landed at $GOT but the frontend expects $MANAGER — site will read empty" >&2
  exit 1
fi

systemctl restart recycled-gateway.service 2>/dev/null || sudo systemctl restart recycled-gateway.service
echo "recovered: $MANAGER redeployed and verified"
