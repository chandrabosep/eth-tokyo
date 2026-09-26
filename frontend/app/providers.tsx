"use client";

import { WagmiProvider, cookieToInitialState, type Config } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAppKit } from "@reown/appkit/react";
import { useState, type ReactNode } from "react";

import { baseFork, reownProjectId, wagmiAdapter, wagmiConfig } from "../lib/wagmi";

/**
 * Reown AppKit — the connect modal, the wallet list and the network switcher.
 *
 * Created once at module scope rather than in an effect: AppKit registers web components and a
 * global controller, and doing that twice under strict mode leaves two modals racing each other.
 * `useAppKit()` in any component then talks to this instance.
 *
 * Skipped entirely when no project id is configured, because every wallet in the modal is reached
 * through the WalletConnect relay and the relay is what the id authenticates. Nav falls back to a
 * direct injected connect in that case.
 */
if (reownProjectId) {
  createAppKit({
    adapters: [wagmiAdapter],
    networks: [baseFork],
    defaultNetwork: baseFork,
    projectId: reownProjectId,
    metadata: {
      name: "Recycled",
      description: "Perpetual options on reused Uniswap v4 liquidity, collateralised through 1inch Aqua",
      // WalletConnect shows this to the wallet alongside the connection request, and compares it
      // with the origin the request actually came from. It has to be the deployed URL, not a
      // hardcoded one, or the wallet flags the session as unverified.
      url: process.env.NEXT_PUBLIC_APP_URL ?? (typeof window === "undefined" ? "" : window.location.origin),
      icons: [],
    },
    features: {
      // Off: the counter does not need to know, and nobody opted into it.
      analytics: false,
      // Off deliberately. An embedded wallet would land on a chain its infrastructure has never
      // heard of — this is a private fork — with no ETH for gas, and option positions are ERC-1155,
      // which a smart account has to implement a receiver hook to hold at all (the faucet refuses
      // those for the same reason). Wallets only, until the fork is a network AppKit can see.
      email: false,
      socials: false,
    },
    themeMode: "light",
    themeVariables: {
      // Ink, not lime: AppKit puts white on the accent, and lime at the app's own lightness would
      // not carry it. Ink is what the app's primary button is anyway.
      "--apkt-accent": "#263129",
      // Paper is a green-tinted white, so the modal's neutrals get the same tint rather than
      // reading as a cold grey panel dropped on top of the page.
      "--apkt-color-mix": "#80b934",
      "--apkt-color-mix-strength": 8,
      "--apkt-font-family": "var(--font-outfit), ui-sans-serif, system-ui, sans-serif",
      "--apkt-border-radius-master": "3px",
    },
  });
}

export function Providers({ children, cookies }: { children: ReactNode; cookies?: string | null }) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { refetchInterval: 4000, retry: 1 } } }),
  );
  // The wallet's last connection lives in a cookie, so the server can render the connected state
  // instead of a "Connect wallet" button that flips a tick later.
  const initialState = cookieToInitialState(wagmiConfig as Config, cookies);

  return (
    <WagmiProvider config={wagmiConfig as Config} initialState={initialState}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
