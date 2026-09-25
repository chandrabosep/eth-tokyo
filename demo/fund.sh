#!/usr/bin/env bash
#
# Fund an arbitrary address on the local Base fork so you can trade from your own wallet
# (MetaMask, Rabby, …) instead of importing a demo private key.
#
#   ./demo/fund.sh 0xYourAddress
#
# Gives 10 ETH for gas plus 500,000 USDC and 100 WETH, pulled from a whale on the fork.
set -euo pipefail

RPC="${RPC:-http://127.0.0.1:8545}"
ADDR="${1:-}"

if [[ -z "$ADDR" ]]; then
  echo "usage: ./demo/fund.sh 0xYourAddress" >&2
  exit 1
fi
if ! [[ "$ADDR" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
  echo "error: '$ADDR' is not a 20-byte address" >&2
  exit 1
fi
if ! cast block-number --rpc-url "$RPC" >/dev/null 2>&1; then
  echo "error: no node at $RPC. Start one with ./demo/anvil.sh" >&2
  exit 1
fi

USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
WETH=0x4200000000000000000000000000000000000006
WHALE=0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb   # Morpho on Base; faucet for the fork only

# An address carrying an EIP-7702 delegation behaves like a contract, and minting an ERC-1155
# position to it fails the receiver check. Warn rather than let it fail later inside a trade.
CODE=$(cast code "$ADDR" --rpc-url "$RPC")
if [[ "$CODE" != "0x" ]]; then
  echo "warning: $ADDR has code on this fork (likely an EIP-7702 delegation or a smart account)."
  echo "         Position mints may revert on the ERC-1155 receiver check. Prefer a plain EOA."
fi

echo "==> funding $ADDR"
cast rpc anvil_setBalance "$ADDR" 0x8AC7230489E80000 --rpc-url "$RPC" >/dev/null   # 10 ETH

cast rpc anvil_impersonateAccount "$WHALE" --rpc-url "$RPC" >/dev/null
cast rpc anvil_setBalance "$WHALE" 0xDE0B6B3A7640000 --rpc-url "$RPC" >/dev/null
cast send "$USDC" "transfer(address,uint256)" "$ADDR" 500000000000 \
  --from "$WHALE" --unlocked --rpc-url "$RPC" >/dev/null
cast send "$WETH" "transfer(address,uint256)" "$ADDR" 100000000000000000000 \
  --from "$WHALE" --unlocked --rpc-url "$RPC" >/dev/null
cast rpc anvil_stopImpersonatingAccount "$WHALE" --rpc-url "$RPC" >/dev/null

echo "    ETH : $(cast balance "$ADDR" --rpc-url "$RPC" | awk '{printf "%.4f", $1/1e18}')"
echo "    USDC: $(cast call "$USDC" 'balanceOf(address)(uint256)' "$ADDR" --rpc-url "$RPC" | awk '{printf "%.2f", $1/1e6}')"
echo "    WETH: $(cast call "$WETH" 'balanceOf(address)(uint256)' "$ADDR" --rpc-url "$RPC" | awk '{printf "%.4f", $1/1e18}')"
echo "==> done"
