"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { useAppKit, useAppKitNetwork } from "@reown/appkit/react";
import { AlertTriangle, LogOut, Wallet } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { baseFork, reownProjectId } from "@/lib/wagmi";

const TABS = [
  { href: "/", label: "Chain" },
  { href: "/strategies", label: "Strategies" },
  { href: "/positions", label: "Positions" },
  { href: "/faucet", label: "Faucet" },
];

/**
 * Wallet controls come in two shapes, and the choice is made once, here.
 *
 * AppKit's hooks throw outright if `createAppKit` never ran, so they cannot sit behind an `if`
 * inside one component — the branch has to BE the component. `reownProjectId` is a build-time
 * constant, so this picks one and never switches back.
 */
const WalletCluster = reownProjectId ? AppKitCluster : InjectedCluster;
const SwitchNetworkButton = reownProjectId ? AppKitSwitch : WagmiSwitch;

/**
 * N6 masthead + tab rail — the reference's own nav shape: heavy wordmark on
 * its own line, a tab row underneath carrying a thick active underline, and
 * the utility cluster pushed right.
 */
export function Nav() {
  const path = usePathname();
  const { isConnected, chainId } = useAccount();

  const wrongNetwork = isConnected && chainId !== baseFork.id;

  return (
    <>
      <header className="pt-7">
        <div className="flex flex-wrap items-start justify-between gap-4">
          {/* The wordmark is the logo itself, not the name typed in the display face: its A has
              no crossbar, and the lime dot sitting where one would be is the whole mark. Sized by
              height so it lines up with the tab rail whatever the file's own dimensions are. */}
          <h1 className="leading-none">
            <Image
              src="/mamori-wordmark.png"
              alt="Mamori"
              width={663}
              height={120}
              priority
              className="h-[30px] w-auto"
            />
          </h1>

          <WalletCluster />
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
        <div className="mt-5 flex flex-wrap items-center gap-3 rounded-lg border-rule border-line bg-flag px-4 py-3 text-sm shadow-sm">
          <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
          <span className="flex-1 font-medium">
            <strong className="font-extrabold">Wrong network.</strong> This runs on the Base fork, chain{" "}
            <span className="font-mono">{baseFork.id}</span>.
          </span>
          <SwitchNetworkButton />
        </div>
      )}
    </>
  );
}

/** Reown's modal: one button in, and every wallet behind it — extension, phone, or the account view. */
function AppKitCluster() {
  const { address, isConnected } = useAccount();
  const { open } = useAppKit();

  if (!isConnected) {
    return (
      <Button variant="lime" size="sm" onClick={() => open()}>
        <Wallet aria-hidden="true" /> Connect wallet
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {/* The address is a control here, not a readout: it opens AppKit's account view, which
          carries the balance, the copy button and the session the wallet actually holds. */}
      <button
        onClick={() => open({ view: "Account" })}
        className="press rounded-pill border-rule border-line bg-card px-3 py-2 font-mono text-xs font-medium shadow-xs transition-colors [transition-duration:120ms] hover:bg-paper-2"
      >
        {address?.slice(0, 6)}…{address?.slice(-4)}
      </button>
      <DisconnectButton />
    </div>
  );
}

/** No project id, no relay, no modal — so connect the browser extension directly. */
function InjectedCluster() {
  const { address, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const injected = connectors.find((c) => c.type === "injected") ?? connectors[0];

  if (!isConnected) {
    return (
      <Button
        variant="lime"
        size="sm"
        disabled={!injected || isPending}
        onClick={() => injected && connect({ connector: injected })}
      >
        <Wallet aria-hidden="true" /> {isPending ? "Connecting…" : "Connect wallet"}
      </Button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="rounded-pill border-rule border-line bg-card px-3 py-2 font-mono text-xs font-medium shadow-xs">
        {address?.slice(0, 6)}…{address?.slice(-4)}
      </span>
      <DisconnectButton />
    </div>
  );
}

/**
 * Icon only. The word "Disconnect" was the widest thing in the cluster and the least used control
 * in the app — it out-shouted the address beside it, which is the part people actually read.
 * `title` gives the hover tooltip, `aria-label` the accessible name.
 */
function DisconnectButton() {
  const { disconnect } = useDisconnect();
  return (
    <Button
      variant="outline"
      size="sm"
      className="w-9 px-0"
      title="Disconnect"
      aria-label="Disconnect wallet"
      onClick={() => disconnect()}
    >
      <LogOut aria-hidden="true" />
    </Button>
  );
}

/** AppKit owns the network selection, so the switch goes through it and its modal stays in step. */
function AppKitSwitch() {
  const { switchNetwork } = useAppKitNetwork();
  return (
    <Button size="sm" onClick={() => switchNetwork(baseFork)}>
      Switch
    </Button>
  );
}

function WagmiSwitch() {
  const { switchChain, isPending } = useSwitchChain();
  return (
    <Button size="sm" disabled={isPending} onClick={() => switchChain({ chainId: baseFork.id })}>
      {isPending ? "Switching…" : "Switch"}
    </Button>
  );
}
