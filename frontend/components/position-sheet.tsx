"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
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
import { deployed, strikeLabel, USDC_DECIMALS, WETH_DECIMALS } from "@/lib/config";
import { useAquaOffers } from "@/lib/aqua";
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
import { BatchNote, BatchPlan, useAtomicBatch, useBatch, type BatchCall } from "@/components/batch";
import { TokenLabel, TokenPair } from "@/components/token-icon";

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

  /**
   * Empty the size once a trade lands.
   *
   * The panel stays open on the confirmation, and leaving the old size in the box leaves a second
   * identical trade armed and one click away — with the plan beneath it still reading like
   * something outstanding. Zero disarms the button and empties the plan, so what is left on screen
   * is only the receipt. `useCallback` because the panels fire this from an effect.
   */
  const clearSize = useCallback(() => setNotional("0"), []);

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
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={side}>{side}</Badge>
            {profile?.mixed && <Badge variant="itm">straddling spot</Badge>}
            <span className="ml-auto inline-flex items-center gap-1.5 text-[11px] font-bold tracking-[0.06em] text-ink-soft">
              <TokenPair base="WETH" quote="USDC" size={16} /> WETH / USDC
            </span>
          </div>
          <SheetTitle>{strikeLabel(strikeIndex)}</SheetTitle>
          <SheetDescription>
            {profile?.mixed
              ? "Spot is inside this range. Funded in both tokens."
              : quoteInWeth
                ? "Above spot. Funded in WETH."
                : "Below spot. Funded in USDC."}
          </SheetDescription>
        </SheetHeader>

        <Separator />

        <div className="flex flex-col gap-4 p-5">
          <div className="space-y-1.5">
            <Label>Direction</Label>
            <SegmentedRoot value={direction} onValueChange={(v) => setDirection(v as Direction)}>
              <SegmentedList>
                <SegmentedItem value="sell">Write</SegmentedItem>
                <SegmentedItem value="buy">Buy</SegmentedItem>
              </SegmentedList>
            </SegmentedRoot>
            {/* The two sides do opposite things with the same number in the box below — a writer
                posts all of it, a buyer a tenth — and nothing on the panel used to say so. This
                is where that belongs: next to the choice, before the figures. */}
            <p className="pt-1 text-[12.5px] leading-relaxed text-ink-soft">
              {direction === "sell" ? (
                <>
                  <strong className="font-extrabold text-ink">You sell it.</strong> Post the collateral
                  behind the option and earn premium for as long as spot trades inside this range.
                </>
              ) : (
                <>
                  <strong className="font-extrabold text-ink">You buy it.</strong> Post a tenth of its
                  size and pay premium for as long as spot trades inside this range.
                </>
              )}
            </p>
          </div>

          <div className="space-y-1.5">
            {/* "Notional" was the same word for two different jobs. This box is the POSITION's size
                either way; what changes is the share of it you put up, which the card states. */}
            <Label htmlFor="notional" className="flex items-center gap-1.5">
              Position size <TokenLabel symbol={quoteSymbol} size={13} className="tracking-normal" />
            </Label>
            <Input id="notional" inputMode="decimal" value={notional} onChange={(e) => setNotional(e.target.value)} />
          </div>

          <div className="rounded-md border-rule border-line bg-card px-3.5 py-1 shadow-xs">
            <Row
              label={direction === "sell" ? "You post" : "You post (10%)"}
              value={
                legs.length ? (
                  <span className="inline-flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
                    {legs.map((l, i) => (
                      <span key={l.symbol} className="inline-flex items-center gap-1.5">
                        {i > 0 && <span className="text-ink-faint">+</span>}
                        {fmt(l.amount, l.decimals === 18 ? 5 : 2)}
                        <TokenLabel symbol={l.symbol} size={13} />
                      </span>
                    ))}
                  </span>
                ) : (
                  "—"
                )
              }
              mono
            />
            {/* Named for what the trade does to the pool, not for the unit it is counted in:
                writing mints this liquidity, buying takes it away. Grouped, because fifteen
                unbroken digits read as noise. */}
            <Row
              label={direction === "sell" ? "Liquidity minted" : "Liquidity taken"}
              value={liquidity.toLocaleString()}
              mono
            />
          </div>

          {overBuy && (
            <p className="rounded-md border-rule border-line bg-destructive/12 px-3.5 py-3 text-xs shadow-xs">
              Bigger than what is on the book. Writers have left{" "}
              <span className="font-mono">{available.toLocaleString()}</span> liquidity to buy at this
              strike — a long can only take what someone else already wrote.
            </p>
          )}

          {!isConnected ? (
            <p className="rounded-md border-rule border-line bg-paper-2 px-3.5 py-3 text-xs text-ink-soft shadow-xs">
              Connect a wallet to trade.
            </p>
          ) : direction === "sell" ? (
            <SellPanel
              strikeIndex={strikeIndex}
              isPut={isPut}
              liquidity={liquidity}
              legs={legs}
              onFilled={clearSize}
            />
          ) : (
            <BuyPanel
              strikeIndex={strikeIndex}
              isPut={isPut}
              liquidity={liquidity}
              disabled={overBuy}
              onFilled={clearSize}
            />
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Row({
  label,
  value,
  mono,
}: {
  label: React.ReactNode;
  value: React.ReactNode;
  mono?: boolean;
}) {
  return (
    // `items-center`, not baseline: a value carrying a token mark is taller than
    // its text, and baseline alignment hangs the label off the top of it.
    <div className="flex items-center justify-between gap-3 border-b border-line py-2 last:border-0">
      <span className="shrink-0 text-xs text-ink-soft">{label}</span>
      <span className={cn("min-w-0 truncate text-right text-xs", mono && "font-mono tnum")}>{value}</span>
    </div>
  );
}

/**
 * Selling is two steps, and the split is the entire Aqua story:
 *   1. Ship — register wallet balance as backing. Nothing moves.
 *   2. Write — the option is minted and only then is collateral pulled from the wallet.
 *
 * The user should not have to drive that split, so they do not: both steps and the approval in
 * front of them go to the wallet as ONE batch (see components/batch.tsx). The story is still told —
 * the plan lists the calls — but it is told, not performed.
 *
 * Two things about step 1 that this panel exists to get right.
 *
 * The offer must cover the write, not merely exist. Aqua caps a pull at the registered balance and
 * enforces it with plain arithmetic, so an offer that is short — including one that funded earlier
 * writes and is now low — fails as a bare panic with no reason string attached. `collateralFor` is
 * read from the manager rather than estimated here, because it is the same computation the pool
 * will do, to the wei.
 *
 * And an offer cannot be topped up. Aqua strategies are immutable: a shipped salt is spent forever,
 * `dock` does not free it, and re-shipping it reverts. So more backing means a NEW offer under the
 * next salt, which is what `useAquaOffers` finds.
 */
function SellPanel({
  strikeIndex,
  isPut,
  liquidity,
  legs,
  onFilled,
}: {
  strikeIndex: number;
  isPut: boolean;
  liquidity: bigint;
  legs: Leg[];
  onFilled: () => void;
}) {
  const { address } = useAccount();
  const [backing, setBacking] = useState<Record<string, string>>({});

  // Exactly what the mint will take, quoted by the contract. Never a local estimate: an offer one
  // wei short cannot be topped up, it has to be abandoned.
  const { data: quote } = useReadContract({
    address: deployed.optionsManager,
    abi: optionsManagerAbi,
    functionName: "collateralFor",
    args: [strikeIndex, isPut, liquidity],
    query: { enabled: liquidity > 0n },
  });
  const need = useMemo(
    () => ({ weth: (quote?.[0] as bigint) ?? 0n, usdc: (quote?.[1] as bigint) ?? 0n }),
    [quote],
  );

  const { covering, nextFree, refetch: refetchOffers } = useAquaOffers(address, need);
  const salt = covering?.salt ?? nextFree?.salt;

  // Required tokens, in the order the write pulls them.
  const required = useMemo(
    () =>
      (
        [
          { token: deployed.weth, symbol: "WETH", decimals: WETH_DECIMALS, amount: need.weth },
          { token: deployed.usdc, symbol: "USDC", decimals: USDC_DECIMALS, amount: need.usdc },
        ] as const
      ).filter((t) => t.amount > 0n),
    [need],
  );

  // Default a new offer to 10x this trade, so the seller can write repeatedly before re-shipping.
  useEffect(() => {
    setBacking((prev) => {
      const next = { ...prev };
      for (const t of required) {
        if (next[t.symbol] === undefined) {
          next[t.symbol] = String(Number((fromRaw(t.amount, t.decimals) * 10).toPrecision(4)));
        }
      }
      return next;
    });
  }, [required]);

  const { data: strategy } = useReadContract({
    address: deployed.optionsManager,
    abi: optionsManagerAbi,
    functionName: "encodeAquaStrategy",
    args: address && nextFree ? [address, nextFree.salt] : undefined,
    query: { enabled: !!address && !!nextFree },
  });

  const { data: tokenData } = useReadContracts({
    contracts: required.flatMap((t) => [
      { address: t.token, abi: erc20Abi, functionName: "balanceOf", args: [address ?? "0x0"] } as const,
      { address: t.token, abi: erc20Abi, functionName: "allowance", args: [address ?? "0x0", deployed.aqua] } as const,
    ]),
    query: { enabled: !!address && required.length > 0 },
  });

  const batch = useBatch();
  const atomic = useAtomicBatch();

  // The write spends the offer's backing, so the panel has to re-read it afterwards.
  const done = batch.isSuccess;
  useEffect(() => {
    if (!done) return;
    refetchOffers();
    onFilled();
  }, [done, refetchOffers, onFilled]);

  const enriched = required.map((t, i) => ({
    ...t,
    committed: t.symbol === "WETH" ? (covering?.weth ?? 0n) : (covering?.usdc ?? 0n),
    wallet: (tokenData?.[i * 2]?.result as bigint) ?? 0n,
    allowance: (tokenData?.[i * 2 + 1]?.result as bigint) ?? 0n,
  }));

  const funded = required.length > 0 && !!covering;
  /** What the offer will register, in raw units, in the order Aqua expects. */
  const shipAmounts = enriched.map((l) => toRaw(Number(backing[l.symbol]) || 0, l.decimals));
  const underBacked = enriched.some((l, i) => shipAmounts[i] < l.amount);

  /**
   * The whole trade, as calls.
   *
   * Approvals first (Aqua pulls with `transferFrom`, so it needs one per token), then the offer if
   * this write is not already covered, then the write itself. The salt is `nextFree`'s when the
   * offer is being shipped in this same batch — the write has to name the offer that is about to
   * exist, not one that does.
   */
  const calls: BatchCall[] = [];
  if (liquidity > 0n && salt && (funded || (nextFree && strategy && !underBacked))) {
    for (const l of enriched) {
      if (l.allowance < l.amount) {
        calls.push({
          label: `Approve ${l.symbol} for Aqua`,
          to: l.token,
          abi: erc20Abi,
          functionName: "approve",
          args: [deployed.aqua, maxUint256],
        });
      }
    }
    if (!funded && nextFree && strategy) {
      calls.push({
        label: `Ship offer #${nextFree.index}`,
        to: deployed.aqua,
        abi: aquaAbi,
        functionName: "ship",
        args: [deployed.optionsManager, strategy, enriched.map((l) => l.token), shipAmounts],
      });
    }
    calls.push({
      label: "Write the option",
      to: deployed.optionsManager,
      abi: optionsManagerAbi,
      functionName: "sellOptionViaAqua",
      args: [address!, strikeIndex, isPut, liquidity, salt],
    });
  }

  return (
    <div className="flex flex-col gap-4">
      {/* Only the offer's side of the story lives here now. What this write costs is stated once,
          above, as "You post" — printing it again beside the backing made two numbers out of one
          fact and left the reader working out which was which. */}
      {funded && covering && (
        <div className="rounded-md border-rule border-line bg-card px-3.5 py-1 shadow-xs">
          <Row
            label={`Backed by offer #${covering.index}`}
            value={
              <span className="inline-flex flex-wrap items-center justify-end gap-x-2 gap-y-1">
                {enriched.map((l) => (
                  <span key={l.symbol} className="inline-flex items-center gap-1.5">
                    {fmt(fromRaw(l.committed, l.decimals), l.decimals === 18 ? 5 : 2)}
                    <TokenLabel symbol={l.symbol} size={13} />
                  </span>
                ))}
                <span className="text-ink-faint">left</span>
              </span>
            }
            mono
          />
        </div>
      )}

      {required.length === 0 ? (
        <Note>Enter a size to see what this write needs.</Note>
      ) : !funded && !nextFree ? (
        <Note>
          <strong className="text-foreground">Every offer slot is spent.</strong> Nothing is lost, the
          tokens never left your wallet.
        </Note>
      ) : (
        <>
          {/* Only shown when an offer is actually being shipped. Aqua strategies are immutable, so
              this number is the one decision in the flow that cannot be undone later — hence the
              line under it saying what the default buys you. */}
          {!funded &&
            enriched.map((l, i) => (
              <div key={l.symbol} className="space-y-1.5">
                <Label htmlFor={`ship-${l.symbol}`} className="flex items-center gap-1.5">
                  Back the offer with <TokenLabel symbol={l.symbol} size={13} className="tracking-normal" />
                </Label>
                <Input
                  id={`ship-${l.symbol}`}
                  inputMode="decimal"
                  value={backing[l.symbol] ?? ""}
                  onChange={(e) => setBacking((b) => ({ ...b, [l.symbol]: e.target.value }))}
                />
                {shipAmounts[i] < l.amount ? (
                  <p className="text-[11px] text-destructive">
                    Below the {fmt(fromRaw(l.amount, l.decimals), l.decimals === 18 ? 5 : 2)}{" "}
                    <TokenLabel symbol={l.symbol} size={12} /> this write needs.
                  </p>
                ) : (
                  <p className="text-[11px] text-ink-faint">
                    This write needs {fmt(fromRaw(l.amount, l.decimals), l.decimals === 18 ? 5 : 2)}{" "}
                    <TokenLabel symbol={l.symbol} size={12} />. Backing more lets you write again
                    without shipping another offer — an offer cannot be topped up later.
                  </p>
                )}
              </div>
            ))}

          <BatchPlan calls={calls} atomic={atomic} batch={batch} />

          <Button
            variant="lime"
            disabled={calls.length === 0 || batch.busy}
            onClick={() => batch.send(calls)}
          >
            {batch.busy ? "Writing…" : "Write the option"}
          </Button>

          <Note>
            <strong className="text-foreground">Nothing leaves your wallet until the mint.</strong> Aqua
            registers the balance as backing; the write is what pulls it, and only what it needs.
          </Note>
        </>
      )}

      <BatchNote batch={batch} label="Write" />
    </div>
  );
}

/**
 * Buying is one call plus whatever approvals are missing — so it is one click, always.
 *
 * Both allowances go in even when only one currency is owed: the collateral a long posts depends
 * on where spot sits inside the range, and that can move between opening this panel and signing.
 */
function BuyPanel({
  strikeIndex,
  isPut,
  liquidity,
  disabled,
  onFilled,
}: {
  strikeIndex: number;
  isPut: boolean;
  liquidity: bigint;
  disabled: boolean;
  onFilled: () => void;
}) {
  const { address } = useAccount();
  const batch = useBatch();
  const atomic = useAtomicBatch();

  const done = batch.isSuccess;
  useEffect(() => {
    if (done) onFilled();
  }, [done, onFilled]);

  const { data: allowances } = useReadContracts({
    contracts: [
      {
        address: deployed.weth,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address ?? "0x0", deployed.optionsManager],
      },
      {
        address: deployed.usdc,
        abi: erc20Abi,
        functionName: "allowance",
        args: [address ?? "0x0", deployed.optionsManager],
      },
    ] as const,
    query: { enabled: !!address },
  });

  const calls: BatchCall[] = [];
  for (const [i, t] of (
    [
      { token: deployed.weth, symbol: "WETH" },
      { token: deployed.usdc, symbol: "USDC" },
    ] as const
  ).entries()) {
    if (((allowances?.[i]?.result as bigint) ?? 0n) === 0n) {
      calls.push({
        label: `Approve ${t.symbol} as collateral`,
        to: t.token,
        abi: erc20Abi,
        functionName: "approve",
        args: [deployed.optionsManager, maxUint256],
      });
    }
  }
  if (liquidity > 0n) {
    calls.push({
      label: `Buy the ${isPut ? "put" : "call"}`,
      to: deployed.optionsManager,
      abi: optionsManagerAbi,
      functionName: "buyOption",
      args: [strikeIndex, isPut, liquidity],
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <BatchPlan calls={calls} atomic={atomic} batch={batch} />

      <Button
        variant="peri"
        disabled={disabled || liquidity === 0n || batch.busy}
        onClick={() => batch.send(calls)}
      >
        {batch.busy ? "Buying…" : `Buy ${isPut ? "put" : "call"}`}
      </Button>

      <Note>
        <strong className="text-foreground">This removes liquidity from the pool.</strong> That inversion is
        what makes you long. Buyers post collateral directly — only sellers route through Aqua.
      </Note>

      <BatchNote batch={batch} label="Buy" />
    </div>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-md border-rule border-line bg-lime-wash px-3.5 py-3 text-xs leading-relaxed text-ink-soft">
      {children}
    </p>
  );
}
