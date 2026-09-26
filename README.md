<img src="frontend/public/mamori-lockup.webp" alt="Mamori" width="620">

# Mamori

**A perpetual options market built on liquidity that already exists.**

*Mamori* (守り) is Japanese for protection — which is what an options book is for, and what the
torii in the mark stands over.

Options are minted as Uniswap v4 concentrated liquidity positions. Seller collateral is an unlocked
1inch Aqua balance that never leaves the seller's wallet until the option is actually written.
Nothing has to be bootstrapped to launch the market.

Built for ETHTokyo. Runs against **real, deployed Base mainnet contracts** — the Uniswap v4
PoolManager and the 1inch Aqua registry — on a local fork. No mocked sponsor infrastructure.

---

## The core insight

A concentrated liquidity position already has the payoff shape of a short option.

An LP providing USDC in a narrow range just below spot on an ETH/USDC pool behaves exactly like
someone who sold a put at that price:

| Concentrated LP | Short put |
|---|---|
| Holds USDC while price stays above the range | Holds premium, unassigned |
| Earns swap fees | Collects premium |
| Converts to ETH if price falls through the range | Gets assigned the underlying at the strike |

Mirror the range above spot and you have a short call.

So:

- **Selling an option = minting concentrated liquidity at that strike.**
- **Buying an option = removing that liquidity from the pool**, which hands the buyer the inverted
  payoff.

No separate options order book and no separate options liquidity. The AMM's own liquidity and
pricing are reused. Assignment needs no settlement code at all — it falls straight out of Uniswap's
range mechanics: when you withdraw a position whose price has crossed, you simply receive the other
asset.

This is not a novel discovery on its own — Panoptic runs a version of it live. The new part is
combining it with Aqua's registry model, so the *seller's capital* is recycled too.

### Premium is real, not modelled

Premium is not quoted, oracle-derived, or fitted to an IV surface. It is the pool's own
`feeGrowthInside` over the option's tick range — actual fees paid by actual swappers:

```
premium(position) = (feeGrowthInside_now − feeGrowthInside_at_open) × liquidity / 2¹²⁸
```

A short **earns** that. A long **owes** it — rent for having pulled that liquidity out of the pool.
The two net out exactly, because fees accrue on `shortLiquidity − longLiquidity` while shorts are
paid on `shortLiquidity` and longs pay on `longLiquidity`:

```
shortsOwed = feesActuallyCollected + longsOwe
```

That identity is asserted in `test_premiumConservation`, and you can watch it in the seeded demo:
the seller earns `+0.001702 WETH / +4.5945 USDC` while the buyer, holding exactly half the size,
owes exactly half of each.

---

## The three claims, and where to see each one

**1. Reusing liquidity instead of bootstrapping it.**
Options *are* Uniswap LP positions (`test_sellOption_isLiterallyAnLpMint`), and seller collateral
*is* an unlocked Aqua-registered wallet balance (`test_fork_shipThenWriteAgainstRealAqua`). Nothing
needs to be seeded to launch a market.

**2. Small traders can trade with less liquidity.**
A buyer posts ~10% collateral against notional, because the mechanism is "invert an existing LP
position", not "source new capital per trade"
(`test_buyOption_removesLiquidityAndCostsTenPercent`).

**3. Traders get a way to hedge.**
The Strategies tab reads a live Hyperliquid perp and builds cover against it on this market — a
floor under a long, squeeze cover over a short — with the combined payoff drawn before anything is
signed.

---

## Where each sponsor's tech is used

### Uniswap v4 — the pool *is* the market, and the hook *is* the pricing

**Are you actually using v4 pools?** Every option is a `poolManager.modifyLiquidity()` call on the
real Base PoolManager `0x498581fF…`. Not a wrapper, not a fork of the maths.

| Piece | Where |
|---|---|
| `modifyLiquidity` mints/burns every option | [`src/OptionsManager.sol`](src/OptionsManager.sol) `_modify` |
| `unlock` / `unlockCallback` flash accounting | `unlockCallback`, `_netOut` |
| `StateLibrary.getFeeGrowthInside` is the premium | `accruedPremium` |
| Dynamic LP fee set per swap | [`src/OptionsHook.sol`](src/OptionsHook.sol) `beforeSwap` |

Verify it against mainnet state: `forge test --match-contract AquaFork` asserts
`getPositionInfo()` on the real PoolManager returns the exact liquidity we minted.

**What does the hook actually do?** Two things, and the second is the substantive one.

1. **`beforeAddLiquidity` / `beforeRemoveLiquidity` — liquidity is options-only.** Only
   OptionsManager may be an LP, so "every unit of liquidity here is a written option" is an
   enforced invariant rather than a convention. That is what makes `feeGrowthInside` over a range
   attributable entirely to writers.

2. **`beforeSwap` — the hook is where the option is priced.** Premium in this protocol *is* the LP
   fee: a short earns `feeGrowthInside`, a long pays it. With a static fee tier, premium would be a
   pure function of volume and say nothing about what the option is worth — a writer would earn the
   same whether the market was dead calm or tearing through their strike, and the same whether their
   book was untouched or fully lent out. So the hook prices it, with the decomposition an options
   desk actually uses: **fair value from volatility, then a spread from inventory.**

   ```
   fee = volFee                            + (MAX_FEE − volFee) × bought / written
       = 0.30% … 0.60% from volatility       widened to at most 1.00% by utilisation
   ```

   **Volatility** is realised, estimated from the pool's own tick path. `_observe` folds one sample
   into an EWMA on every swap, in a single packed slot. No logarithm is needed anywhere: a tick *is*
   log-price, so a tick delta is already a log return worth `ln(1.0001) ≈ 1e-4`, and annualising is
   one constant, `sqrt(365·24·3600) = 5616`. One `extsload` and one `SSTORE` per swap is the whole
   cost of not needing an oracle. Sampling happens *before* the swap executes, so a swap can never
   quote itself a fee from its own impact.

   **Utilisation** is pushed by OptionsManager on every open-interest change, so the swap path stays
   a single storage read. The spread applies to the remaining headroom rather than stacking, which
   keeps the ceiling hard and stops the two components double-counting. At zero measured volatility
   the formula collapses *exactly* to the old utilisation-only curve — which is why every
   pre-existing utilisation test passed unchanged when volatility was added.

   The pool is declared `DYNAMIC_FEE_FLAG`; `beforeSwap` returns the fee with
   `LPFeeLibrary.OVERRIDE_FEE_FLAG`.

   Measured, not asserted — the tests print these:

   | | realised vol | LP fee |
   |---|---|---|
   | Same round trip every 10 min | 4.6% | 0.31% |
   | Same round trip every 5 s | 371% | 0.60% |
   | …then fully lent out | — | 1.00% |

   `test_vol_volatileMarketPaysWritersMore` is the one that matters: identical liquidity, identical
   flow, and the volatile regime pays the writer **1.95×** the premium. `test_hook_feeRisesWithUtilisation`
   still shows 0% bought → 3000 · 50% → 6500 · 100% → 10000, unwinding symmetrically.

   *Simplifications:* volatility and utilisation are both market-wide rather than per-strike, so
   there is no smile and an untouched range pays the same spread as a fully-lent one; per-range needs
   a tick-bucket lookup in `beforeSwap`. Volatility is realised, not implied, and the two inputs
   compose linearly. The estimator is manipulable in principle — bounded by the EWMA's 1/8 weight
   per observation, a 400% cap per sample, and the fact that a manipulator pays the higher fee they
   just created, to the writers.

### Hyperliquid — positions in, structures out

Read-only, and deliberately so. We do not trade on Hyperliquid, hold keys, or sign anything there.
Hyperliquid is a **position source**: the Strategies tab reads a wallet's live perps from the public
`clearinghouseState` info endpoint, then offers structures on *this* options market that act on that
exposure — the way a broker's strategy builder sits on top of a stock position you already hold.

| Piece | Where |
|---|---|
| Read-only proxy, two endpoints allow-listed | [`app/api/hyperliquid/route.ts`](frontend/app/api/hyperliquid/route.ts) |
| Position parsing + strategy templates | [`lib/hyperliquid.ts`](frontend/lib/hyperliquid.ts) |
| Builder, payoff curve, execution | [`components/strategy-builder.tsx`](frontend/components/strategy-builder.tsx) |
| Payoff curve (hand-drawn SVG, no chart library) | [`components/payoff-chart.tsx`](frontend/components/payoff-chart.tsx) |

Preset structures come from the perp's side; legs are placed relative to the live ladder. You can
also build your own leg by leg. Written legs execute as **one `sellStrategy` call funded from a
single Aqua offer** — which is where the three sponsors meet in one transaction: a Hyperliquid
position motivates it, Aqua funds it, Uniswap v4 holds it.

Bought legs batch too, as **one `buyStrategy` call**. They post collateral directly rather than
registering Aqua backing, so the reason is different: a spread that fills its long leg and then
fails on the short one leaves the trader holding naked exposure they never asked for. Batching makes
a half-built structure unreachable — any leg that cannot fill reverts the whole thing.

**What the builder shows, and why it is not a delta number.** Every position here is delta-neutral
at inception against the capital posted: a long removed range amounts `(a0, a1)` and must restore
`(b0, b1)`, and at open `b == a`. Exposure appears only as the range recomposes. So the builder
shows a **payoff curve and table across the strike ladder** — perp P&L, options P&L, combined —
which is both correct and what a hedger actually needs. Against a perp the curve spans spot ±25%, so
a floor can be seen holding through a real crash; standing alone it spans the ladder. Either way it
is sampled densely enough that the kink at each strike is visible, and the table prices the ladder
itself so the numbers can be read exactly. Premium is excluded from both, because it depends on
realised swap volume between now and close.

Above the chart, a hedge gets three answers: whether the combined loss is capped at all (read from
the slope of the far tails, which is also how many ETH are left uncovered), what a 25% move against
the perp does with and without the cover, and what the bought legs cost to hold — nothing while
spot is outside their ranges, and roughly one pool fee on their notional each time price trades
through one.

**You can only buy what someone wrote.** A long here is not minted — it is written liquidity
removed from the pool and handed over — so a strike with no short behind it cannot be bought at any
price, and `buyStrategy` reverts the whole structure with
`InsufficientWrittenLiquidity(available, requested)`. That is the mechanism being honest rather than
a limitation to hide: there is no synthetic counterparty here, which is precisely why the premium is
real. The builder reads each bought leg's remaining depth from the same series data the chain page
shows, caps the leg with a one-click resize, and blocks execution rather than letting a doomed
structure reach the wallet. `demo/setup.sh` seeds the entire ladder — every strike, both sides —
from one Aqua offer in one `sellStrategy` call, so the presets have something to trade against.

**An honest labelling.** A covered call is *not* a hedge against a perp. Writing a call here means
posting WETH, and a perp is not deliverable WETH inventory — you would have to buy spot to write it,
which adds delta rather than removing it. Those structures are still offered, because people want
them, but they are tagged `yield` and state the inventory they need. The genuine perp hedges are the
bought legs: puts under a long, calls over a short, with a further-out written leg to cheapen them.

### 1inch — why you need it even though Uniswap is already here

Aqua is **not** a swap venue, so it does not overlap with Uniswap at all. Uniswap is where the
option lives; Aqua is where the collateral lives.

**The reason it matters is multi-leg.** An Aqua strategy here is scoped to the **market**, not to a
series:

```solidity
struct AquaStrategy { address maker; address app; bytes32 salt; }
```

That one decision is the whole argument. If the hash included strike and side, one shipped balance
would back exactly one series, and a four-leg structure would need four offers and four times the
committed capital — a vault with extra steps. Market-scoped, a single untouched wallet balance
backs every leg, and Aqua caps total draw at the registered amount, so the seller's worst case is
one number no matter how many legs they run.

`sellStrategy(maker, legs[], salt)` writes a whole structure atomically from that one offer:

| Strategy | Legs | Collateral |
|---|---|---|
| Put spread | short $2,650 put + short $2,600 put | one USDC balance |
| Strangle | short put below spot + short call above | one offer registering USDC **and** WETH |
| Condor | four legs | still one offer |

Proven in `test_aqua_oneBalanceBacksAMultiLegSpread`, `test_aqua_oneOfferBacksATwoCurrencyStrangle`
and `test_aqua_strategyCannotOverdrawTheOffer` (a structure that would overdraw reverts whole — a
half-built spread is not a reachable state).

**An offer is a quote, not a balance.** Aqua strategies are immutable: a shipped
`(maker, app, strategyHash)` can never be shipped again — `dock` zeroes the balance but does not
free the hash, and re-shipping reverts with `StrategiesMustBeImmutable`. So there is no such thing
as topping an offer up. That shapes the UI more than anything else in this integration:

- Salts are an indexed series, not a constant. `lib/aqua.ts` scans them and picks the offer that
  covers the trade; more backing means shipping the **next** offer.
- `rawBalances` returns `(balance, tokensCount)`, and `tokensCount` is the only way to tell a salt
  that was never shipped `(0, 0)` from one that is spent or docked `(0, 255)`.
- `collateralFor(strikeIndex, isPut, liquidity)` quotes what a write will pull, mirroring
  `Pool.modifyLiquidity` exactly rather than estimating in JavaScript. An offer one wei short is an
  offer that has to be abandoned, so the quote has to be exact —
  `test_fork_collateralQuoteMatchesWhatTheWriteActuallyPulls` pins it against the real PoolManager.
- Aqua enforces its cap with plain arithmetic, so an over-draw came back as a bare `panic(0x11)`,
  which a wallet renders as "reverted with the following reason:" and nothing else. The manager now
  checks the registered balance first and reverts with
  `InsufficientAquaBacking(token, required, available)`.

---

## What's built vs. what's roadmap

There is a larger design document behind this project. Almost none of it is built, on purpose. This
is the one mechanism that is actually novel and actually demoable.

| Full design | This build |
|---|---|
| Multi-asset, permissionless markets | One market: WETH/USDC on Base |
| Full strike/expiry surface | Three fixed strikes (−5% / spot / +5%), puts and calls |
| Streamia accumulator, utilisation spread, IV-aware pricing floor | Premium = real `feeGrowthInside`. No oracle, no model. |
| ERC-1155 encoding pool/strike/direction/width | **Built** — [`src/libraries/PositionId.sol`](src/libraries/PositionId.sol) |
| Aave yield-stacked ERC-4626 collateral vaults | **Not built.** Collateral is Aqua-registered, not deposited anywhere. |
| Aqua as part of the collateral stack | **Aqua _is_ the collateral mechanism** |
| Buyer leverage via protocol-borrowed liquidity | **Built** — buyer posts ~10%, protocol pulls the matching LP out of the pool |
| Flash-loan liquidation bots, insurance fund, ADL, portfolio margin | **Not built.** `liquidateLong` is a manual button past one crude threshold. |
| Hyperliquid hedge **vault** (protocol trades perps) | **Not built.** What *is* built is read-only: positions are imported and acted on here. See below. |
| Median-TWAP solvency, OI caps, geofencing, audits | **Not built.** Fork only. |

### Known simplifications, stated plainly

These are marked in the code where they occur, not buried here:

- **A long's loss is not strictly capped at its collateral.** Premium accrues in both currencies,
  but a single-sided option posts collateral in only one, so closing settles any deficit from the
  wallet. Production would value collateral across both legs and margin-call first.
- **`liquidateLong` is a stand-in**, not liquidation infrastructure. No bonus, no partial
  liquidation, no bad-debt socialisation.
- **Position accounting is keyed by `(owner, tokenId)`.** The ERC-1155 is a receipt; transferring it
  does not move the underlying accounting.
- **An Aqua strategy encodes no minimum premium**, so a matcher picks the moment of execution.
  Production would sign a price band into the strategy bytes.

### Not a perps replacement

This is explicitly **not** pitched as better than perps. Perps will keep dominating retail crypto
trading for structural reasons: one instrument, one deep venue, no strike/expiry complexity to
learn.

It is pitched as a **capital-efficient hedging and volatility-selling instrument for people who
already trade**, enabled by two pieces of infrastructure that did not exist when Hegic, Opyn,
Dopex, Premia, Lyra and Ribbon each failed to reach scale: Uniswap v4 hooks, and Aqua's registry
model.

---

## Running it

Requires Foundry and Node 18+.

```bash
forge install && forge test
```

Four terminals for the demo:

```bash
./demo/anvil.sh
```

```bash
./demo/setup.sh
```

```bash
cd frontend && npm install && npm run dev
```

```bash
./demo/churn.sh --loop
```

`setup.sh` funds demo accounts from a whale on the fork, deploys the hook and manager, initialises
the pool, and seeds a live position set: the whole ladder written from one Aqua offer, and long
interest across every strike. Then open <http://127.0.0.1:3000>.

`churn.sh` is what keeps it alive, and it is worth running during a demo. A fork is frozen at the
block it was made from, so its ETH price never moves and — more to the point — nothing swaps.
Premium here IS the pool's swap fee, accruing only while spot sits inside a written range, so an
untouched book pays its writers nothing no matter how much is written. Each round reads the real
ETH mid from Hyperliquid, walks the pool toward it a few ticks at a time, and round-trips a small
size so the in-range writers are paid even on a flat tape. It trades from three throwaway accounts
so the tape is not one address talking to itself.

The walk is deliberately capped per round. The hook reads realised volatility from the gap between
ticks and the time between observations, so closing a large gap in one swap prints a vertical move
and pegs the volatility fee at its ceiling — a true reading of a fake price path.

It rewrites `deployments/base-fork.json`, which the frontend imports for addresses. A copy is
committed so the frontend builds before you have run anything; the addresses in it are only valid
for a fork deployed from the same commit.

### Connecting a wallet

Add a network in MetaMask: RPC `http://127.0.0.1:8545`, **chain id `31337`**, currency ETH.

The chain id is deliberately not 8453. The fork contains all of Base's state, so every real mainnet
address still resolves — but a wallet that recognises the chain id treats it as public mainnet.
MetaMask then applies its own Base gas heuristics instead of calling `eth_estimateGas` on the node,
and sends a gas limit around 45,000 for a call that needs ~430,000. The transaction is accepted,
reverts out-of-gas, and (before this was fixed) showed nothing in the UI. Using 31337 also lets
wagmi detect a wrong-network wallet at all, which it cannot do when the fork and real Base share an
id.

To trade from your own wallet, fund it on the fork:

```bash
./demo/fund.sh 0xYourAddress
```

That gives 10 ETH, 500,000 USDC and 100 WETH. Use a plain EOA — an address with an EIP-7702
delegation has code on the fork and fails the ERC-1155 receiver check when a position is minted.

Or import a demo key instead:

| Role | Address | Key |
|---|---|---|
| Seller | `0x260529A5889B22dB02E0e8c1F90A7415084dF54E` | `0xaab17b89d7376948ee5710c0a73b05f449c86946b1bc6da38c89e0803997992f` |
| Buyer | `0x3F8bC758CBCc3bB199FC7799f96D24aeEf242999` | `0x14ab088b7dcb56ff0099d87d5eb505efa89faad5d92be065a89817cf983b8152` |

Or inspect either without connecting: `?as=0x2605…` on the Positions page.

### Tests

```bash
forge test
```

54 tests. `test/OptionsManager.t.sol` covers the mechanism against a local PoolManager;
`test/AquaFork.t.sol` runs against the **real deployed** Base contracts. Offline:
`forge test --no-match-contract AquaFork`.

The pricing tests print their measurements rather than only asserting on them, which is the honest
way to read them:

```bash
forge test --match-test "test_vol_" -vv
```

---

## Demo script

1. **Show the pool is empty of ordinary LPs.** Every unit of liquidity is an option — the hook
   rejects anyone but `OptionsManager`.
2. **Ship an Aqua offer.** Watch the wallet balance *not change*. 200,000 USDC is now committed and
   still completely liquid. This is the part no options protocol could do before.
3. **Write the option.** Only now does collateral move, and only the ~1,527 USDC the v4 mint
   actually needs. Show the position in the PoolManager: it is ordinary Uniswap liquidity.
4. **Buy half of it.** Liquidity leaves the pool; the buyer posts ~10% of notional.
5. **Swap against the pool.** Premium accrues on the Positions page, read live from
   `feeGrowthInside`. Point out the seller earns exactly double what the half-size buyer owes.
6. **Hedge a perp.** On Strategies → *Hedge a perp*, paste a Hyperliquid address (or *Try an
   example*) and pick *Floor*. The chart shows the perp's loss going flat below the strike, and the
   whole structure opens in one click.

---

## Notes from the build

Three things that cost real time and are worth knowing if you build on this stack:

- **Aqua has no testnet.** It is deployed on 17 mainnets, all at
  `0x1111113CCf1426A8E30e2bfF5E005d929bF6a90a`, and nowhere else. Forking a mainnet is the only way
  to integrate against the real contract — which is better than a testnet mock anyway.
- **`BaseHook` no longer exists in v4-periphery** (removed in `5da22e60`, "remove hooks and move to
  hook repo"). `OptionsHook` implements `IHooks` directly against v4-core instead.
- **Anvil's default accounts all carry EIP-7702 delegations on Base mainnet.** Their keys are
  public, so someone has delegated every one of them. On a fork they therefore have code, behave
  like contracts, and fail ERC-1155/721 receiver checks. The demo uses freshly derived accounts.
- **Do not give a fork the real chain's id.** It is tempting, because addresses then look "right",
  but MetaMask recognises a mainnet id and stops asking the node for gas estimates. Every write
  reverts out-of-gas while reads keep working perfectly, which is a genuinely confusing failure —
  and wagmi cannot warn about a wrong network, because the ids match.

## Layout

```
src/
  OptionsManager.sol        core mechanism: write, buy, close, premium, Aqua funding
  OptionsHook.sol           v4 hook enforcing option-only liquidity
  libraries/PositionId.sol  ERC-1155 id encoding
  interfaces/IAqua.sol      the deployed Aqua surface we use
test/
  OptionsManager.t.sol      mechanism + Aqua path against a local PoolManager
  AquaFork.t.sol            against real Base mainnet contracts
script/                     deploy + seed
demo/                       anvil fork, one-shot setup, and the churn loop
frontend/                   Next.js: Chain, Strategies, Positions, Faucet
```
