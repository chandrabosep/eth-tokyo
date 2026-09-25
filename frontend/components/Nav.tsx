"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { AlertTriangle, Wallet } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { baseFork } from "@/lib/wagmi";

const TABS = [
  { href: "/", label: "Chain" },
  { href: "/strategies", label: "Strategies" },
  { href: "/positions", label: "Positions" },
  { href: "/hedge", label: "Hedge" },
];

/**
 * N6 masthead + tab rail — the reference's own nav shape: heavy wordmark on
 * its own line, a tab row underneath carrying a thick active underline, and
 * the utility cluster pushed right.
 */
export function Nav() {
  const path = usePathname();
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const injected = connectors[0];

  const wrongNetwork = isConnected && chainId !== baseFork.id;

  return (
    <>
      <header className="pt-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <h1 className="font-display text-[34px] font-extrabold leading-none tracking-[-0.04em]">Recycled</h1>

          {isConnected ? (
            <div className="flex items-center gap-2">
              <span className="rounded-pill border-rule border-line bg-card px-3 py-2 font-mono text-xs font-medium shadow-xs">
                {address?.slice(0, 6)}…{address?.slice(-4)}
              </span>
              <Button variant="outline" size="sm" onClick={() => disconnect()}>
                Disconnect
              </Button>
            </div>
          ) : (
            <Button
              variant="lime"
              size="sm"
              disabled={!injected || isPending}
              onClick={() => injected && connect({ connector: injected })}
            >
              <Wallet aria-hidden="true" /> {isPending ? "Connecting…" : "Connect wallet"}
            </Button>
          )}
        </div>

        <nav className="mt-4 flex gap-7 border-b-heavy border-line">
          {TABS.map((t) => {
            const active = path === t.href;
            return (
              <Link
                key={t.href}
                href={t.href}
                className={cn(
                  "relative -mb-[2px] whitespace-nowrap pb-2.5 text-[15px] font-bold transition-colors [transition-duration:120ms] ease-out",
                  active ? "text-ink" : "text-ink-soft hover:text-ink",
                )}
              >
                {t.label}
                {active && <span className="absolute inset-x-0 -bottom-[2px] h-[3px] rounded-pill bg-ink" />}
              </Link>
            );
          })}
        </nav>
      </header>

      {/* A mismatched wallet estimates gas itself and silently under-funds the
          transaction, so this blocks loudly rather than letting it fail. */}
      {wrongNetwork && (
        <div className="mt-5 flex flex-wrap items-center gap-3 rounded-lg border-rule border-line bg-flag p-4 text-sm shadow-sm">
          <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
          <span className="flex-1 font-medium">
            <strong className="font-extrabold">Wrong network.</strong> Your wallet is on chain{" "}
            <span className="font-mono">{chainId}</span>, but this runs on the local Base fork (chain{" "}
            <span className="font-mono">{baseFork.id}</span>).
          </span>
          <Button size="sm" disabled={switching} onClick={() => switchChain({ chainId: baseFork.id })}>
            {switching ? "Switching…" : "Switch network"}
          </Button>
        </div>
      )}
    </>
  );
}
