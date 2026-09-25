"use client";

import { useMemo } from "react";
import { useReadContracts } from "wagmi";
import { encodeAbiParameters, keccak256, type Address, type Hex } from "viem";

import { aquaAbi } from "@/lib/abi";
import { deployed } from "@/lib/config";

/**
 * Aqua offers, and the one thing about them that is easy to get wrong.
 *
 * An Aqua strategy is IMMUTABLE. `ship` a given (maker, app, strategyHash) once and that is the
 * end of it: you cannot ship it again to add more backing, and you cannot ship it again after
 * `dock` either — the registry rejects it with `StrategiesMustBeImmutable` forever. An offer is a
 * standing quote, not a balance you top up.
 *
 * The UI used to hold one hardcoded salt, which meant a seller got exactly one offer per
 * deployment. Write against it until it ran low and the next write failed inside Aqua's own
 * arithmetic — with no way to add more, and no way to tell from the screen that that was the
 * problem. So salts are now an indexed series, and "top up" means "ship the next one".
 *
 * Telling a fresh salt from a spent one is the other half. `rawBalances` returns
 * `(balance, tokensCount)`, and `tokensCount` is the marker:
 *
 *   never shipped        -> (0, 0)          <- safe to ship
 *   shipped, partly used -> (remaining, n)  <- usable while remaining covers the write
 *   shipped, then docked -> (0, 255)        <- dead, and can never be revived
 */

/** How many salts to scan. A seller who burns through 12 offers in one demo has other problems. */
export const OFFER_SLOTS = 12;

/** Salt for offer `i`. Index 0 is 0xa01a, the salt every earlier build used, so old offers survive. */
export function offerSalt(index: number): Hex {
  return `0x${(0xa01a + index).toString(16).padStart(64, "0")}` as Hex;
}

/** Mirrors `OptionsManager.aquaStrategyHash` — keccak of abi.encode(AquaStrategy{maker, app, salt}). */
export function strategyHashFor(maker: Address, salt: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "bytes32" }],
      [maker, deployed.optionsManager, salt],
    ),
  );
}

export type Offer = {
  index: number;
  salt: Hex;
  /** Shipped at some point, so this salt can never be shipped again. */
  used: boolean;
  weth: bigint;
  usdc: bigint;
};

export type AquaOffers = {
  offers: Offer[];
  /** The first live offer that covers `need`, or undefined if none does. */
  covering?: Offer;
  /** The first salt that has never been shipped — where a new offer must go. */
  nextFree?: Offer;
  isLoading: boolean;
  refetch: () => void;
};

/**
 * Scan a maker's offers and pick the one that can actually fund `need`.
 *
 * `need` is in raw token units and comes from the manager's own `collateralFor`, not from a
 * JavaScript estimate — an offer short by one wei is an offer that has to be abandoned.
 */
export function useAquaOffers(
  maker: Address | undefined,
  need: { weth: bigint; usdc: bigint } = { weth: 0n, usdc: 0n },
): AquaOffers {
  const salts = useMemo(() => Array.from({ length: OFFER_SLOTS }, (_, i) => offerSalt(i)), []);

  const { data, isLoading, refetch } = useReadContracts({
    contracts: maker
      ? salts.flatMap((salt) => {
          const hash = strategyHashFor(maker, salt);
          return (
            [
              {
                address: deployed.aqua,
                abi: aquaAbi,
                functionName: "rawBalances",
                args: [maker, deployed.optionsManager, hash, deployed.weth],
              },
              {
                address: deployed.aqua,
                abi: aquaAbi,
                functionName: "rawBalances",
                args: [maker, deployed.optionsManager, hash, deployed.usdc],
              },
            ] as const
          );
        })
      : [],
    query: { enabled: !!maker },
  });

  return useMemo(() => {
    const offers: Offer[] = salts.map((salt, i) => {
      const w = data?.[i * 2]?.result as readonly [bigint, number] | undefined;
      const u = data?.[i * 2 + 1]?.result as readonly [bigint, number] | undefined;
      return {
        index: i,
        salt,
        // Either token carrying a non-zero count means the strategy hash is spent.
        used: (w?.[1] ?? 0) !== 0 || (u?.[1] ?? 0) !== 0,
        weth: w?.[0] ?? 0n,
        usdc: u?.[0] ?? 0n,
      };
    });

    return {
      offers,
      covering: offers.find((o) => o.weth >= need.weth && o.usdc >= need.usdc && (o.weth > 0n || o.usdc > 0n)),
      nextFree: offers.find((o) => !o.used),
      isLoading,
      refetch,
    };
  }, [data, salts, need.weth, need.usdc, isLoading, refetch]);
}
