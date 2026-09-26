"use client";

import { cookieStorage, createStorage, http } from "@wagmi/core";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { defineChain } from "@reown/appkit/networks";

const RPC = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8545";

/**
 * The local anvil fork of Base.
 *
 * Chain id 31337, not 8453 — see demo/anvil.sh for why. The fork still contains all of Base's
 * state, so every real mainnet address (Uniswap v4, Aqua, WETH, USDC) resolves normally; only the
 * advertised id differs, which is what stops wallets applying mainnet gas heuristics to it.
 */
const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 31337);

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
 * `defineChain` here is AppKit's, not viem's: same shape plus `caipNetworkId` and
 * `chainNamespace`, which is how AppKit addresses a network across its modal, its network switcher
 * and the WalletConnect session. The extra two fields are the only difference — wagmi and viem
 * still read it as an ordinary chain.
 */
export const baseFork = defineChain({
  id: CHAIN_ID,
  caipNetworkId: `eip155:${CHAIN_ID}`,
  chainNamespace: "eip155",
  name: "Base fork (local)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  // Base's canonical Multicall3, which the fork inherits along with the rest of mainnet state.
  // Without it every `useReadContracts` fans out into one eth_call per contract — the Aqua offer
  // scan alone is 24 of them.
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

/**
 * The adapter owns the wagmi config now.
 *
 * It builds the same `createConfig` this file used to call by hand, and adds the connectors AppKit
 * offers in the modal (injected, EIP-6963, WalletConnect). Our `transports` entry is passed through
 * untouched: AppKit only wraps a transport in a fallback to its own RPC for chains its Blockchain
 * API serves, and 31337 is not one of them — so every call still goes to the fork and nowhere else.
 */
export const wagmiAdapter = new WagmiAdapter({
  networks: [baseFork],
  projectId: reownProjectId,
  transports: { [baseFork.id]: http(RPC) },
  // Cookie storage, not localStorage, so the server renders the same connection state the browser
  // is about to hydrate — see `cookieToInitialState` in app/layout.tsx.
  storage: createStorage({ storage: cookieStorage }),
  ssr: true,
});

export const wagmiConfig = wagmiAdapter.wagmiConfig;
