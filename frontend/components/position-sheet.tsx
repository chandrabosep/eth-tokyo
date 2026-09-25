"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount, useReadContract, useReadContracts } from "wagmi";
import { maxUint256, type Address } from "viem";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { SegmentedItem, SegmentedList, SegmentedRoot } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";

import { aquaAbi, erc20Abi, optionsManagerAbi } from "@/lib/abi";
import { deployed, OFFER_SALT, strikeLabel, USDC_DECIMALS, WETH_DECIMALS } from "@/lib/config";
import {
  amountsForLiquidity,
  fmt,
  fromRaw,
  fundingProfile,
  liquidityForTargetAmount,
  tickToUsdPrice,
  toRaw,
} from "@/lib/options";
import { useSeries, useSpotTick } from "@/lib/useMarket";
import { TxNote, useTx } from "@/components/tx";

export type Side = "call" | "put";
type Direction = "sell" | "buy";

/** A token leg the chosen position actually requires. */
type Leg = { token: Address; symbol: string; decimals: number; amount: number };

export function PositionSheet({
  open,
  side,
  strikeIndex,
  onOpenChange,
}: {
  open: boolean;
  side: Side;
  strikeIndex: number;
  onOpenChange: (open: boolean) => void;
}) {
  const isPut = side === "put";
  const { isConnected } = useAccount();
  const { tick } = useSpotTick();
  const { rows } = useSeries();

  const [direction, setDirection] = useState<Direction>("sell");
  const [notional, setNotional] = useState("");

  const row = rows.find((r) => r.strikeIndex === strikeIndex && r.isPut === isPut);

  // What the range actually demands right now — NOT inferred from put/call. An in-the-money put
  // sits above spot and is funded in WETH; the at-the-money strike straddles and needs both.
  const profile = useMemo(
    () => (row && tick !== undefined ? fundingProfile(row.tickLower, row.tickUpper, tick) : undefined),
    [row, tick],
  );

  const quoteInWeth = profile?.quoteInWeth ?? !isPut;
  const quoteSymbol = quoteInWeth ? "WETH" : "USDC";
  const quoteDecimals = quoteInWeth ? WETH_DECIMALS : USDC_DECIMALS;

  // Reset the size box whenever the denomination changes.
  useEffect(() => {
    setNotional(quoteInWeth ? "0.5" : "2000");
  }, [quoteInWeth, strikeIndex, isPut]);

  const size = Number(notional) || 0;

  const liquidity = useMemo(() => {
    if (!row || tick === undefined) return 0n;
    const raw = liquidityForTargetAmount(
      size * 10 ** quoteDecimals,
      row.tickLower,
      row.tickUpper,
      tick,
      quoteInWeth,
    );
    return raw > 0 ? BigInt(Math.floor(raw)) : 0n;
  }, [row, tick, size, quoteDecimals, quoteInWeth]);

  /** Exact token legs for this trade, at the current price. */
  const legs: Leg[] = useMemo(() => {
    if (!row || tick === undefined || liquidity === 0n) return [];
    const { amount0, amount1 } = amountsForLiquidity(Number(liquidity), row.tickLower, row.tickUpper, tick);
    const scale = direction === "sell" ? 1 : 0.1; // buyers post 10%
    const out: Leg[] = [];
    if (amount0 > 0) {
      out.push({
        token: deployed.weth,
        symbol: "WETH",
        decimals: WETH_DECIMALS,
        amount: (amount0 / 10 ** WETH_DECIMALS) * scale,
      });
    }
    if (amount1 > 0) {
      out.push({
        token: deployed.usdc,
        symbol: "USDC",
        decimals: USDC_DECIMALS,
        amount: (amount1 / 10 ** USDC_DECIMALS) * scale,
      });
    }
    return out;
  }, [row, tick, liquidity, direction]);

  const available = row ? row.shortLiquidity - row.longLiquidity : 0n;
  const overBuy = direction === "buy" && liquidity > available;

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-[430px]">
        <SheetHeader>
          <div className="flex items-center gap-2">
            <Badge variant={side}>{side}</Badge>
            {profile?.mixed && <Badge variant="itm">straddling spot</Badge>}
          </div>
          <SheetTitle>{strikeLabel(strikeIndex)}</SheetTitle>
          <SheetDescription>
            {profile?.mixed
              ? "Price is inside this range, so the position holds both tokens and is funded in both."
              : quoteInWeth
                ? "This range sits above spot, so it is funded entirely in WETH."
                : "This range sits below spot, so it is funded entirely in USDC."}
          </SheetDescription>
        </SheetHeader>

        <Separator />

        <div className="flex flex-col gap-4 p-5">
          <div className="space-y-1.5">
            <Label>Direction</Label>
            <SegmentedRoot value={direction} onValueChange={(v) => setDirection(v as Direction)}>
              <SegmentedList>
                <SegmentedItem value="sell">Sell (Write)</SegmentedItem>
                <SegmentedItem value="buy">Buy</SegmentedItem>
              </SegmentedList>
            </SegmentedRoot>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="notional">Notional ({quoteSymbol})</Label>
            <Input id="notional" inputMode="decimal" value={notional} onChange={(e) => setNotional(e.target.value)} />
          </div>

          <div className="rounded-md border-rule border-line bg-card px-3.5 py-1 shadow-xs">
            <Row label="Liquidity units" value={liquidity.toString()} mono />
            <Row
              label={direction === "sell" ? "Collateral to post" : "Buyer collateral (10%)"}
              value={legs.length ? legs.map((l) => `${fmt(l.amount, l.decimals === 18 ? 5 : 2)} ${l.symbol}`).join(" + ") : "—"}
              mono
            />
          </div>

          {overBuy && (
            <p className="rounded-md border-rule border-line bg-destructive/12 shadow-xs p-3 text-xs">
              Only {available.toString()} liquidity units are written at this strike. A long is an inverted
              short — someone has to write it first.
            </p>
          )}

          {!isConnected ? (
            <p className="rounded-md border-rule border-line bg-paper-2 p-3.5 shadow-xs text-xs text-ink-soft">
              Connect a wallet to trade.
            </p>
          ) : direction === "sell" ? (
            <SellPanel strikeIndex={strikeIndex} isPut={isPut} liquidity={liquidity} legs={legs} />
          ) : (
            <BuyPanel strikeIndex={strikeIndex} isPut={isPut} liquidity={liquidity} disabled={overBuy} />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-line py-2 last:border-0">
      <span className="shrink-0 text-xs text-ink-soft">{label}</span>
      <span className={cn("truncate text-right text-xs", mono && "font-mono tnum")}>{value}</span>
    </div>
  );
}

/**
 * Selling is two steps, and the split is the entire Aqua story:
 *   1. Ship — register wallet balance as backing. Nothing moves.
 *   2. Write — the option is minted and only then is collateral pulled from the wallet.
 *
 * The offer must register EVERY token the range can demand. A straddling range is funded in both,
 * and shipping only one leg makes the write revert on the second pull.
 */
function SellPanel({
  strikeIndex,
  isPut,
  liquidity,
  legs,
}: {
  strikeIndex: number;
  isPut: boolean;
  liquidity: bigint;
  legs: Leg[];
}) {
  const { address } = useAccount();
  const [backing, setBacking] = useState<Record<string, string>>({});

  // Default each leg's offer to 10x what this trade needs, so the seller can write repeatedly.
  useEffect(() => {
    setBacking((prev) => {
      const next = { ...prev };
      for (const l of legs) {
        if (next[l.symbol] === undefined) next[l.symbol] = String(Number((l.amount * 10).toPrecision(4)));
      }
      return next;
    });
  }, [legs]);

  const { data: strategy } = useReadContract({
    address: deployed.optionsManager,
    abi: optionsManagerAbi,
    functionName: "encodeAquaStrategy",
    args: address ? [address, OFFER_SALT] : undefined,
    query: { enabled: !!address },
  });

  const base = { address: deployed.optionsManager, abi: optionsManagerAbi } as const;
  const { data: backingData } = useReadContracts({
    contracts: legs.map(
      (l) => ({ ...base, functionName: "aquaBackingOf", args: [address ?? "0x0", OFFER_SALT, l.token] }) as const,
    ),
    query: { enabled: !!address && legs.length > 0 },
  });
  const { data: tokenData } = useReadContracts({
    contracts: legs.flatMap((l) => [
      { address: l.token, abi: erc20Abi, functionName: "balanceOf", args: [address ?? "0x0"] } as const,
      { address: l.token, abi: erc20Abi, functionName: "allowance", args: [address ?? "0x0", deployed.aqua] } as const,
    ]),
    query: { enabled: !!address && legs.length > 0 },
  });

  const approve = useTx();
  const ship = useTx();
  const write = useTx();

  const enriched = legs.map((l, i) => ({
    ...l,
    committed: (backingData?.[i]?.result as bigint) ?? 0n,
    wallet: (tokenData?.[i * 2]?.result as bigint) ?? 0n,
    allowance: (tokenData?.[i * 2 + 1]?.result as bigint) ?? 0n,
  }));

  const needsApproval = enriched.find((l) => l.allowance === 0n);
  // Every leg must be backed before the write can pull it.
  const allBacked = enriched.length > 0 && enriched.every((l) => l.committed > 0n);

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-md border-rule border-line bg-card px-3.5 py-1 shadow-xs">
        {enriched.map((l) => (
          <Row
            key={l.symbol}
            label={`${l.symbol} wallet / committed via Aqua`}
            value={`${fmt(fromRaw(l.wallet, l.decimals), 2)} / ${fmt(fromRaw(l.committed, l.decimals), 2)}`}
            mono
          />
        ))}
      </div>

      {!allBacked ? (
        <>
          {enriched.map((l) => (
            <div key={l.symbol} className="space-y-1.5">
              <Label htmlFor={`ship-${l.symbol}`}>
                Step 1 — Back an offer with Aqua ({l.symbol})
                {l.committed > 0n && <span className="ml-1 normal-case text-lime-deep">· already backed</span>}
              </Label>
              <Input
                id={`ship-${l.symbol}`}
                inputMode="decimal"
                disabled={l.committed > 0n}
                value={backing[l.symbol] ?? ""}
                onChange={(e) => setBacking((b) => ({ ...b, [l.symbol]: e.target.value }))}
              />
            </div>
          ))}

          {needsApproval ? (
            <Button
              disabled={approve.busy}
              onClick={() =>
                approve.send({
                  address: needsApproval.token,
                  abi: erc20Abi,
                  functionName: "approve",
                  args: [deployed.aqua, maxUint256],
                })
              }
            >
              {approve.busy ? "Approving…" : `Approve Aqua to draw ${needsApproval.symbol}`}
            </Button>
          ) : (
            <Button
              disabled={!strategy || ship.busy || enriched.length === 0}
              onClick={() =>
                ship.send({
                  address: deployed.aqua,
                  abi: aquaAbi,
                  functionName: "ship",
                  args: [
                    deployed.optionsManager,
                    strategy!,
                    enriched.map((l) => l.token),
                    enriched.map((l) => toRaw(Number(backing[l.symbol]) || 0, l.decimals)),
                  ],
                })
              }
            >
              {ship.busy ? "Shipping…" : `Ship offer to Aqua${enriched.length > 1 ? " (both legs)" : ""}`}
            </Button>
          )}

          <Note>
            <strong className="text-foreground">Nothing leaves your wallet.</strong> Aqua registers the balance
            as backing; the tokens stay yours, stay liquid, and can back other Aqua strategies at the same time.
            {enriched.length > 1 && " This range straddles spot, so both legs are registered in one offer."}
          </Note>
        </>
      ) : (
        <>
          <Button
            disabled={liquidity === 0n || write.busy}
            onClick={() =>
              write.send({
                address: deployed.optionsManager,
                abi: optionsManagerAbi,
                functionName: "sellOptionViaAqua",
                args: [address!, strikeIndex, isPut, liquidity, OFFER_SALT],
              })
            }
          >
            {write.busy ? "Writing…" : "Step 2 — Write the option"}
          </Button>
          <Note>
            <strong className="text-foreground">Now the collateral moves.</strong> Writing mints the liquidity
            into Uniswap v4 and pulls exactly what the mint needs, straight out of your wallet through Aqua.
          </Note>
        </>
      )}

      <TxNote tx={approve} label="Approval" />
      <TxNote tx={ship} label="Ship" />
      <TxNote tx={write} label="Write" />
    </div>
  );
}

function BuyPanel({
  strikeIndex,
  isPut,
  liquidity,
  disabled,
}: {
  strikeIndex: number;
  isPut: boolean;
  liquidity: bigint;
  disabled: boolean;
}) {
  const { address } = useAccount();
  const approveUsdc = useTx();
  const approveWeth = useTx();
  const buy = useTx();

  const { data: usdcAllowance } = useReadContract({
    address: deployed.usdc,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, deployed.optionsManager] : undefined,
    query: { enabled: !!address },
  });
  const { data: wethAllowance } = useReadContract({
    address: deployed.weth,
    abi: erc20Abi,
    functionName: "allowance",
    args: address ? [address, deployed.optionsManager] : undefined,
    query: { enabled: !!address },
  });

  const needUsdc = (usdcAllowance ?? 0n) === 0n;
  const needWeth = (wethAllowance ?? 0n) === 0n;

  if (needUsdc || needWeth) {
    const tx = needUsdc ? approveUsdc : approveWeth;
    const token = needUsdc ? deployed.usdc : deployed.weth;
    const sym = needUsdc ? "USDC" : "WETH";
    return (
      <div className="flex flex-col gap-4">
        <Button
          disabled={tx.busy}
          onClick={() =>
            tx.send({
              address: token,
              abi: erc20Abi,
              functionName: "approve",
              args: [deployed.optionsManager, maxUint256],
            })
          }
        >
          {tx.busy ? "Approving…" : `Approve ${sym}`}
        </Button>
        <Note>Buyers post collateral directly — only sellers route through Aqua.</Note>
        <TxNote tx={tx} label="Approval" />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <Button
        disabled={disabled || liquidity === 0n || buy.busy}
        onClick={() =>
          buy.send({
            address: deployed.optionsManager,
            abi: optionsManagerAbi,
            functionName: "buyOption",
            args: [strikeIndex, isPut, liquidity],
          })
        }
      >
        {buy.busy ? "Buying…" : `Buy ${isPut ? "put" : "call"}`}
      </Button>
      <Note>
        <strong className="text-foreground">This removes liquidity from the pool.</strong> That inversion is
        what makes you long, and it is why 10% collateral is enough.
      </Note>
      <TxNote tx={buy} label="Buy" />
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border-rule border-line bg-lime-wash p-3 text-xs leading-relaxed text-ink-soft">
      {children}
    </p>
  );
}
