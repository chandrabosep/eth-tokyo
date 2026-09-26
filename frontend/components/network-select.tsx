"use client";

import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";
import { NETWORKS, selectNetwork, type NetworkKey } from "@/lib/networks";
import { activeNetwork } from "@/lib/config";

const ORDER: NetworkKey[] = ["testnet", "mainnet"];

/**
 * Which deployment the app is pointed at.
 *
 * Testnet first and testnet by default: it is the one with a faucet and a seeded book, so it is
 * what a demo wants and what a stranger should land on. Mainnet is the same contracts on real
 * Base, holding real money — so it is marked, not merely labelled, and the switch says what it is
 * doing before it does it.
 *
 * Switching reloads the page. `deployed` is resolved once at module scope (see lib/networks.ts),
 * and a reload is also the only way to be certain nothing is left holding an address, a cached
 * read or an in-flight request belonging to the other chain.
 */
export function NetworkSelect() {
  // The server always renders the default. Reading localStorage during render would make the
  // client's first paint disagree with the HTML, so the real selection is adopted after mount.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const current = mounted ? activeNetwork.key : "testnet";

  return (
    <div
      role="group"
      aria-label="Network"
      className="flex items-center gap-0.5 rounded-pill border-rule border-line bg-paper-2 p-0.5 shadow-xs"
    >
      {ORDER.map((key) => {
        const net = NETWORKS[key];
        const isCurrent = current === key;
        return (
          <button
            key={key}
            type="button"
            aria-current={isCurrent}
            title={`${net.label} — ${net.sublabel}${net.live ? " (real funds)" : ""}`}
            onClick={() => !isCurrent && selectNetwork(key)}
            className={cn(
              "rounded-pill px-2.5 py-1 text-[11px] font-extrabold uppercase tracking-[0.06em] transition-colors [transition-duration:120ms]",
              isCurrent
                ? net.live
                  ? "bg-flag text-ink shadow-xs"
                  : "bg-ink text-paper shadow-xs"
                : "text-ink-soft hover:text-ink",
            )}
          >
            {net.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A standing reminder, on mainnet only.
 *
 * The pill above says which network is selected, but it is small and it lives beside the wallet
 * controls where nobody looks twice. Anything that can spend real money should be impossible to be
 * on by accident, so mainnet also says so in the page itself.
 */
export function MainnetNotice() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted || !activeNetwork.live) return null;

  return (
    <div className="mt-5 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border-rule border-line bg-flag px-4 py-3 text-sm shadow-sm">
      <span className="font-medium">
        <strong className="font-extrabold">Base mainnet.</strong> Real funds — there is no faucet
        here, and anything you sign spends actual money.
      </span>
      <button
        onClick={() => selectNetwork("testnet")}
        className="press rounded-pill border-rule border-line bg-card px-3 py-1 text-[12px] font-bold shadow-xs hover:bg-paper-2"
      >
        Back to testnet
      </button>
    </div>
  );
}
