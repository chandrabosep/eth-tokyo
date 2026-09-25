import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";
import deployment from "../../deployments/base-fork.json";

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

/** The salt every UI-created Aqua offer uses. One standing offer per seller per series. */
export const OFFER_SALT: Hex = "0x000000000000000000000000000000000000000000000000000000000000a01a";

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
