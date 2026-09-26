#!/usr/bin/env bash
#
# Keep the demo fork alive: track the real ETH price, and trade through the book while doing it.
#
#   ./demo/churn.sh              one round
#   ./demo/churn.sh --loop       every CHURN_INTERVAL seconds until interrupted
#
# Two problems, one mechanism.
#
# A fork is frozen at the block it was made from, so its ETH price is whatever it was that minute
# and stays there. Judges know what ETH is trading at; a chain insisting it is $2,633 three days
# later is the kind of detail that makes the rest look fake. So each round reads the real mid off
# Hyperliquid -- the same venue the strategies page already reads positions from -- and walks the
# pool toward it.
#
# And premium in this protocol IS the pool's swap fee: feeGrowthInside, accruing only while spot is
# inside a written range. A book with no flow through it pays its writers nothing, however much is
# written. Walking the price is itself flow, and when there is no gap left to close the round
# wanders a few ticks instead, so the in-range writers are paid on a flat tape too.
#
# Runs from one of three throwaway trader accounts, picked per round, so the tape does not read as
# one address talking to itself.
#
# CHURN_INTERVAL is not a free knob. The hook samples realised volatility as dTick^2/dt on every
# swap, so the interval and the step size together decide what the market looks like: the default
# 90s against Churn.s.sol's 12-tick cap reads as roughly 70% annualised, which is the order of
# magnitude ETH actually trades at. Running it every 10 seconds does not make the demo livelier,
# it makes the pool look like it is moving 6% a minute and pins the volatility fee at its ceiling.
set -euo pipefail

ROOT="${ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
RPC="${RPC:-http://127.0.0.1:8545}"
DEPLOYMENT="${DEPLOYMENT:-$ROOT/deployments/base-fork.json}"
INTERVAL="${CHURN_INTERVAL:-90}"

cd "$ROOT"
export PATH="$HOME/.foundry/bin:$PATH"

# Uniswap v4's StateView on Base, which the fork inherits along with the rest of mainnet state.
# Reads PoolManager storage without an unlock, which is the only way to see the tick from outside
# a transaction.
STATE_VIEW=0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71

# Derived from `cast keccak "recycled.trader<n>.v1"`, like the rest of the demo accounts, and for
# the same reason: anvil's own keys are public, so every one of them carries an EIP-7702 delegation
# on Base and behaves like a contract on a fork of it.
TRADERS=(
  0xaf75f28fce251b352c10fd8bb1f822982c6eca4b5ea433c4372d521214a6981e
  0xa187817000b83f6e64b8abbbf0d4eea90340e44153b432585f5f108415b54e35
  0x187c546cefd799205ed4f32975937ea6c53e1bdf6d69e95301d32c65f0ae336d
)

# ETH/USD, from Hyperliquid's public mids. Empty on any failure: the caller falls back to churning
# in place rather than skipping the round, because the swaps matter more than the target.
real_eth_price() {
  curl -s --max-time 8 -X POST https://api.hyperliquid.xyz/info \
    -H 'content-type: application/json' \
    -d '{"type":"allMids"}' 2>/dev/null |
    python3 -c "import json,sys; print(json.load(sys.stdin).get('ETH',''))" 2>/dev/null || true
}

# The pool's current tick.
pool_tick() {
  cast call "$STATE_VIEW" "getSlot0(bytes32)(uint160,int24,uint24,uint24)" "$1" --rpc-url "$RPC" |
    sed -n 2p | awk '{print $1}'
}

# The pool prices USDC per WETH as 1.0001^tick, scaled by the 18-vs-6 decimal gap, so a target in
# dollars is just a logarithm. A few ticks of noise keep consecutive rounds from all pulling the
# same way; 0 means "no target", which Churn.s.sol reads as "stay where you are".
target_tick_for() {
  python3 -c "
import math, random, sys
p = sys.argv[1].strip()
try:
    usd = float(p) if p else 0.0
except ValueError:
    usd = 0.0
print(0 if usd <= 0 else round(math.log(usd / 10 ** 12) / math.log(1.0001)) + random.randint(-4, 4))
" "$1"
}

report() {
  python3 -c "
import sys
usd = lambda t: 1.0001 ** int(t) * 10 ** 12
before, after, target, real = sys.argv[1:5]
line = f'    fork \${usd(before):,.2f} -> \${usd(after):,.2f}'
if int(target) != 0:
    line += f'  (target \${usd(target):,.2f}'
    line += f', real ETH \${float(real):,.2f})' if real else ')'
else:
    line += '  (no target; churned in place)'
print(line)
" "$1" "$2" "$3" "${4:-}"
}

round() {
  cast chain-id --rpc-url "$RPC" >/dev/null 2>&1 || { echo "    no node at $RPC"; return 0; }
  [[ -f "$DEPLOYMENT" ]] || { echo "    nothing deployed yet"; return 0; }

  local manager pool_id target price pk before after
  manager=$(python3 -c "import json;print(json.load(open('$DEPLOYMENT'))['optionsManager'])")
  # A chain that came back empty belongs to the reset job, not to this one.
  [[ "$(cast code "$manager" --rpc-url "$RPC")" != "0x" ]] || { echo "    chain is empty; leaving it alone"; return 0; }

  price=$(real_eth_price)
  target=$(target_tick_for "$price")
  pk="${TRADERS[$((RANDOM % ${#TRADERS[@]}))]}"

  pool_id=$(cast call "$manager" "poolId()(bytes32)" --rpc-url "$RPC")
  before=$(pool_tick "$pool_id")

  if ! CHURN_PK="$pk" TARGET_TICK="$target" SEED="$RANDOM" \
    forge script script/Churn.s.sol:Churn --rpc-url "$RPC" --broadcast -q >/dev/null 2>&1; then
    echo "    round failed; leaving the chain as it was"
    return 0
  fi

  after=$(pool_tick "$pool_id")
  report "$before" "$after" "$target" "$price"
}

if [[ "${1:-}" == "--loop" ]]; then
  echo "==> churning every ${INTERVAL}s. Ctrl-C to stop."
  while true; do
    round || true
    sleep "$INTERVAL"
  done
else
  round
fi
