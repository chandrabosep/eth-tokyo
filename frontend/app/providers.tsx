"use client";

import { WagmiProvider, type Config } from "wagmi";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createAppKit } from "@reown/appkit/react";
import { useState, type ReactNode } from "react";

import { activeChain, reownProjectId, wagmiAdapter, wagmiConfig } from "../lib/wagmi";
import { activeNetwork } from "../lib/config";

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
const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? (typeof window === "undefined" ? "" : window.location.origin);

if (reownProjectId) {
  createAppKit({
    adapters: [wagmiAdapter],
    networks: [activeChain],
    defaultNetwork: activeChain,
    projectId: reownProjectId,
    metadata: {
      name: "Mamori",
      description: "Perpetual options on reused Uniswap v4 liquidity, collateralised through 1inch Aqua",
      // WalletConnect shows this to the wallet alongside the connection request, and compares it
      // with the origin the request actually came from. It has to be the deployed URL, not a
      // hardcoded one, or the wallet flags the session as unverified.
      url: appUrl,
      // The wallet shows this beside the connection request, so it has to be an absolute URL.
      icons: appUrl ? [`${appUrl}/icon.png`] : [],
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

/**
 * No `cookieToInitialState` here, deliberately.
 *
 * Handing the server the wallet's last connection renders the connected address into the HTML —
 * and the client only agrees if it can restore that same connection before hydrating. When it
 * cannot (no extension, permission revoked, a wallet that answers slowly) React finds the server's
 * address where the client put a placeholder and throws out the subtree. Starting disconnected on
 * both sides costs one frame and cannot diverge.
 */
export function Providers({ children }: { children: ReactNode }) {
  // How hard to poll, which is a property of the node rather than of the app.
  //
  // The fork is ours and churns every couple of minutes, so four seconds is free and keeps premium
  // visibly ticking. Base mainnet is reached through a shared public endpoint that answers 429 long
  // before it answers slowly — at four seconds the option chain spent more requests being refused
  // than served. Set NEXT_PUBLIC_BASE_RPC_URL to a dedicated endpoint and this can come back down.
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: { refetchInterval: activeNetwork.live ? 15_000 : 4_000, retry: 1 } },
      }),
  );

  return (
    <WagmiProvider config={wagmiConfig as Config}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
