import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

import { NETWORKS, selectedNetwork, type Deployment } from "./networks";

export type { Deployment };

/**
 * The contracts this page load is talking to.
 *
 * Resolved once, at module scope, from the network the user picked — see `lib/networks.ts` for why
 * switching reloads rather than re-rendering. Everything downstream can therefore go on importing
 * a plain object instead of threading a hook through seventy call sites.
 */
export const activeNetwork = NETWORKS[selectedNetwork()];

export const deployed: Deployment = activeNetwork.deployment;

/** Uniswap v4 StateView on Base — reads PoolManager storage without an unlock. */
export const STATE_VIEW: Address = "0xA3c0c9b65baD0b08107Aa264b0f3dB444b867A71";

export const WETH_DECIMALS = 18;
export const USDC_DECIMALS = 6;

export const poolKey = {
  currency0: deployed.weth,
  currency1: deployed.usdc,
  fee: deployed.fee,
  tickSpacing: deployed.tickSpacing,
  hooks: deployed.optionsHook,
} as const;

/** PoolId is keccak256 of the abi-encoded PoolKey — same as PoolIdLibrary.toId(). */
export const poolId: Hex = keccak256(
  encodeAbiParameters(
    [
      { type: "address" },
      { type: "address" },
      { type: "uint24" },
      { type: "int24" },
      { type: "address" },
    ],
    [poolKey.currency0, poolKey.currency1, poolKey.fee, poolKey.tickSpacing, poolKey.hooks],
  ),
);

/** Strikes are fixed dollar levels, so a strike labels itself. */
export function strikeLabel(index: number): string {
  const usd = deployed.strikeUsd?.[index];
  return usd === undefined ? `#${index}` : `$${usd.toLocaleString()}`;
}

export const STRIKE_COUNT = deployed.strikeTicks.length;
export const STRIKE_INDICES = Array.from({ length: STRIKE_COUNT }, (_, i) => i);
