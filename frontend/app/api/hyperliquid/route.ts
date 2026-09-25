import { NextResponse } from "next/server";

/**
 * Read-only proxy to the Hyperliquid info API.
 *
 * Server-side for two reasons: the browser would hit CORS, and routing it here keeps the surface
 * to exactly the two read endpoints this feature needs. Nothing signs, nothing trades — Hyperliquid
 * is a *source of positions*, and every action the UI offers happens on our own options market.
 *
 * Docs: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/info-endpoint
 */
const HL_INFO = "https://api.hyperliquid.xyz/info";

/** Only these request types are forwarded. Both are read-only. */
const ALLOWED = new Set(["clearinghouseState", "allMids"]);

export async function GET(req: Request) {
  const url = new URL(req.url);
  const type = url.searchParams.get("type") ?? "clearinghouseState";
  const user = url.searchParams.get("user");

  if (!ALLOWED.has(type)) {
    return NextResponse.json({ error: `unsupported info type: ${type}` }, { status: 400 });
  }
  if (type === "clearinghouseState" && !/^0x[0-9a-fA-F]{40}$/.test(user ?? "")) {
    return NextResponse.json({ error: "a valid 0x address is required" }, { status: 400 });
  }

  const body = type === "clearinghouseState" ? { type, user } : { type };

  try {
    const res = await fetch(HL_INFO, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    if (!res.ok) {
      return NextResponse.json({ error: `Hyperliquid returned ${res.status}` }, { status: res.status });
    }
    return NextResponse.json(await res.json());
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }
}
