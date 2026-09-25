"use client";

import { createConfig, http } from "wagmi";
import { injected } from "@wagmi/core";
import { defineChain } from "viem";

const RPC = process.env.NEXT_PUBLIC_RPC_URL ?? "http://127.0.0.1:8545";

/**
 * The local anvil fork of Base.
 *
 * Chain id 31337, not 8453 — see demo/anvil.sh for why. The fork still contains all of Base's
 * state, so every real mainnet address (Uniswap v4, Aqua, WETH, USDC) resolves normally; only the
 * advertised id differs, which is what stops wallets applying mainnet gas heuristics to it.
 */
const CHAIN_ID = Number(process.env.NEXT_PUBLIC_CHAIN_ID ?? 31337);

export const baseFork = defineChain({
  id: CHAIN_ID,
  name: "Base fork (local)",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
  // Base's canonical Multicall3, which the fork inherits along with the rest of mainnet state.
  // Without it every `useReadContracts` fans out into one eth_call per contract — the Aqua offer
  // scan alone is 24 of them.
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

export const wagmiConfig = createConfig({
  chains: [baseFork],
  connectors: [injected()],
  transports: { [baseFork.id]: http(RPC) },
  ssr: true,
});
