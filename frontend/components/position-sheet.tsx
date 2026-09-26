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
import { TxNote, useTx } from "@/components/tx";
import { TokenIcon, TokenLabel, TokenPair } from "@/components/token-icon";

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
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="notional" className="flex items-center gap-1.5">
              Notional <TokenLabel symbol={quoteSymbol} size={13} className="tracking-normal" />
            </Label>
            <Input id="notional" inputMode="decimal" value={notional} onChange={(e) => setNotional(e.target.value)} />
          </div>

          <div className="rounded-md border-rule border-line bg-card px-3.5 py-1 shadow-xs">
            <Row label="Liquidity units" value={liquidity.toString()} mono />
            <Row
              label={direction === "sell" ? "Collateral to post" : "Buyer collateral (10%)"}
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
          </div>

          {overBuy && (
            <p className="rounded-md border-rule border-line bg-destructive/12 px-3.5 py-3 text-xs shadow-xs">
              Only {available.toString()} liquidity units are written at this strike.
            </p>
          )}

          {!isConnected ? (
            <p className="rounded-md border-rule border-line bg-paper-2 px-3.5 py-3 text-xs text-ink-soft shadow-xs">
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
}: {
  strikeIndex: number;
  isPut: boolean;
  liquidity: bigint;
  legs: Leg[];
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

  const approve = useTx();
  const ship = useTx();
  const write = useTx();

  // Both of these change the registered balance, so the panel must re-read it to advance.
  const shipped = ship.isSuccess;
  const wrote = write.isSuccess;
  useEffect(() => {
    if (shipped || wrote) refetchOffers();
  }, [shipped, wrote, refetchOffers]);

  const enriched = required.map((t, i) => ({
    ...t,
    committed: t.symbol === "WETH" ? (covering?.weth ?? 0n) : (covering?.usdc ?? 0n),
    wallet: (tokenData?.[i * 2]?.result as bigint) ?? 0n,
    allowance: (tokenData?.[i * 2 + 1]?.result as bigint) ?? 0n,
  }));

  const needsApproval = enriched.find((l) => l.allowance < l.amount);
  const funded = required.length > 0 && !!covering;

  return (
    <div className="flex flex-col gap-4">
      <div className="rounded-md border-rule border-line bg-card px-3.5 py-1 shadow-xs">
        {enriched.map((l) => (
          <Row
            key={l.symbol}
            label={
              <span className="inline-flex items-center gap-1.5">
                <TokenIcon symbol={l.symbol} size={14} /> {l.symbol} needed / committed
              </span>
            }
            value={`${fmt(fromRaw(l.amount, l.decimals), l.decimals === 18 ? 5 : 2)} / ${fmt(
              fromRaw(l.committed, l.decimals),
              l.decimals === 18 ? 5 : 2,
            )}`}
            mono
          />
        ))}
        {covering && <Row label="Funded by offer" value={`#${covering.index}`} mono />}
      </div>

      {!funded ? (
        <>
          {required.length === 0 ? (
            <Note>Enter a size to see what this write needs.</Note>
          ) : !nextFree ? (
            <Note>
              <strong className="text-foreground">Every offer slot is spent.</strong> Nothing is lost, the
              tokens never left your wallet.
            </Note>
          ) : (
            <>
              {enriched.map((l) => (
                <div key={l.symbol} className="space-y-1.5">
                  <Label htmlFor={`ship-${l.symbol}`} className="flex items-center gap-1.5">
                    Step 1 · Back an offer <TokenLabel symbol={l.symbol} size={13} className="tracking-normal" />
                  </Label>
                  <Input
                    id={`ship-${l.symbol}`}
                    inputMode="decimal"
                    value={backing[l.symbol] ?? ""}
                    onChange={(e) => setBacking((b) => ({ ...b, [l.symbol]: e.target.value }))}
                  />
                  {toRaw(Number(backing[l.symbol]) || 0, l.decimals) < l.amount && (
                    <p className="text-[11px] text-destructive">
                      Below the {fmt(fromRaw(l.amount, l.decimals), l.decimals === 18 ? 5 : 2)}{" "}
                      <TokenLabel symbol={l.symbol} size={12} /> this write needs.
                    </p>
                  )}
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
                  {approve.busy ? "Approving…" : `Approve ${needsApproval.symbol} for Aqua`}
                </Button>
              ) : (
                <Button
                  disabled={
                    !strategy ||
                    ship.busy ||
                    enriched.some((l) => toRaw(Number(backing[l.symbol]) || 0, l.decimals) < l.amount)
                  }
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
                  {ship.busy ? "Shipping…" : `Ship offer #${nextFree.index}`}
                </Button>
              )}

              <Note>
                <strong className="text-foreground">Nothing leaves your wallet.</strong> Aqua registers the
                balance as backing. The tokens stay yours and stay liquid.
              </Note>
            </>
          )}
        </>
      ) : (
        <>
          <Button
            disabled={liquidity === 0n || write.busy || !salt}
            onClick={() =>
              write.send({
                address: deployed.optionsManager,
                abi: optionsManagerAbi,
                functionName: "sellOptionViaAqua",
                args: [address!, strikeIndex, isPut, liquidity, salt!],
              })
            }
          >
            {write.busy ? "Writing…" : "Step 2 · Write the option"}
          </Button>
          <Note>
            <strong className="text-foreground">Now the collateral moves.</strong> The mint pulls exactly what
            it needs, through Aqua.
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
        <Note>Buyers post collateral directly. Only sellers route through Aqua.</Note>
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
        what makes you long.
      </Note>
      <TxNote tx={buy} label="Buy" />
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
