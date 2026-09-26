"use client";

import { useCallback, useEffect, useState } from "react";
import { useAccount, useConfig } from "wagmi";
import { getBytecode, getConnectorClient, switchChain } from "@wagmi/core";
import type { Config } from "@wagmi/core";

import { deployed } from "./config";
import { baseFork, FORK_NAME, FORK_RPC } from "./wagmi";

/**
 * Is the wallet pointed at the same node this app reads?
 *
 * The chain id cannot answer that. Every anvil fork of Base calls itself 31337, so a wallet on a
 * local node and an app on the hosted one agree on the id, pass every mismatch check, and then the
 * signed transaction lands somewhere this app will never look — which shows up as a write that was
 * "signed but never confirmed".
 *
 * The deployments are the fingerprint. Both forks put OptionsManager at the SAME address, because
 * it is a nonce-based deploy from a fixed key onto a chain that always resets to the same block —
 * but the hook is an `immutable`, so it is baked into the manager's runtime code and the two
 * bytecodes differ. Same address, same length, different hash.
 *
 * "unknown" is a real answer and the common one. A wallet is under no obligation to serve
 * `eth_getCode` for a chain it does not know, some answer "0x" rather than erroring, and a
 * connector mid-switch answers from the network it is still on. None of those mean the wallet is
 * somewhere else, so none of them are allowed to read as `other-node`: that verdict requires two
 * real runtimes that disagree.
 */
export type NodeVerdict = "ok" | "other-node" | "unknown";

const missing = (code: string | undefined | null) => !code || code === "0x";

export async function compareNode(config: Config): Promise<NodeVerdict> {
  try {
    // Naming the chain makes wagmi refuse to hand back a client for a different one, rather than
    // quietly answering from wherever the connector currently is.
    const client = await getConnectorClient(config, { chainId: baseFork.id });

    // Asked again over the same connection, because the connector's idea of its own chain is the
    // thing in question.
    const walletChain = await client.request({ method: "eth_chainId" });
    if (Number(walletChain) !== baseFork.id) return "unknown";

    const [wallet, app] = await Promise.all([
      client.request({ method: "eth_getCode", params: [deployed.optionsManager, "latest"] }),
      getBytecode(config, { address: deployed.optionsManager, chainId: baseFork.id }),
    ]);
    if (missing(wallet) || missing(app)) return "unknown";
    return wallet === app ? "ok" : "other-node";
  } catch {
    return "unknown";
  }
}

/**
 * Ask the wallet to add this fork as a network, then switch to it.
 *
 * `wallet_addEthereumChain` is the only way to hand a wallet an RPC URL, and it is what makes the
 * "wrong fork" case fixable from inside the app at all: a wallet that already has a chain-31337
 * entry pointed at some other node cannot be corrected by `switchChain`, which would find the id
 * it wants and stop there. Newer MetaMask treats this as adding a second endpoint to the existing
 * network and lets the user make it the default; older builds refuse outright, which is why the
 * banner also prints the URL to add by hand.
 */
export async function addForkNetwork(config: Config): Promise<void> {
  const client = await getConnectorClient(config);
  await client.request({
    method: "wallet_addEthereumChain",
    params: [
      {
        chainId: `0x${baseFork.id.toString(16)}`,
        chainName: FORK_NAME,
        nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
        rpcUrls: [FORK_RPC],
      },
    ],
    // Not in viem's EIP-1193 method union, but every injected wallet implements it.
  } as unknown as Parameters<typeof client.request>[0]);

  // Adding does not always select it, and on the wallets that do this is a no-op.
  await switchChain(config, { chainId: baseFork.id }).catch(() => undefined);
}

export type NetworkStatus = {
  /** Connected, but the wallet is on some other chain entirely. */
  wrongChain: boolean;
  /** Right chain id, demonstrably the wrong fork behind it. */
  wrongNode: boolean;
  verdict: NodeVerdict;
  checking: boolean;
  recheck: () => void;
};

/**
 * The wallet's standing on the network, checked as soon as it connects rather than at the moment
 * someone tries to trade.
 *
 * Finding out at the trade is too late twice over: the user has already picked a strike and a
 * size, and the wallet is already open asking them to sign something that cannot work.
 */
export function useNetworkStatus(): NetworkStatus {
  const config = useConfig();
  const { isConnected, chainId, address, connector } = useAccount();
  const [verdict, setVerdict] = useState<NodeVerdict>("unknown");
  const [checking, setChecking] = useState(false);
  const [nonce, setNonce] = useState(0);

  const wrongChain = isConnected && chainId !== undefined && chainId !== baseFork.id;

  useEffect(() => {
    // Only meaningful once the wallet says it is on the fork; otherwise the chain id is the
    // problem and the node question does not arise yet.
    if (!isConnected || wrongChain) {
      setVerdict("unknown");
      return;
    }
    let live = true;
    setChecking(true);
    compareNode(config).then((v) => {
      if (!live) return;
      setVerdict(v);
      setChecking(false);
    });
    return () => {
      live = false;
    };
  }, [config, isConnected, wrongChain, chainId, address, connector, nonce]);

  return {
    wrongChain: !!wrongChain,
    wrongNode: verdict === "other-node",
    verdict,
    checking,
    recheck: useCallback(() => setNonce((n) => n + 1), []),
  };
}
