#!/usr/bin/env bash
#
# Brings up the whole demo on a Base mainnet fork:
#   1. funds the demo accounts with real WETH/USDC (impersonating a whale on the fork)
#   2. deploys the hook + OptionsManager and initialises the pool
#   3. seeds a shipped Aqua offer, a written short, a bought long, and accrued premium
#
# Prereq: anvil forking Base must already be running --
#   ./demo/anvil.sh
#
set -euo pipefail

RPC="${RPC:-http://127.0.0.1:8545}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
WETH=0x4200000000000000000000000000000000000006
# Morpho on Base: ~221M USDC and ~80k WETH. Only used as a faucet on the local fork.
WHALE=0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb

# Demo accounts. NOT anvil's defaults: every one of anvil's well-known addresses carries an
# EIP-7702 delegation on Base mainnet (their keys are public), which makes them behave like
# contracts on a fork and fail the ERC-1155 receiver check when a position is minted to them.
# These are derived from `cast keccak "recycled.<role>.v1"` and have no code on Base.
DEPLOYER_PK=0xf9cd7ddb26085e7fc4e8037ca83cb802580aaec388206fda702e618790f3579c
ACCOUNTS=(
  0x637a2F455b2D47ecE29E2Ec5FECb278a8c195949   # deployer / swapper
  0x260529A5889B22dB02E0e8c1F90A7415084dF54E   # seller
  0x3F8bC758CBCc3bB199FC7799f96D24aeEf242999   # buyer
)

if ! cast block-number --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "error: no node at $RPC. Start one first with ./demo/anvil.sh" >&2
  exit 1
fi

echo "==> funding demo accounts from whale $WHALE"
cast rpc anvil_impersonateAccount "$WHALE" --rpc-url "$RPC" >/dev/null
cast rpc anvil_setBalance "$WHALE" 0xDE0B6B3A7640000 --rpc-url "$RPC" >/dev/null

for A in "${ACCOUNTS[@]}"; do
  cast rpc anvil_setBalance "$A" 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null
  cast send "$USDC" "transfer(address,uint256)" "$A" 500000000000 \
    --from "$WHALE" --unlocked --rpc-url "$RPC" >/dev/null
  cast send "$WETH" "transfer(address,uint256)" "$A" 200000000000000000000 \
    --from "$WHALE" --unlocked --rpc-url "$RPC" >/dev/null
  echo "    $A  <- 500,000 USDC + 200 WETH"
done

cast rpc anvil_stopImpersonatingAccount "$WHALE" --rpc-url "$RPC" >/dev/null

echo "==> deploying"
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$RPC" --broadcast \
  --private-key "$DEPLOYER_PK" \
  -q

echo "==> seeding demo positions"
forge script script/Seed.s.sol:Seed --rpc-url "$RPC" --broadcast -q

echo
echo "==> done. Deployment:"
cat deployments/base-fork.json
echo
echo "Next: cd frontend && npm install && npm run dev"
