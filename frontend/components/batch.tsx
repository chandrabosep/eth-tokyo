"use client";

import { useCallback, useState } from "react";
import { useDanceWithBatch } from "@/components/cursor-dance";
import { useAccount, useCapabilities, useConfig } from "wagmi";
import type { Config } from "@wagmi/core";
import {
  getBytecode,
  getConnectorClient,
  sendCalls,
  switchChain,
  waitForCallsStatus,
  waitForTransactionReceipt,
  writeContract,
} from "@wagmi/core";
import type { Abi, Address, Client } from "viem";
import { AlertTriangle, CheckCircle2, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";
import { deployed } from "@/lib/config";
import { baseFork } from "@/lib/wagmi";
import { revertMessage } from "@/components/tx";

/**
 * One click, however many contract calls it takes.
 *
 * Every trade here is one intention split across several transactions — approve, ship the Aqua
 * offer, write — and making the user drive that split was the worst thing about trading on this
 * app. EIP-5792 exists for exactly this: `wallet_sendCalls` hands the wallet the whole list, and a
 * wallet that can batch executes it as ONE atomic transaction, signed once. That is the good path,
 * and the one a smart account or a 7702-upgraded EOA takes.
 *
 * Most wallets on a private fork cannot, so the same list is replayed as ordinary transactions.
 * That path is written out below rather than delegated to viem's `experimental_fallback`, for two
 * reasons, both of which matter for this particular sequence:
 *
 *   - It waits for each receipt. `sellOptionViaAqua` pulls against backing that `ship` registered,
 *     so the wallet must not be asked to estimate the write against a chain that has not seen the
 *     ship yet.
 *   - It stops at the first refusal. viem's loop keeps prompting after a rejected call, which on
 *     this sequence means being asked to ship an offer for a write you just declined to authorise.
 *
 * Either way the user clicks once. What differs is how many times their wallet asks.
 *
 * Every call names the chain. wagmi turns an absent `chainId` into `chain: null`, which switches
 * viem's chain assertion OFF — the transaction then goes to whatever network the wallet happens to
 * be on, and this app waits for a receipt on the fork that will never arrive. Naming it turns a
 * silent hang into a mismatch error the user can act on.
 */
export type BatchCall = {
  /** What this call does, in the user's words. The plan the user sees is built from these. */
  label: string;
  to: Address;
  abi: Abi;
  functionName: string;
  args: readonly unknown[];
};

type BatchState = {
  status: "idle" | "running" | "success" | "failure";
  /**
   * Which side of the call we are waiting on. "confirm" is the wallet's turn and can sit there as
   * long as the user does; "mine" is the chain's, and should be seconds. Telling them apart is the
   * difference between "your wallet is asking you something" and "something is wrong".
   */
  phase: "confirm" | "mine";
  /** How many calls have landed, and what the wallet is being asked for right now. */
  done: number;
  total: number;
  current?: string;
  hash?: `0x${string}`;
  /** Whether the wallet took the whole list as a single transaction. */
  atomic: boolean;
  error?: unknown;
};

const idle: BatchState = { status: "idle", phase: "confirm", done: 0, total: 0, atomic: false };

/** Long enough for a congested chain, short enough that a wrong-network send cannot spin forever. */
const RECEIPT_TIMEOUT = 90_000;

export function useBatch() {
  const config = useConfig();
  const { address, chainId } = useAccount();
  const canBatch = useAtomicBatch();
  const [state, setState] = useState<BatchState>(idle);

  // A trade landing is worth showing at the pointer, not only in the panel.
  useDanceWithBatch(state.status);

  const send = useCallback(
    async (calls: BatchCall[]) => {
      if (calls.length === 0 || !address) return;
      const base = { status: "running", phase: "confirm", total: calls.length, atomic: canBatch } as const;
      setState({ ...base, done: 0, current: calls[0].label });

      // A wallet on the wrong network would otherwise send the first call somewhere else entirely.
      // Switching is part of the one click rather than a separate errand for the user.
      if (chainId !== baseFork.id) {
        try {
          await switchChain(config, { chainId: baseFork.id });
        } catch (error) {
          setState({
            ...base,
            status: "failure",
            done: 0,
            current: `Switching to chain ${baseFork.id}`,
            error,
          });
          return;
        }
      }

      const mismatch = await wrongNode(config);
      if (mismatch) {
        setState({ ...base, status: "failure", done: 0, error: mismatch });
        return;
      }

      if (canBatch) {
        try {
          const { id } = await sendCalls(config, {
            account: address,
            chainId: baseFork.id,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            calls: calls.map(({ label: _label, ...call }) => call) as any,
          });
          setState({ ...base, phase: "mine", done: 0, current: calls[0].label });
          const result = await waitForCallsStatus(config, { id, timeout: RECEIPT_TIMEOUT });
          setState({
            status: result.status === "success" ? "success" : "failure",
            phase: "mine",
            done: result.status === "success" ? calls.length : 0,
            total: calls.length,
            atomic: true,
          });
          return;
        } catch (error) {
          if (!unsupported(error)) {
            setState({ status: "failure", phase: "confirm", done: 0, total: calls.length, atomic: true, error });
            return;
          }
          // The wallet advertised batching and then refused it. Fall through and send them one
          // at a time rather than making the user start again.
        }
      }

      // The wallet's own client, used to watch the nonce its node reports between calls.
      const walletClient = await getConnectorClient(config).catch(() => undefined);

      for (const [i, call] of calls.entries()) {
        const step = { status: "running", total: calls.length, done: i, current: call.label, atomic: false } as const;
        setState({ ...step, phase: "confirm" });
        const nonceBefore = await pendingNonce(walletClient, address);
        let hash: `0x${string}` | undefined;
        try {
          hash = await writeContract(config, {
            account: address,
            chainId: baseFork.id,
            address: call.to,
            abi: call.abi,
            functionName: call.functionName,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            args: call.args as any,
          });
          setState({ ...step, phase: "mine", hash });
          const receipt = await waitForTransactionReceipt(config, {
            hash,
            chainId: baseFork.id,
            timeout: RECEIPT_TIMEOUT,
          });
          if (receipt.status === "reverted") {
            setState({ ...step, status: "failure", phase: "mine", hash });
            return;
          }
          if (i < calls.length - 1) await settleNonce(walletClient, address, nonceBefore);
        } catch (error) {
          setState({ ...step, status: "failure", phase: hash ? "mine" : "confirm", hash, error });
          return;
        }
      }

      setState({ status: "success", phase: "mine", done: calls.length, total: calls.length, atomic: false });
    },
    [address, canBatch, chainId, config],
  );

  return {
    send,
    busy: state.status === "running",
    isSuccess: state.status === "success",
    /** Refused, or reverted on-chain. `error` is undefined for the latter, exactly like a write. */
    failed: state.status === "failure",
    state,
    error: state.error,
    reset: () => setState(idle),
  };
}

/**
 * Whether this wallet can sign the batch once, asked before anything is sent.
 *
 * Wallets without `wallet_getCapabilities` answer with an RPC error, which is an answer — so the
 * query does not retry, and a failure reads as "no".
 */
export function useAtomicBatch(): boolean {
  const { address, chainId } = useAccount();
  const { data } = useCapabilities({
    account: address,
    query: { enabled: !!address, retry: false, staleTime: 60_000 },
  });
  const atomic = chainId ? data?.[chainId]?.atomic?.status : undefined;
  return atomic === "supported" || atomic === "ready";
}

/** The calls, numbered, with a line saying how many times the wallet will ask. */
export function BatchPlan({
  calls,
  atomic,
  batch,
}: {
  calls: BatchCall[];
  atomic: boolean;
  batch?: ReturnType<typeof useBatch>;
}) {
  if (calls.length === 0) return null;
  const { done = 0, status = "idle" } = batch?.state ?? {};
  const running = status === "running";

  return (
    <div className="rounded-md border-rule border-line bg-paper-2 px-3.5 py-3">
      <ol className="flex flex-col gap-1.5">
        {calls.map((c, i) => {
          // Ticks only while the batch is in flight. Once it lands the panel recomputes what is
          // still needed, and carrying the old count over would mark a fresh plan as already done.
          const complete = running && i < done;
          const active = running && i === done && !atomic;
          return (
            <li
              key={`${c.functionName}-${i}`}
              className={cn(
                "flex items-center gap-2.5 text-[12.5px]",
                complete && "text-ink-faint line-through",
              )}
            >
              <span
                className={cn(
                  "grid size-[18px] shrink-0 place-items-center rounded-pill border-rule border-line text-[10px] font-extrabold tnum",
                  complete ? "bg-lime" : active ? "bg-flag" : "bg-card",
                )}
              >
                {complete ? "✓" : i + 1}
              </span>
              <span className="font-medium">{c.label}</span>
              {active && <Loader2 className="size-3 animate-spin text-ink-soft" aria-hidden="true" />}
            </li>
          );
        })}
      </ol>
      <p className="mt-2.5 border-t border-line pt-2 text-[11.5px] text-ink-soft">
        {calls.length === 1 ? (
          "One transaction."
        ) : atomic ? (
          <>
            <strong className="font-extrabold text-ink">One signature.</strong> Your wallet batches all{" "}
            {calls.length} into a single transaction.
          </>
        ) : (
          <>
            <strong className="font-extrabold text-ink">{calls.length} confirmations, one click.</strong> Your
            wallet cannot batch, so they are sent in order — just approve each prompt.
          </>
        )}
      </p>
    </div>
  );
}

export function BatchNote({ batch, label }: { batch: ReturnType<typeof useBatch>; label: string }) {
  const { status, phase, done, total, current, hash, atomic, error } = batch.state;

  if (status === "failure") {
    return (
      <Shell tone="error" icon={<AlertTriangle className="size-3.5" aria-hidden="true" />}>
        {(error as Error)?.name === "NodeMismatchError" ? (
          (error as Error).message
        ) : timedOut(error) ? (
          <>
            {current ?? label} was signed but never confirmed on chain{" "}
            <span className="font-mono">{baseFork.id}</span>. Check your wallet is on this network — a
            transaction sent to another one will never show up here.
            {hash && <span className="block font-mono text-[11.5px]">{hash}</span>}
          </>
        ) : error ? (
          <>
            {current ?? label} failed:{" "}
            <span className="font-mono text-[11.5px]">{revertMessage(error)}</span>
          </>
        ) : (
          <>{current ?? label} reverted on-chain.</>
        )}
        {/* Which calls already landed decides what to do next, so it is never left implicit. */}
        {done > 0 && (
          <>
            {" "}
            The first {done} of {total} went through — reopen this panel to pick up what is left.
          </>
        )}
      </Shell>
    );
  }

  if (status === "running") {
    const step = total > 1 ? ` · ${done + 1} of ${total}` : "";
    return (
      <Shell tone="info" icon={<Loader2 className="size-3.5 animate-spin" aria-hidden="true" />}>
        {phase === "confirm" ? (
          <>
            {/* Said explicitly, because a wallet that opens in a popup behind the window looks
                exactly like an app that has hung. */}
            <strong className="font-extrabold text-ink">Open your wallet</strong> to approve{" "}
            {atomic ? "the batch" : current}
            {step}.
          </>
        ) : (
          <>
            Waiting for the chain{step}
            {hash && <span className="font-mono text-[11.5px]"> · {hash.slice(0, 14)}…</span>}
          </>
        )}
      </Shell>
    );
  }

  if (status === "success") {
    return (
      <Shell tone="success" icon={<CheckCircle2 className="size-3.5" aria-hidden="true" />}>
        {label} confirmed · {atomic ? "one transaction" : `${total} transaction${total > 1 ? "s" : ""}`}
      </Shell>
    );
  }

  return null;
}

/** What the wallet's own node thinks this account's next nonce is. */
async function pendingNonce(client: Client | undefined, address: Address): Promise<number | undefined> {
  if (!client) return undefined;
  try {
    const hex = (await client.request({
      method: "eth_getTransactionCount",
      params: [address, "pending"],
    })) as `0x${string}`;
    return Number(hex);
  } catch {
    return undefined;
  }
}

/**
 * Let the wallet notice the transaction that just landed, before asking it for the next one.
 *
 * A wallet picks the next nonce from its OWN polling of the chain, not from the receipt this app
 * just read. Prompting the next call the instant that receipt arrives can therefore hand the node
 * a nonce it has already used — "nonce too low", with the earlier calls on-chain and the rest not.
 * Firing them back to back is what opened that window; waiting for the count the wallet itself
 * reports is what closes it.
 *
 * Bounded, and advisory: if the wallet will not answer, or is simply slow, the next call goes out
 * anyway rather than stranding a half-finished batch.
 */
async function settleNonce(
  client: Client | undefined,
  address: Address,
  before: number | undefined,
  timeout = 8_000,
) {
  if (!client || before === undefined) return;
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const now = await pendingNonce(client, address);
    if (now === undefined || now > before) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

/**
 * Is the wallet signing against a different node than this app reads?
 *
 * The chain id cannot answer that. Every anvil fork of Base calls itself 31337, so a wallet on a
 * local node and an app on the hosted one agree on the id, pass every mismatch check, and then the
 * signed transaction lands somewhere this app will never look — which shows up as a write that was
 * "signed but never confirmed". The deployments themselves are the fingerprint: different nodes
 * carry different bytecode at the manager's address, so comparing it settles the question.
 *
 * A wallet that will not serve `eth_getCode` simply does not answer, and the trade goes ahead —
 * this is here to catch a specific misconfiguration, not to gate trading on an optional RPC method.
 */
async function wrongNode(config: Config): Promise<Error | undefined> {
  try {
    const client = await getConnectorClient(config);
    const [wallet, app] = await Promise.all([
      client.request({ method: "eth_getCode", params: [deployed.optionsManager, "latest"] }),
      getBytecode(config, { address: deployed.optionsManager, chainId: baseFork.id }),
    ]);
    if ((wallet ?? "0x") === (app ?? "0x")) return undefined;
    return Object.assign(new Error(
      `Your wallet is signing against a different node. It reports chain ${baseFork.id}, but the ` +
        `contracts there are not the ones this app is reading — anything you sign will land where ` +
        `this app cannot see it. Point your wallet's network at ${
          process.env.NEXT_PUBLIC_RPC_URL ?? "this app's RPC"
        }.`,
      ),
      // Named so the note prints it on its own: it is a complete sentence about the setup, not
      // a failure report about one call.
      { name: "NodeMismatchError" },
    );
  } catch {
    return undefined;
  }
}

/** Signed, then never seen again — almost always a wallet pointed at a different network. */
function timedOut(error: unknown): boolean {
  const name = (error as { name?: string })?.name ?? "";
  return name === "WaitForTransactionReceiptTimeoutError" || name === "WaitForCallsStatusTimeoutError";
}

/** A wallet that turned out not to speak EIP-5792 after all. */
function unsupported(error: unknown): boolean {
  const e = error as { name?: string; code?: number; details?: string; message?: string };
  if (e?.code === -32601 || e?.code === 4200) return true;
  if (e?.name === "MethodNotFoundRpcError" || e?.name === "MethodNotSupportedRpcError") return true;
  const text = `${e?.details ?? ""} ${e?.message ?? ""}`.toLowerCase();
  return (
    text.includes("does not exist / is not available") ||
    text.includes("not supported") ||
    text.includes("unsupported")
  );
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
