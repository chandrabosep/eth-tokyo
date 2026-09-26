"use client";

import { Suspense, useState } from "react";
import { useAccount, useBalance, useReadContracts } from "wagmi";
import { useMutation } from "@tanstack/react-query";
import { Droplet, Search } from "lucide-react";
import { isAddress, type Address } from "viem";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { CardNote, PageHeader } from "@/components/page-header";

import { erc20Abi } from "@/lib/abi";
import { activeNetwork, deployed, USDC_DECIMALS, WETH_DECIMALS } from "@/lib/config";
import { fmt, fromRaw } from "@/lib/options";

/**
 * Where the hosted fork's faucet lives. Unset on a local chain, where you fund yourself with
 * `./demo/fund.sh`, so the page says so rather than offering a button that cannot work.
 *
 * This becomes part of the network registry once the network toggle lands — a faucet belongs to
 * a network, not to the build.
 */
// Build-time env, so it is set on the hosted build whichever network is selected at runtime.
// Nobody is handing out real ETH, so mainnet has no faucet regardless of what is configured.
const FAUCET_URL = activeNetwork.live ? undefined : process.env.NEXT_PUBLIC_FAUCET_URL;

type FaucetResult = {
  address: string;
  funded: boolean;
  balances: { eth: string; weth: string; usdc: string };
};

export default function FaucetPage() {
  return (
    <Suspense fallback={<div className="mt-8 text-sm text-ink-soft">Loading…</div>}>
      <Faucet />
    </Suspense>
  );
}

function Faucet() {
  const { address: connected } = useAccount();
  // Same shape as the Strategies page: the connected wallet by default, overridable by pasting.
  // Funding a wallet you are not currently connected with is a normal thing to want.
  const [input, setInput] = useState("");
  const typed = input.trim();
  const address = (typed || connected) as Address | undefined;
  const valid = !!address && isAddress(address);

  const { data: eth, refetch: refetchEth } = useBalance({ address });
  const { data: tokens, refetch: refetchTokens } = useReadContracts({
    contracts: [
      { address: deployed.weth, abi: erc20Abi, functionName: "balanceOf", args: [address ?? "0x0"] },
      { address: deployed.usdc, abi: erc20Abi, functionName: "balanceOf", args: [address ?? "0x0"] },
    ] as const,
    query: { enabled: !!address },
  });

  const weth = tokens?.[0]?.result as bigint | undefined;
  const usdc = tokens?.[1]?.result as bigint | undefined;

  const fund = useMutation({
    mutationFn: async (): Promise<FaucetResult> => {
      const res = await fetch(FAUCET_URL!, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ address }),
      });
      const body = await res.json();
      // The faucet's refusals are the useful part — a smart account that would fail the ERC-1155
      // receiver check, or a cooldown. Surface its words, not a generic HTTP error.
      if (!res.ok) throw new Error(body?.error ?? `Faucet returned ${res.status}`);
      return body as FaucetResult;
    },
    onSuccess: () => {
      refetchEth();
      refetchTokens();
    },
  });

  return (
    <>
      <PageHeader
        title="Test funds"
        description="This is a fork of Base. The tokens are real contracts but the balances are not — nothing here is worth anything."
        stats={[
          { label: "ETH", value: eth ? fmt(Number(eth.value) / 1e18, 4) : undefined, grow: 0.96 },
          {
            label: "WETH",
            tone: "lime",
            value: weth !== undefined ? fmt(fromRaw(weth, WETH_DECIMALS), 4) : undefined,
            grow: 0.96,
          },
          {
            label: "USDC",
            tone: "peri",
            value: usdc !== undefined ? fmt(fromRaw(usdc, USDC_DECIMALS), 2) : undefined,
            grow: 1.08,
          },
        ]}
      />

      <section className="mt-5">
        <Card className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4">
          {!FAUCET_URL ? (
            <p className="text-[13px] text-ink-soft">
              No faucet on this network. On a local chain, fund yourself with{" "}
              <span className="font-mono text-[12px]">./demo/fund.sh 0xYourAddress</span>.
            </p>
          ) : (
            <>
              <Label htmlFor="addr" className="sr-only">
                Address to fund
              </Label>
              <div className="relative min-w-[17rem] flex-1 sm:max-w-[28rem]">
                <Search
                  className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-ink-faint"
                  aria-hidden="true"
                />
                <Input
                  id="addr"
                  spellCheck={false}
                  autoComplete="off"
                  className="h-11 pl-10 font-mono text-[13px] font-medium"
                  placeholder={connected ?? "Address to fund (0x…)"}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                />
              </div>
              <Button
                variant="lime"
                disabled={fund.isPending || !valid}
                onClick={() => fund.mutate()}
              >
                <Droplet aria-hidden="true" />
                {fund.isPending ? "Funding…" : "Get test funds"}
              </Button>
              {typed && !valid && (
                <span className="text-[12.5px] text-destructive">Not a valid address</span>
              )}
            </>
          )}
        </Card>
      </section>

      {fund.error && (
        <div className="mt-4">
          <CardNote tone="danger">{(fund.error as Error).message}</CardNote>
        </div>
      )}

      {fund.data && !fund.error && (
        <div className="mt-4">
          <CardNote tone="lime">
            {fund.data.funded ? (
              <>
                <strong className="font-extrabold text-ink">Funded.</strong> Head to the Chain tab and write
                or buy an option.
              </>
            ) : (
              <>
                <strong className="font-extrabold text-ink">Already topped up.</strong> You are above the
                threshold, so nothing was sent.
              </>
            )}
          </CardNote>
        </div>
      )}

      <p className="mt-4 max-w-2xl text-[13px] leading-relaxed text-ink-soft">
        Tops up to 10 ETH, 100 WETH and 500,000 USDC, and only when you are below those levels. Smart
        accounts are refused: positions are ERC-1155 and the mint fails the receiver check, so use a plain
        EOA.
      </p>
    </>
  );
}
