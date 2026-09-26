"use client";

import { http } from "@wagmi/core";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { defineChain } from "@reown/appkit/networks";

import { NETWORKS, selectedNetwork } from "./networks";

const active = NETWORKS[selectedNetwork()];

/** The node this page load reads, and the one a wallet has to be pointed at to agree with it. */
export const FORK_RPC = active.rpc;

/**
 * What a wallet will call this network once it is added.
 *
 * Only the fork needs adding — every wallet already knows Base. Worth deriving rather than
 * hardcoding: a hosted build telling the user to add a network called "Base fork (local)" is
 * describing the wrong machine, and the name is the only thing distinguishing it from the other
 * chain-31337 entry they may already have.
 */
export const FORK_NAME = /127\.0\.0\.1|localhost/.test(NETWORKS.testnet.rpc)
  ? "Base fork (local)"
  : "Mamori Base fork";

/**
 * The demo fork of Base.
 *
 * Chain id 31337, not 8453 — see demo/anvil.sh for why. The fork still contains all of Base's
 * state, so every real mainnet address (Uniswap v4, Aqua, WETH, USDC) resolves normally; only the
 * advertised id differs, which is what stops wallets applying mainnet gas heuristics to it.
 */
export const forkChain = defineChain({
  id: NETWORKS.testnet.deployment.chainId,
  caipNetworkId: `eip155:${NETWORKS.testnet.deployment.chainId}`,
  chainNamespace: "eip155",
  name: FORK_NAME,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [NETWORKS.testnet.rpc] } },
  // Base's canonical Multicall3, which the fork inherits along with the rest of mainnet state.
  // Without it every `useReadContracts` fans out into one eth_call per contract — the Aqua offer
  // scan alone is 24 of them.
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

/** Base mainnet, where the same contracts are deployed for real. */
export const mainnetChain = defineChain({
  id: NETWORKS.mainnet.deployment.chainId,
  caipNetworkId: `eip155:${NETWORKS.mainnet.deployment.chainId}`,
  chainNamespace: "eip155",
  name: "Base",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [NETWORKS.mainnet.rpc] } },
  blockExplorers: { default: { name: "BaseScan", url: "https://basescan.org" } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

/**
 * The chain this page load is on.
 *
 * Named `activeChain` rather than the old `baseFork`, because it is Base mainnet half the time now
 * and a constant that lies about which chain it is would be the first thing to mislead someone
 * debugging a wrong-network report.
 */
export const activeChain = active.key === "mainnet" ? mainnetChain : forkChain;

/**
 * Reown AppKit's project id, from https://dashboard.reown.com.
 *
 * Optional on purpose. Without one there is no WalletConnect relay to talk to and no modal, so the
 * app falls back to connecting an injected wallet directly — which is all a local anvil fork needs
 * anyway. Everything else (the hosted fork, phones, wallets that are not browser extensions) wants
 * the modal, so set it: `NEXT_PUBLIC_REOWN_PROJECT_ID` in `.env.local`.
 */
export const reownProjectId = process.env.NEXT_PUBLIC_REOWN_PROJECT_ID ?? "";

/**
 * Only the selected chain is registered, deliberately.
 *
 * wagmi resolves a read with no explicit `chainId` against `config.state.chainId`, which starts at
 * `chains[0]`. Registering both left every read on the first entry while the app believed it was
 * on the other — the option chain quietly returned zeros for a pool that does not exist there, and
 * spot rendered as tick 0, which is $1e12. One chain in the config means there is no wrong answer
 * available.
 *
 * Nothing is lost by leaving the other one out: the only switch the app ever asks for is onto the
 * network it is already showing, and that one is here.
 */
export const wagmiAdapter = new WagmiAdapter({
  networks: [activeChain],
  projectId: reownProjectId,
  transports: { [activeChain.id]: http(active.rpc) },
  ssr: true,
});

export const wagmiConfig = wagmiAdapter.wagmiConfig;
