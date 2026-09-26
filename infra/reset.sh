#!/usr/bin/env bash
#
# Rebuild the demo fork: fresh chain, fresh deploy, fresh seed.
#
# Run by recycled-reset.timer daily, or by hand during a demo:
#     sudo systemctl start recycled-reset.service
#
# The verification step at the end is the point of this script existing rather than being three
# lines in the timer. The frontend is a static build that holds optionsHook / optionsManager
# addresses baked in at build time. If a rebuild ever produces different addresses, the site keeps
# loading and every read returns empty — the symptom is "the app is broken", not "the reset moved
# the contracts". So this asserts the addresses instead of hoping.
#
# They are deterministic today: the hook is CREATE2 (mined against the canonical deployer, so it
# depends on bytecode, not nonce) and the manager is a nonce-based deploy from a fixed key onto a
# chain that always resets to the same forked block. "Deterministic today" is exactly the kind of
# thing that stops being true quietly.
set -euo pipefail

ROOT="${ROOT:-/opt/recycled}"
RPC="${RPC:-http://127.0.0.1:8545}"
DEPLOYMENT="$ROOT/deployments/base-fork.json"
EXPECTED="$ROOT/infra/expected-addresses.json"

cd "$ROOT"
export PATH="$HOME/.foundry/bin:$PATH"

echo "==> stopping anvil"
sudo systemctl stop recycled-anvil.service

echo "==> starting anvil"
sudo systemctl start recycled-anvil.service

for _ in $(seq 1 90); do
  cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 && break
  sleep 1
done
if ! cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "error: anvil did not come up" >&2
  exit 1
fi
echo "    chain $(cast chain-id --rpc-url "$RPC") at block $(cast block-number --rpc-url "$RPC")"

echo "==> deploying + seeding"
./demo/setup.sh >/dev/null

echo "==> verifying addresses against $EXPECTED"
if [[ ! -f "$EXPECTED" ]]; then
  echo "    no baseline yet — recording the current deploy as the baseline"
  python3 - "$DEPLOYMENT" "$EXPECTED" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
json.dump({k: d[k] for k in ("optionsHook", "optionsManager")}, open(sys.argv[2], "w"), indent=2)
PY
else
  python3 - "$DEPLOYMENT" "$EXPECTED" <<'PY'
import json, sys
got = json.load(open(sys.argv[1]))
want = json.load(open(sys.argv[2]))
bad = [k for k, v in want.items() if got.get(k, "").lower() != v.lower()]
if bad:
    for k in bad:
        print(f"    MISMATCH {k}: expected {want[k]}, got {got.get(k)}", file=sys.stderr)
    print("    the frontend is built against the expected addresses and will read empty", file=sys.stderr)
    sys.exit(1)
print("    addresses match")
PY
fi

echo "==> restarting gateway"
sudo systemctl restart recycled-gateway.service

echo "==> ready. $(cast block-number --rpc-url "$RPC") blocks, manager $(python3 -c "import json;print(json.load(open('$DEPLOYMENT'))['optionsManager'])")"
