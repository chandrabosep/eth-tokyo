"use client";

import { useWaitForTransactionReceipt, useWriteContract } from "wagmi";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

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
        "flex items-start gap-2.5 rounded-md border-rule border-line p-3 text-[12.5px] leading-relaxed shadow-xs",
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

export function TxNote({ tx, label }: { tx: ReturnType<typeof useTx>; label: string }) {
  if (tx.error) {
    const msg = (tx.error as Error).message.split("\n")[0];
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
            Far too little for this call, which needs roughly 430,000 — your wallet almost certainly estimated the
            gas itself. Check it is on <strong className="font-extrabold">Base fork</strong>, chain{" "}
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
