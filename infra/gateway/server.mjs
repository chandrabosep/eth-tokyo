/**
 * The only thing between the internet and anvil.
 *
 * anvil binds to 127.0.0.1, so its admin RPC is not reachable from outside this box at all —
 * not "reachable but guarded". That is the whole security model, and it is why the faucet lives
 * here rather than in a Vercel route: a leaked token cannot open a port that is not listening.
 *
 * Two jobs:
 *   POST /        JSON-RPC proxy with an explicit method allowlist
 *   POST /faucet  threshold top-up, the one operation allowed to touch admin RPC
 *   GET  /health  liveness, for the reset timer and for eyeballing
 *
 * Zero dependencies on purpose. Two ABI encodings is cheaper than an npm tree on a box whose
 * only job is to stay up.
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const ANVIL = process.env.ANVIL_URL ?? "http://127.0.0.1:8545";
const PORT = Number(process.env.PORT ?? 8546);
/** Written by the reset job; the addresses the frontend was built against. */
const BASELINE = process.env.BASELINE ?? "/opt/recycled/infra/expected-addresses.json";

const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
/** Morpho on Base: ~221M USDC, ~80k WETH. A faucet only because this is a fork. */
const WHALE = process.env.WHALE ?? "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

const MAX_BODY = 512 * 1024;
const MAX_BATCH = 64;
const COOLDOWN_MS = 30_000;

/**
 * An explicit set, not an `eth_` prefix match.
 *
 * anvil also serves `eth_sendTransaction` and `eth_sendUnsignedTransaction`, which send from an
 * unlocked or arbitrary account with no signature — an `eth_*` prefix rule would wave both
 * through and hand the chain to anyone. Enumerating is the only version of this that is
 * auditable.
 */
const ALLOWED = new Set([
  "eth_chainId",
  "eth_blockNumber",
  "eth_getBalance",
  "eth_getCode",
  "eth_getStorageAt",
  "eth_getTransactionCount",
  "eth_call",
  "eth_estimateGas",
  "eth_gasPrice",
  "eth_maxPriorityFeePerGas",
  "eth_feeHistory",
  "eth_getBlockByNumber",
  "eth_getBlockByHash",
  "eth_getTransactionByHash",
  "eth_getTransactionReceipt",
  "eth_getLogs",
  "eth_sendRawTransaction",
  "eth_syncing",
  "net_version",
  "web3_clientVersion",
]);

// ------------------------------------------------------------------------------------------
// anvil plumbing
// ------------------------------------------------------------------------------------------

let rpcId = 1;

async function rpc(method, params = []) {
  const res = await fetch(ANVIL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: rpcId++, method, params }),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

const pad = (hex) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const hex = (n) => "0x" + n.toString(16);

/** balanceOf(address) */
const balanceOfData = (addr) => "0x70a08231" + pad(addr);
/** transfer(address,uint256) */
const transferData = (to, amount) => "0xa9059cbb" + pad(to) + pad(hex(amount));

async function erc20Balance(token, holder) {
  return BigInt(await rpc("eth_call", [{ to: token, data: balanceOfData(holder) }, "latest"]));
}

/**
 * Impersonation is global chain state, so two concurrent faucet calls can stop each other's
 * impersonation mid-transfer. Serialise every admin sequence behind one promise chain.
 */
let queue = Promise.resolve();
const serialise = (fn) => (queue = queue.then(fn, fn));

async function topUpTokens(address, transfers) {
  await rpc("anvil_impersonateAccount", [WHALE]);
  try {
    // Gas for the whale itself; it holds tokens on the fork but not necessarily ETH.
    await rpc("anvil_setBalance", [WHALE, hex(10n ** 18n)]);
    for (const { token, amount } of transfers) {
      await rpc("eth_sendTransaction", [
        { from: WHALE, to: token, data: transferData(address, amount) },
      ]);
    }
  } finally {
    await rpc("anvil_stopImpersonatingAccount", [WHALE]);
  }
}

// ------------------------------------------------------------------------------------------
// Faucet
// ------------------------------------------------------------------------------------------

/**
 * Top up to a ceiling only when below a floor, rather than granting a fixed amount.
 *
 * This is what makes the endpoint self-limiting: looping it returns the same balances and moves
 * no state, so rate limiting is not the thing protecting the chain. The cooldown below exists
 * only to stop hammering.
 */
const FLOORS = [
  { key: "eth", floor: 10n ** 18n, ceiling: 10n * 10n ** 18n },
  { key: "weth", token: WETH, floor: 10n * 10n ** 18n, ceiling: 100n * 10n ** 18n },
  { key: "usdc", token: USDC, floor: 50_000n * 10n ** 6n, ceiling: 500_000n * 10n ** 6n },
];

const lastSeen = new Map();

async function faucet(address) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return { status: 400, body: { error: "Not a 20-byte address." } };
  }
  const addr = address.toLowerCase();

  const now = Date.now();
  const prev = lastSeen.get(addr);
  if (prev && now - prev < COOLDOWN_MS) {
    const wait = Math.ceil((COOLDOWN_MS - (now - prev)) / 1000);
    return { status: 429, body: { error: `Slow down — try again in ${wait}s.` } };
  }
  lastSeen.set(addr, now);

  // An address carrying code (an EIP-7702 delegation, or a smart account) fails the ERC-1155
  // receiver check when a position is minted to it. demo/fund.sh only warns; refusing here is
  // better than funding a wallet whose first trade is guaranteed to revert.
  if ((await rpc("eth_getCode", [addr, "latest"])) !== "0x") {
    return {
      status: 400,
      body: {
        error:
          "This address has contract code (a smart account or an EIP-7702 delegation). " +
          "Positions are ERC-1155 and the mint would revert on the receiver check. Use a plain EOA.",
      },
    };
  }

  const transfers = [];
  let setEth = null;

  for (const f of FLOORS) {
    const balance = f.token
      ? await erc20Balance(f.token, addr)
      : BigInt(await rpc("eth_getBalance", [addr, "latest"]));
    if (balance >= f.floor) continue;
    if (f.token) transfers.push({ token: f.token, amount: f.ceiling - balance });
    else setEth = f.ceiling;
  }

  if (setEth !== null) await rpc("anvil_setBalance", [addr, hex(setEth)]);
  if (transfers.length > 0) await topUpTokens(addr, transfers);

  return {
    status: 200,
    body: {
      address: addr,
      funded: setEth !== null || transfers.length > 0,
      balances: {
        eth: (BigInt(await rpc("eth_getBalance", [addr, "latest"]))).toString(),
        weth: (await erc20Balance(WETH, addr)).toString(),
        usdc: (await erc20Balance(USDC, addr)).toString(),
      },
    },
  };
}

// ------------------------------------------------------------------------------------------
// HTTP
// ------------------------------------------------------------------------------------------

const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", ...CORS });
  res.end(payload);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("Body too large."));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/** A batch is rejected whole if any entry is disallowed — never partially applied. */
function methodsOf(payload) {
  const entries = Array.isArray(payload) ? payload : [payload];
  if (entries.length === 0 || entries.length > MAX_BATCH) return null;
  return entries.map((e) => (e && typeof e.method === "string" ? e.method : ""));
}

const server = createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  const url = new URL(req.url, "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") {
    try {
      // Liveness is not enough. anvil holds state in memory, so after a restart it answers
      // eth_chainId perfectly happily while carrying none of the contracts — a health check that
      // only asks "is the node up" reports ok on a chain the site cannot read anything from.
      // Re-read the baseline each time so a reset that moves addresses is picked up.
      let manager = null;
      try {
        manager = JSON.parse(readFileSync(BASELINE, "utf8")).optionsManager ?? null;
      } catch {
        /* no baseline yet — nothing has been deployed on this box */
      }
      const deployed =
        manager === null ? null : (await rpc("eth_getCode", [manager, "latest"])) !== "0x";

      send(res, deployed === false ? 503 : 200, {
        ok: deployed !== false,
        chainId: await rpc("eth_chainId"),
        blockNumber: await rpc("eth_blockNumber"),
        optionsManager: manager,
        deployed,
        ...(deployed === false && {
          error: "Chain is up but the market is not deployed — the watchdog should redeploy within ~2 minutes.",
        }),
      });
    } catch (e) {
      send(res, 503, { ok: false, error: String(e.message ?? e) });
    }
    return;
  }

  if (req.method !== "POST") {
    send(res, 405, { error: "Method not allowed." });
    return;
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (e) {
    send(res, 413, { error: String(e.message ?? e) });
    return;
  }

  if (url.pathname === "/faucet") {
    let address;
    try {
      address = JSON.parse(raw).address;
    } catch {
      send(res, 400, { error: "Body must be JSON: { address }." });
      return;
    }
    try {
      const { status, body } = await serialise(() => faucet(String(address ?? "")));
      send(res, status, body);
    } catch (e) {
      send(res, 500, { error: String(e.message ?? e) });
    }
    return;
  }

  if (url.pathname !== "/") {
    send(res, 404, { error: "Not found." });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    send(res, 400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }

  const methods = methodsOf(payload);
  if (methods === null) {
    send(res, 400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32600, message: `Batch must hold 1..${MAX_BATCH} entries` },
    });
    return;
  }

  const blocked = methods.find((m) => !ALLOWED.has(m));
  if (blocked !== undefined) {
    send(res, 403, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32601, message: `Method not available: ${blocked || "(missing)"}` },
    });
    return;
  }

  const upstream = await fetch(ANVIL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: raw,
  });
  const text = await upstream.text();
  res.writeHead(upstream.status, { "content-type": "application/json", ...CORS });
  res.end(text);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`gateway on 127.0.0.1:${PORT} -> ${ANVIL}`);
});
