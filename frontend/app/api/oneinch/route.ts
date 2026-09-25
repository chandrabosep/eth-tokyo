import { NextResponse } from "next/server";

/**
 * Server-side proxy to the 1inch Aggregation API.
 *
 * The key stays on the server — it is never shipped to the browser. Without a key configured the
 * route returns a clearly-labelled unavailable response so the Hedge page still renders the delta
 * maths and explains what is missing, rather than breaking.
 *
 * Docs: https://portal.1inch.dev — Classic Swap v6.1
 */
const BASE = "https://api.1inch.com/swap/v6.1";
const CHAIN_ID = 8453; // Base

export async function GET(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("mode") ?? "quote"; // "quote" | "swap"
  const src = url.searchParams.get("src");
  const dst = url.searchParams.get("dst");
  const amount = url.searchParams.get("amount");
  const from = url.searchParams.get("from");
  const slippage = url.searchParams.get("slippage") ?? "1";

  if (!src || !dst || !amount) {
    return NextResponse.json({ error: "src, dst and amount are required" }, { status: 400 });
  }

  const apiKey = process.env.ONEINCH_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      {
        unavailable: true,
        reason:
          "ONEINCH_API_KEY is not set. Add it to frontend/.env.local to enable live 1inch quotes and swap calldata.",
      },
      { status: 200 },
    );
  }

  const qs = new URLSearchParams({ src, dst, amount });
  if (mode === "swap") {
    if (!from) return NextResponse.json({ error: "from is required for swap" }, { status: 400 });
    qs.set("from", from);
    qs.set("origin", from);
    qs.set("slippage", slippage);
    qs.set("disableEstimate", "true");
  }

  try {
    const res = await fetch(`${BASE}/${CHAIN_ID}/${mode}?${qs}`, {
      headers: { Authorization: `Bearer ${apiKey}`, accept: "application/json" },
      cache: "no-store",
    });
    const body = await res.json();
    if (!res.ok) {
      return NextResponse.json({ error: body?.description ?? body?.error ?? "1inch request failed" }, { status: res.status });
    }
    return NextResponse.json(body);
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
