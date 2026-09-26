import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import localFork from "../../deployments/base-fork.json";
import hostedFork from "../../deployments/hosted-fork.json";

/**
 * Which chain's contracts this build targets.
 *
 * The local anvil fork and the hosted one are BOTH chain 31337 but deploy to different addresses
 * (different solc resolution produces a different init code hash, which moves the CREATE2 hook and
 * everything after it). So the chain id cannot pick between them — the build has to.
 *
 * `NEXT_PUBLIC_DEPLOYMENT=hosted` on Vercel; unset locally. A stopgap until the network registry
 * lands and a deployment becomes a property of the selected network rather than of the build.
 */
const deployment = process.env.NEXT_PUBLIC_DEPLOYMENT === "hosted" ? hostedFork : localFork;

export type Deployment = {
  chainId: number;
  poolManager: Address;
  aqua: Address;
  weth: Address;
  usdc: Address;
  optionsHook: Address;
  optionsManager: Address;
  fee: number;
  tickSpacing: number;
  strikeWidth: number;
  spotTick: number;
  /** Fixed round-dollar strike ladder, ascending. Same for every user. */
  strikeUsd: number[];
  strikeTicks: number[];
  swapRouter?: Address;
};

export const deployed = deployment as unknown as Deployment;

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
