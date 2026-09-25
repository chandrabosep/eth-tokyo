#!/usr/bin/env bash
#
# Anvil forking Base mainnet, pinned for reproducibility.
# Real Uniswap v4 PoolManager and real 1inch Aqua are both live at this block.
#
# The chain id is deliberately NOT 8453. Forked state (and therefore every real Base contract
# address) is unaffected by the chain id, but wallets treat a chain id they recognise as a public
# mainnet: MetaMask applies its own Base gas heuristics instead of calling eth_estimateGas on this
# node, and sends transactions with a gas limit far too low for a v4 unlock/modifyLiquidity call,
# which then fails with OutOfGas. Advertising 31337 makes wallets treat it as a local dev chain and
# estimate against the node. It also lets wagmi detect a wrong-network wallet, which it cannot do
# when the fork and real Base share an id.
set -euo pipefail

BASE_RPC_URL="${BASE_RPC_URL:-https://mainnet.base.org}"
FORK_BLOCK="${FORK_BLOCK:-51698307}"

exec anvil \
  --fork-url "$BASE_RPC_URL" \
  --fork-block-number "$FORK_BLOCK" \
  --chain-id "${CHAIN_ID:-31337}" \
  --host 127.0.0.1 \
  --port 8545
