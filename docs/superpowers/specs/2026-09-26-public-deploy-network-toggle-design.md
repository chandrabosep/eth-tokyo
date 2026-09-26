# Public deploy + testnet/mainnet toggle

Date: 2026-09-26
Status: approved design, not yet implemented

## Goal

Make Recycled publicly playable. Two things, together:

1. Host the pinned Base fork on AWS so a visitor can connect a wallet, get funds, and actually
   write and buy options.
2. Add a network toggle so the same frontend serves that demo fork **and** the real Base mainnet
   deployment.

Expected lifetime of the demo fork: a few days. It is a showcase, not a product.

## Non-goals

- No ECS, Kubernetes, or autoscaling. One box.
- No database. Faucet rate limiting is in-memory and dies with the process; that is acceptable.
- No mainnet deploy in CI. The mainnet deploy is run by hand, deliberately, once.
- No attempt to keep fork state and mainnet state consistent. They are different chains with
  different prices, and the UI says which one you are on.

## What actually differs between the two networks

The fork *is* Base mainnet state, so the infrastructure addresses are identical and need no
per-network handling:

| | Demo fork (31337) | Base mainnet (8453) |
|---|---|---|
| PoolManager `0x4985…2b` | same | same |
| Aqua `0x1111…90a` | same | same |
| WETH `0x4200…06`, USDC `0x8335…913` | same | same |
| `optionsHook` | `0x26cA74E7…` | **different** — CREATE2, mined for v4 flag bits |
| `optionsManager` | `0xdF0519BB…` | **different** — nonce-based from the deployer |
| `strikeUsd` / `strikeTicks` / `spotTick` | frozen at block 51698307 | computed from live spot at deploy |
| RPC | `https://fork.<domain>` | Infura Base endpoint |
| Faucet | yes | no |
| Block explorer | none | basescan.org |

So the unit of per-network configuration is **the deployment JSON**, and the frontend must choose
between two of them at runtime.

## A. Frontend: network becomes runtime state

### A1. Deployment files

`Deploy.s.sol:138` currently hardcodes `vm.writeJson(out, "./deployments/base-fork.json")`. Change
it to key on chain id:

```solidity
string memory path = string.concat("./deployments/", vm.toString(block.chainid), ".json");
```

Producing `deployments/31337.json` and `deployments/8453.json`. Keep `base-fork.json` as a symlink
or migrate the existing file; do not leave two sources of truth.

### A2. Network registry — `frontend/lib/networks.ts` (new)

```ts
export type NetworkKey = "fork" | "mainnet";

export type Network = {
  key: NetworkKey;
  label: string;          // "Demo" | "Base"
  chain: Chain;           // viem chain
  deployment: Deployment;
  rpcUrl: string;
  faucetUrl?: string;     // fork only
  explorerTxUrl?: (hash: string) => string;  // mainnet only
};

export const NETWORKS: Record<NetworkKey, Network>;
export const DEFAULT_NETWORK: NetworkKey = "fork";
export function networkForChainId(id: number): Network | undefined;
```

Both deployment JSONs are imported statically here. They are small and this keeps the frontend a
pure static build with no runtime config fetch.

### A3. `lib/config.ts` — from constants to a factory

Today this module computes `deployed`, `poolKey`, `poolId`, `STRIKE_COUNT`, `STRIKE_INDICES` and
`strikeLabel` at module scope from a single imported JSON. That is what makes the app single-network.

Replace with:

```ts
export type NetworkConfig = {
  deployed: Deployment;
  poolKey: PoolKey;
  poolId: Hex;
  strikeLabel: (index: number) => string;
  STRIKE_INDICES: number[];
  SERIES: { strikeIndex: number; isPut: boolean }[];
};

export function configFor(network: Network): NetworkConfig;  // memoized per network key
```

`STATE_VIEW`, `WETH_DECIMALS` and `USDC_DECIMALS` stay as plain constants — they do not vary.

`SERIES` currently lives in `lib/options.ts` and is derived from `STRIKE_COUNT`, so it moves into
`NetworkConfig`. The pure math in `options.ts` (`tickToUsdPrice`, `amountsForLiquidity`,
`legPnlAtPrice`, …) is network-independent and stays as-is.

### A4. Provider and hook

`NetworkProvider` in `app/providers.tsx`, exposing:

```ts
useNetwork(): {
  network: Network;
  config: NetworkConfig;
  setNetwork: (key: NetworkKey) => void;
  isWrongWallet: boolean;   // wallet connected but on a different chain
};
```

Active network resolution, in order:

1. If a wallet is connected → `networkForChainId(useChainId())`, when it matches a known network.
2. Otherwise → the user's explicit choice, persisted in `localStorage` under `recycled.network`.
3. Otherwise → `DEFAULT_NETWORK`.

Step 2 matters: the chain page must render for a visitor with no wallet, which is most visitors.

Reads must pass `chainId` explicitly to wagmi hooks rather than relying on the connected chain, so
an unconnected visitor still gets data from the selected network.

### A5. wagmi becomes multi-chain — `lib/wagmi.ts`

```ts
chains: [baseFork, base],
transports: {
  [baseFork.id]: http(FORK_RPC),
  [base.id]:     http(MAINNET_RPC),
},
```

`baseFork` keeps chain id 31337 and the Multicall3 address it inherits from Base — both for the
reasons already documented in `demo/anvil.sh` and `lib/wagmi.ts`. The toggle is
`useSwitchChain()`, not bespoke state.

### A6. Call-site migration

85 references across 11 files:

```
components/strategy-builder.tsx  30     lib/config.ts        12
components/position-sheet.tsx    19     lib/aqua.ts           5
app/positions/page.tsx            4     components/option-chain.tsx   4
lib/useMarket.ts                  4     app/strategies/page.tsx       3
lib/options.ts                    2     components/tx.tsx             1
lib/abi.ts                        1
```

- **Components** switch from `import { deployed } from "@/lib/config"` to
  `const { config } = useNetwork()`.
- **Hooks and libs** (`useMarket.ts`, `aqua.ts`) take `NetworkConfig` as an argument. They must not
  reach for a global, or they become untestable and silently single-network again.
- `components/tx.tsx` uses `deployed.weth` only to decide a token symbol in a revert message, and
  hardcodes chain 31337 in the out-of-gas hint. Both become network-aware.

This is mechanical but wide. It is the bulk of the frontend work.

## B. UI

- **Toggle** — segmented control in `Nav.tsx` beside the wallet button, reusing `SegmentedRoot`:
  `[ Demo ] [ Base ]`. Switching calls `switchChain` when connected, otherwise just sets the
  preference.
- **Wrong-network banner** — already exists; retarget from "the Base fork" to whichever network is
  selected.
- **Faucet button** — "Get test funds", rendered only when `network.faucetUrl` is set. Shows the
  resulting balances on success and the gateway's error message on failure.
- **Explorer links** — transaction hashes in `TxNote` link to basescan on mainnet, and stay plain
  text on the fork, which has no explorer.
- **Demo banner** — a persistent, quiet line on the fork explaining that it is a forked chain with
  a frozen price and that state resets daily.

## C. AWS box

```
EC2 t3.small (or Lightsail equivalent), Ubuntu 24.04, elastic IP
│
├─ anvil.service      127.0.0.1:8545
│    --fork-url $BASE_RPC_URL --fork-block-number 51698307 --chain-id 31337
│
├─ gateway.service    127.0.0.1:8546   node + viem, single file
│    POST /         JSON-RPC proxy, method allowlist
│    POST /faucet   threshold top-up
│    GET  /health   block number + deployed manager address
│
├─ caddy             :443   TLS via Let's Encrypt
│    fork.<domain>/         → gateway /
│    fork.<domain>/faucet   → gateway /faucet
│
└─ reset.timer       daily, plus manual trigger
```

Security boundary: **anvil binds to loopback only.** Admin RPC methods are not reachable from the
internet at all, rather than being reachable-but-guarded. This is the main reason the faucet lives
on the box instead of in a Vercel route.

### C1. Gateway — RPC proxy

- Accept `POST /` with a JSON-RPC object **or array** (viem batches; a scalar-only implementation
  will break reads).
- Allowlist by method prefix: `eth_`, `net_`, `web3_`.
- Explicitly reject `anvil_`, `evm_`, `debug_`, `trace_`, `hardhat_`, `ots_` with JSON-RPC error
  `-32601`.
- Reject a batch entirely if any entry is disallowed — no partial application.
- Cap body size and batch length.
- Permissive CORS (`*`), since the caller is a browser on the Vercel origin.

### C2. Gateway — faucet

`POST /faucet { address }`:

1. Reject anything that is not a 20-byte hex address.
2. `eth_getCode(address) !== "0x"` → reject with a readable error. `demo/fund.sh` already warns
   about this: an address carrying an EIP-7702 delegation behaves like a contract and fails the
   ERC-1155 receiver check when a position is minted. Better to refuse than to fund a wallet that
   will fail on its first trade.
3. Read ETH / WETH / USDC balances. Top up **only below a floor**:

   | token | floor | top up to |
   |---|---|---|
   | ETH | 1 | 10 |
   | WETH | 10 | 100 |
   | USDC | 50,000 | 500,000 |

4. Top-up mechanism mirrors `demo/fund.sh`: `anvil_setBalance` for ETH, then impersonate the Morpho
   whale `0xBBBB…FFCb` and transfer the ERC-20s.
5. Return the new balances.

Threshold top-up is deliberately chosen over a fixed grant: it is **self-limiting**. Looping the
endpoint returns the same balances and moves no state, so rate limiting stops being the thing that
protects the chain. A 30-second per-address cooldown stays purely to stop hammering.

### C3. Reset

Daily systemd timer: stop anvil → start anvil → `demo/setup.sh` → **verify**.

The verification step is not optional. After redeploy, assert that `optionsHook` and
`optionsManager` in the freshly written deployment JSON equal the values the frontend was built
with. Both are deterministic today — the hook is CREATE2 (mined against `CREATE2_DEPLOYER`, so it
depends on bytecode, not nonce) and the manager is nonce-based from a fixed key on a chain that
resets to the same block. If that ever drifts, the site silently points at addresses with no code,
and the failure looks like "the app is broken" rather than "the reset changed the addresses". The
timer must fail loudly instead.

Also expose a manual trigger (`systemctl start recycled-reset.service`) for use during a live demo.

## D. Vercel

| var | value | exposed to browser |
|---|---|---|
| `NEXT_PUBLIC_FORK_RPC_URL` | `https://fork.<domain>` | yes |
| `NEXT_PUBLIC_FORK_FAUCET_URL` | `https://fork.<domain>/faucet` | yes |
| `NEXT_PUBLIC_MAINNET_RPC_URL` | Infura Base endpoint | **yes** |
| `ONEINCH_API_KEY` | 1inch key | no — server only |

The existing `/api/oneinch` and `/api/hyperliquid` routes are unchanged and keep the 1inch key
server-side.

## E. Security items to action

These are pre-existing and become material the moment anything is public.

1. **`.env.example` currently contains a live Infura key** and is tracked in git in a public repo.
   Not yet committed. Move it to `.env` (gitignored) and restore a placeholder. If it does get
   committed, rotate the key — deleting the line does not remove it from history.
2. **`NEXT_PUBLIC_MAINNET_RPC_URL` ships the Infura key to the browser.** That is inherent to a
   client-side RPC and is an accepted trade-off. Mitigate in the Infura dashboard with an
   allowed-origins rule restricted to the Vercel domain.
3. **`demo/setup.sh` hardcodes `DEPLOYER_PK`.** That key is derived from a published string and is
   committed to a public repo — it is effectively public. It must **never** be used for the mainnet
   deploy. The mainnet deploy uses a separate funded key supplied at run time and never written to
   the repo.

## F. Mainnet deploy prerequisites

Owned by the user, outside this implementation:

- A funded deployer key on Base (not the one in `setup.sh`).
- `Deploy.s.sol` run against Base 8453. `HookMiner` already mines a flag-valid hook address against
  `CREATE2_DEPLOYER`, so no script change is needed beyond the chain-id-keyed output path.
- Real liquidity written into the pool, or the chain renders as an empty book.
- Contract verification on basescan.
- Acknowledgement that these contracts are unaudited and will hold real user funds.

## G. Testing

- **Gateway**: unit tests for the allowlist (single + batch + disallowed-in-batch), address
  validation, contract-address rejection, and threshold logic (at floor, below floor, above floor).
- **Frontend**: `configFor` returns distinct pool ids for the two deployments; `networkForChainId`
  round-trips; the unconnected-visitor path resolves to the persisted preference.
- **Manual**: on the deployed site — toggle both ways unconnected; connect on the wrong chain and
  confirm the banner; faucet a fresh EOA and complete a write → buy → close; confirm a 7702 wallet
  is refused with a readable message; confirm `anvil_setBalance` from the public RPC is rejected.

## Open items

- The fork hostname. User has a domain; the exact subdomain is still needed. The spec uses
  `fork.<domain>` and it should appear in exactly one place in the implementation.
- Whether the mainnet deployment exists before or after this frontend work lands. If after, ship
  with `mainnet` present but flagged unavailable until `deployments/8453.json` is real.

## Decisions taken

| question | decision |
|---|---|
| What is "mainnet"? | Real contracts on Base 8453; user runs the deploy |
| Faucet placement | Gateway service on the AWS box; anvil stays on loopback |
| App hosting | Vercel; fork node on AWS |
| Reset cadence | Daily, manually triggerable |
| Mainnet RPC | Infura, public in the client, origin-locked |
| Fork pinning | Stays pinned at 51698307; price divergence from mainnet is accepted |
