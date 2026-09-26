"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";
import { useAccount, useConfig, useConnect, useDisconnect, useSwitchChain } from "wagmi";
import { useAppKit, useAppKitNetwork } from "@reown/appkit/react";
import { AlertTriangle, LogOut, Wallet } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { addForkNetwork, useNetworkStatus } from "@/lib/network";
import { MainnetNotice, NetworkSelect } from "@/components/network-select";
import { activeNetwork } from "@/lib/config";
import { activeChain, FORK_RPC, reownProjectId } from "@/lib/wagmi";

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

  // The network is a client-side choice, so the server always renders the testnet tab set. Hiding
  // the faucet during the first client render instead of after it would mean React finds four
  // links where the HTML has five, which throws out the whole tree — the hydration error this
  // originally shipped with. Nobody is handing out real ETH, so on mainnet it goes, one frame late.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const tabs = mounted && activeNetwork.live ? TABS.filter((t) => t.href !== "/faucet") : TABS;

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

          <div className="flex items-center gap-2">
            <NetworkSelect />
            <WalletCluster />
          </div>
        </div>

        <nav className="mt-4 flex gap-7 border-b-heavy border-line">
          {tabs.map((t) => {
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

      <MainnetNotice />
      <NetworkBanner />
    </>
  );
}

/**
 * Two different wrong networks, and they need different fixes.
 *
 * A wallet on the wrong CHAIN is the easy one: switch, adding the network first if the wallet does
 * not have it. A wallet on the right chain id but a different FORK cannot be switched at all —
 * every anvil fork of Base answers to 31337, so the wallet already believes it is where it should
 * be. The only lever is handing it this fork's RPC URL, which is what `wallet_addEthereumChain`
 * does; and because older wallets refuse to add an id they already hold, the URL is on screen to
 * be added by hand.
 *
 * Both are checked on connect rather than at the trade, so nobody picks a strike and a size before
 * finding out their wallet was never going to be able to sign it.
 */
function NetworkBanner() {
  const config = useConfig();
  const { wrongChain, wrongNode, recheck } = useNetworkStatus();
  const [adding, setAdding] = useState(false);

  if (!wrongChain && !wrongNode) return null;

  const add = async () => {
    setAdding(true);
    try {
      await addForkNetwork(config);
    } catch {
      // Refused, or a wallet that will not add an id it already has. The URL below is the fallback.
    } finally {
      setAdding(false);
      recheck();
    }
  };

  return (
    <div className="mt-5 rounded-lg border-rule border-line bg-flag px-4 py-3 text-sm shadow-sm">
      <div className="flex flex-wrap items-center gap-3">
        <AlertTriangle className="size-4 shrink-0" aria-hidden="true" />
        <span className="flex-1 font-medium">
          {wrongChain ? (
            <>
              <strong className="font-extrabold">Wrong network.</strong> This runs on the Base fork, chain{" "}
              <span className="font-mono">{activeChain.id}</span>.
            </>
          ) : (
            <>
              <strong className="font-extrabold">Wrong fork.</strong> Your wallet is on chain{" "}
              <span className="font-mono">{activeChain.id}</span>, but a different one — the contracts there
              are not the ones this app reads, so anything you sign would land where it cannot be seen.
            </>
          )}
        </span>
        <div className="flex items-center gap-2">
          {/* Only the fork needs adding. Every wallet already ships Base, so offering to "add"
              it — with our own RPC, no less — would be replacing something that works. */}
          {!activeNetwork.live && (
            <Button size="sm" variant="outline" disabled={adding} onClick={add}>
              {adding ? "Adding…" : "Add network"}
            </Button>
          )}
          {wrongChain && <SwitchNetworkButton />}
        </div>
      </div>

      {/* Named in full for the wallet that will not take it programmatically. Mainnet needs none
          of this: the network is already in every wallet, so the only thing to do is switch. */}
      {!activeNetwork.live && (
      <p className="mt-2 border-t border-ink/15 pt-2 text-[12px] leading-relaxed">
        Or add it by hand — RPC <span className="font-mono font-bold">{FORK_RPC}</span>, chain id{" "}
        <span className="font-mono font-bold">{activeChain.id}</span>, currency{" "}
        <span className="font-mono font-bold">ETH</span>.
        {wrongNode && (
          <>
            {" "}
            A wallet holding one network per chain id already has an entry for{" "}
            <span className="font-mono">{activeChain.id}</span>, so adding this may attach the URL to that
            entry instead — in MetaMask, check <em>Settings → Networks</em> and make it the selected RPC.
          </>
        )}
      </p>
      )}
    </div>
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
    <Button size="sm" onClick={() => switchNetwork(activeChain)}>
      Switch
    </Button>
  );
}

function WagmiSwitch() {
  const { switchChain, isPending } = useSwitchChain();
  return (
    <Button size="sm" disabled={isPending} onClick={() => switchChain({ chainId: activeChain.id })}>
      {isPending ? "Switching…" : "Switch"}
    </Button>
  );
}
