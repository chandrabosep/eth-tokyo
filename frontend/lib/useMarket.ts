"use client";

import { useReadContract, useReadContracts } from "wagmi";
import { optionsHookAbi, optionsManagerAbi, stateViewAbi } from "./abi";
import { deployed, poolId, STATE_VIEW } from "./config";
import { SERIES } from "./options";

/** Current pool tick, read straight from PoolManager storage via Uniswap's StateView lens. */
export function useSpotTick() {
  const { data, isLoading } = useReadContract({
    address: STATE_VIEW,
    abi: stateViewAbi,
    functionName: "getSlot0",
    args: [poolId],
  });
  return { tick: data ? Number(data[1]) : undefined, isLoading };
}

export type SeriesRow = {
  strikeIndex: number;
  isPut: boolean;
  tickLower: number;
  tickUpper: number;
  shortId: bigint;
  longId: bigint;
  shortLiquidity: bigint;
  longLiquidity: bigint;
};

/** Ticks, token ids and open interest for all six series (3 strikes x put/call). */
export function useSeries(): { rows: SeriesRow[]; isLoading: boolean } {
  const base = {
    address: deployed.optionsManager,
    abi: optionsManagerAbi,
  } as const;

  const { data: meta, isLoading: l1 } = useReadContracts({
    contracts: SERIES.flatMap(({ strikeIndex, isPut }) => [
      { ...base, functionName: "seriesTicks", args: [strikeIndex, isPut] } as const,
      { ...base, functionName: "tokenIdFor", args: [strikeIndex, isPut, false] } as const,
      { ...base, functionName: "tokenIdFor", args: [strikeIndex, isPut, true] } as const,
    ]),
  });

  const shortIds = SERIES.map((_, i) => meta?.[i * 3 + 1]?.result as bigint | undefined);

  const { data: oi, isLoading: l2 } = useReadContracts({
    contracts: shortIds.map(
      (id) => ({ ...base, functionName: "series", args: [id ?? 0n] }) as const,
    ),
    query: { enabled: shortIds.every((id) => id !== undefined) },
  });

  const rows: SeriesRow[] = SERIES.map((s, i) => {
    const ticks = meta?.[i * 3]?.result as readonly [number, number] | undefined;
    const open = oi?.[i]?.result as readonly [bigint, bigint] | undefined;
    return {
      strikeIndex: s.strikeIndex,
      isPut: s.isPut,
      tickLower: ticks ? Number(ticks[0]) : 0,
      tickUpper: ticks ? Number(ticks[1]) : 0,
      shortId: (meta?.[i * 3 + 1]?.result as bigint) ?? 0n,
      longId: (meta?.[i * 3 + 2]?.result as bigint) ?? 0n,
      shortLiquidity: open?.[0] ?? 0n,
      longLiquidity: open?.[1] ?? 0n,
    };
  });

  return { rows, isLoading: l1 || l2 };
}

/**
 * The hook's live pricing inputs.
 *
 * Read straight from the hook rather than recomputed here, so what the page shows is what the next
 * swap will actually be charged — the fee is not a display convention, it IS the premium.
 */
export function useHookPricing() {
  const { data } = useReadContracts({
    contracts: (
      ["realisedVolBps", "utilisationBps", "volFee", "currentFee"] as const
    ).map((fn) => ({ address: deployed.optionsHook, abi: optionsHookAbi, functionName: fn }) as const),
    query: { refetchInterval: 8_000 },
  });

  return {
    realisedVolBps: Number((data?.[0]?.result as bigint) ?? 0n),
    utilisationBps: Number((data?.[1]?.result as number) ?? 0),
    volFee: Number((data?.[2]?.result as number) ?? 0),
    currentFee: Number((data?.[3]?.result as number) ?? 0),
  };
}
