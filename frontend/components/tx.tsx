"use client";

import { useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { type Address } from "viem";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { deployed, USDC_DECIMALS, WETH_DECIMALS } from "@/lib/config";
import { fmt, fromRaw } from "@/lib/options";

/**
 * Wraps write + receipt so buttons can show pending / confirmed without ceremony.
 *
 * `reverted` matters as much as `error`. A transaction accepted by the node and
 * then reverted on-chain produces no `error` — `useWriteContract` already
 * resolved, and the receipt simply comes back with `status: "reverted"`.
 * Without surfacing that, a failed trade looks identical to one never sent:
 * the button just goes quiet. That is what made an out-of-gas `buyOption` feel
 * like it was stuck after signing.
 */
export function useTx() {
  const { writeContract, data: hash, isPending, error, reset } = useWriteContract();
  const { data: receipt, isLoading: mining, isSuccess } = useWaitForTransactionReceipt({ hash });
  const reverted = receipt?.status === "reverted";
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    send: (args: any) => writeContract(args),
    hash,
    receipt,
    busy: isPending || mining,
    isSuccess: isSuccess && !reverted,
    reverted,
    error,
    reset,
  };
}

function Shell({
  tone,
  icon,
  children,
}: {
  tone: "info" | "error" | "success";
  icon: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "flex items-start gap-2.5 rounded-md border-rule border-line px-3.5 py-3 text-[12.5px] leading-relaxed shadow-xs",
        tone === "error" && "bg-destructive/12",
        tone === "success" && "bg-lime-wash",
        tone === "info" && "bg-paper-2",
      )}
    >
      <span className="mt-0.5 shrink-0">{icon}</span>
      <span className="min-w-0 break-words font-medium">{children}</span>
    </div>
  );
}

/**
 * Turn a viem revert into something a human can act on.
 *
 * Two layers, because the failure that prompted this had neither.
 *
 * First the structured one: viem decodes a custom error into `errorName` + `args` when the ABI
 * declares it, so `InsufficientAquaBacking` can be printed with the token's symbol and the amounts
 * in whole units — "needs 30,000.00 USDC, offer has 18,000.80" — instead of an address and two
 * raw integers. That specific error is worth the special case: it is the one a seller hits by
 * simply writing more than they shipped, and the remedy depends on the numbers.
 *
 * Then the fallback: scrape the message. viem's first line is only ever "The contract function X
 * reverted.", so `message.split("\n")[0]` discards everything useful — which is exactly how a
 * failed write came out as "reverted with the following reason:" followed by nothing.
 */
/**
 * Find viem's decoded revert by SHAPE, not by `instanceof`.
 *
 * viem ships both ESM and CJS builds, so a bundle can end up holding two copies of
 * `ContractFunctionRevertedError`. The error thrown by wagmi's copy then fails `instanceof` against
 * the one imported here — silently, falling through to the string fallback with no sign anything
 * is wrong. Walking `cause` for the decoded payload works whichever copy threw.
 */
function decodedRevert(error: unknown): { errorName?: string; args?: readonly unknown[] } | undefined {
  for (let e: unknown = error, depth = 0; e && depth < 12; depth++) {
    const data = (e as { data?: { errorName?: string; args?: readonly unknown[] } }).data;
    if (data?.errorName) return data;
    e = (e as { cause?: unknown }).cause;
  }
  return undefined;
}

export function revertMessage(error: unknown): string {
  const reverted = decodedRevert(error);

  if (reverted) {
    const { errorName, args } = reverted;
    if (errorName === "InsufficientAquaBacking" && args?.length === 3) {
      const [token, required, available] = args as unknown as [Address, bigint, bigint];
      const isWeth = token.toLowerCase() === deployed.weth.toLowerCase();
      const dp = isWeth ? WETH_DECIMALS : USDC_DECIMALS;
      const sym = isWeth ? "WETH" : "USDC";
      const show = (v: bigint) => fmt(fromRaw(v, dp), isWeth ? 5 : 2);
      const tail = "Needs a new offer, not a top-up.";
      return available === 0n
        ? `Your offer does not back ${sym} at all. This write needs ${show(required)}. ${tail}`
        : `Offer too small. This write needs ${show(required)} ${sym}, the offer has ${show(
            available,
          )}. ${tail}`;
    }
    if (errorName) {
      return args?.length ? `${errorName}(${args.map(String).join(", ")})` : errorName;
    }
  }

  const lines = ((error as Error)?.message ?? String(error)).split("\n").map((l) => l.trim());

  const i = lines.findIndex((l) => l.startsWith("Error:") && l.length > "Error:".length);
  if (i >= 0) {
    // The argument values sit on the line after the signature.
    const args = lines[i + 1]?.startsWith("(") ? ` ${lines[i + 1]}` : "";
    return `${lines[i].replace(/^Error:\s*/, "")}${args}`;
  }

  const reason = lines.findIndex((l) => l.endsWith("reverted with the following reason:"));
  if (reason >= 0 && lines[reason + 1]) return lines[reason + 1];

  return lines[0] ?? "unknown error";
}

export function TxNote({ tx, label }: { tx: ReturnType<typeof useTx>; label: string }) {
  if (tx.error) {
    const msg = revertMessage(tx.error);
    return (
      <Shell tone="error" icon={<AlertTriangle className="size-3.5" aria-hidden="true" />}>
        {label} failed: <span className="font-mono text-[11.5px]">{msg}</span>
      </Shell>
    );
  }

  if (tx.reverted) {
    // A revert that consumed very little gas is out-of-gas, which on this stack
    // almost always means the wallet estimated the limit itself instead of
    // asking the node — i.e. it is on the wrong network.
    const used = tx.receipt ? Number(tx.receipt.gasUsed) : 0;
    const outOfGas = used > 0 && used < 120_000;
    return (
      <Shell tone="error" icon={<AlertTriangle className="size-3.5" aria-hidden="true" />}>
        {label} reverted on-chain (gas used <span className="font-mono">{used.toLocaleString()}</span>).
        {outOfGas && (
          <>
            {" "}
            Too little for this call. Check your wallet is on the Base fork, chain{" "}
            <span className="font-mono">31337</span>.
          </>
        )}
      </Shell>
    );
  }

  if (tx.busy && tx.hash) {
    return (
      <Shell tone="info" icon={<Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}>
        {label} pending · <span className="font-mono text-[11.5px]">{tx.hash.slice(0, 18)}…</span>
      </Shell>
    );
  }

  if (tx.isSuccess && tx.hash) {
    return (
      <Shell tone="success" icon={<CheckCircle2 className="size-3.5" aria-hidden="true" />}>
        {label} confirmed · <span className="font-mono text-[11.5px]">{tx.hash.slice(0, 18)}…</span>
      </Shell>
    );
  }

  return null;
}
