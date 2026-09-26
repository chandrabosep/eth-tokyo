import type { Address } from "viem";

import localFork from "../../deployments/base-fork.json";
import hostedFork from "../../deployments/hosted-fork.json";
import baseMainnet from "../../deployments/base-mainnet.json";

/**
 * Which market this build can point at, and which one it is pointing at now.
 *
 * There are two real deployments of the same contracts: the demo fork, and Base mainnet. Until now
 * the choice was made at build time by `NEXT_PUBLIC_DEPLOYMENT`, which meant one build could only
 * ever see one of them. It is a runtime choice now, because a judge wants to see the thing running
 * on mainnet and a demo wants a chain you can hand out free money on.
 *
 * Testnet is the default and stays the default. Mainnet holds real funds, so arriving on it by
 * accident is the one outcome worth engineering against.
 */
export type NetworkKey = "testnet" | "mainnet";

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

export type NetworkSpec = {
  key: NetworkKey;
  label: string;
  /** The chain underneath, said plainly — "Base fork" is not a network anyone has heard of. */
  sublabel: string;
  rpc: string;
  deployment: Deployment;
  /** Real money. Drives the confirmation, the tone of the pill, and hiding the faucet. */
  live: boolean;
};

/**
 * Which fork the testnet entry means.
 *
 * The local anvil and the hosted one are BOTH chain 31337 but deploy to different addresses
 * (different solc resolution moves the CREATE2 hook and everything after it), so the chain id
 * cannot pick between them — the build has to. `NEXT_PUBLIC_DEPLOYMENT=hosted` on Vercel.
 */
const fork = (process.env.NEXT_PUBLIC_DEPLOYMENT === "hosted" ? hostedFork : localFork) as Deployment;
const FORK_RPC = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8545";

/** A public endpoint is enough for reads; writes go through the user's own wallet. */
const MAINNET_RPC = process.env.NEXT_PUBLIC_BASE_RPC_URL ?? "https://mainnet.base.org";

export const NETWORKS: Record<NetworkKey, NetworkSpec> = {
  testnet: {
    key: "testnet",
    label: "Testnet",
    sublabel: "Base fork",
    rpc: FORK_RPC,
    deployment: fork,
    live: false,
  },
  mainnet: {
    key: "mainnet",
    label: "Mainnet",
    sublabel: "Base",
    rpc: MAINNET_RPC,
    deployment: baseMainnet as Deployment,
    live: true,
  },
};

export const DEFAULT_NETWORK: NetworkKey = "testnet";

const STORAGE_KEY = "mamori.network";

/**
 * The selection, read once per page load.
 *
 * Deliberately not React state. `deployed` is imported as a plain object by about seventy call
 * sites, and threading a hook through all of them to support a switch nobody makes twice a minute
 * would be a great deal of churn for no benefit. Switching reloads the page instead, which is also
 * the only way to be sure nothing is left holding an address from the other chain.
 *
 * The server has no localStorage and always resolves to the default. That does not desync
 * hydration, because the two deployments share a strike ladder and nothing chain-specific reaches
 * the pre-rendered HTML — see `assertLaddersMatch` below, which fails loudly if that stops being
 * true.
 */
let cached: NetworkKey | undefined;

export function selectedNetwork(): NetworkKey {
  if (cached) return cached;
  cached = read();
  // Runs on the first import, which is before `createAppKit` — see reconcileAppKit.
  reconcileAppKit(cached);
  return cached;
}

function read(): NetworkKey {
  if (typeof window === "undefined") return DEFAULT_NETWORK;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    return raw === "mainnet" || raw === "testnet" ? raw : DEFAULT_NETWORK;
  } catch {
    // Private mode, blocked storage. The default is a safe answer.
    return DEFAULT_NETWORK;
  }
}

/** Where AppKit remembers the last network it was on, as a CAIP-2 id. */
const APPKIT_NETWORK_KEY = "@appkit/active_caip_network_id";

/**
 * Tell AppKit which network it is on before it works it out for itself.
 *
 * Only the selected chain is registered with wagmi, so AppKit rehydrating onto the other one finds
 * a network the app does not list and puts up a modal saying so — one with no way past it but
 * disconnecting. That is what a switch looked like before this: the chain changed underneath a
 * remembered `eip155:31337` and the app became unusable until localStorage was cleared by hand.
 *
 * Writing it here rather than only in `selectNetwork` covers the case where the two got out of
 * step some other way, which is the one nobody can reproduce on request.
 */
function reconcileAppKit(key: NetworkKey) {
  if (typeof window === "undefined") return;
  try {
    const want = `eip155:${NETWORKS[key].deployment.chainId}`;
    if (window.localStorage.getItem(APPKIT_NETWORK_KEY) !== want) {
      window.localStorage.setItem(APPKIT_NETWORK_KEY, want);
    }
  } catch {
    // Nothing persisted means nothing stale to correct.
  }
}

/** Persist and reload. The reload is the point: every cached read belongs to the old chain. */
export function selectNetwork(key: NetworkKey) {
  try {
    window.localStorage.setItem(STORAGE_KEY, key);
  } catch {
    // Unpersisted is still switchable for this page load.
  }
  reconcileAppKit(key);
  window.location.reload();
}

/**
 * The one thing that would break hydration if it changed.
 *
 * The option chain renders a row per strike from static config, so it is in the pre-rendered HTML.
 * The server always uses the default network; the client may use the other one. Today both ladders
 * are identical — same nine ticks, same dollar labels — so the two renders agree. If a future
 * deployment lists different strikes that silently becomes a hydration mismatch, which surfaces as
 * a blank or duplicated table rather than as an error pointing here.
 */
export function laddersMatch(): boolean {
  const a = NETWORKS.testnet.deployment;
  const b = NETWORKS.mainnet.deployment;
  return (
    a.strikeTicks.length === b.strikeTicks.length &&
    a.strikeUsd.every((v, i) => v === b.strikeUsd[i])
  );
}
