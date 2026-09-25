// Hand-written minimal ABIs. Only what the UI actually calls — keeps the frontend free of a
// contract-artifact build step.

export const optionsManagerAbi = [
  // --- views ---
  {
    type: "function",
    name: "tokenIdFor",
    stateMutability: "view",
    inputs: [
      { name: "strikeIndex", type: "uint8" },
      { name: "isPut", type: "bool" },
      { name: "isLong", type: "bool" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "seriesTicks",
    stateMutability: "view",
    inputs: [
      { name: "strikeIndex", type: "uint8" },
      { name: "isPut", type: "bool" },
    ],
    outputs: [
      { name: "tickLower", type: "int24" },
      { name: "tickUpper", type: "int24" },
    ],
  },
  {
    type: "function",
    name: "getStrikes",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "int24[]" }],
  },
  {
    type: "function",
    name: "accruedPremium",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [
      { name: "premium0", type: "uint256" },
      { name: "premium1", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "getPosition",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "tokenId", type: "uint256" },
    ],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "liquidity", type: "uint128" },
          { name: "feeGrowth0SnapshotX128", type: "uint256" },
          { name: "feeGrowth1SnapshotX128", type: "uint256" },
          { name: "amount0", type: "uint256" },
          { name: "amount1", type: "uint256" },
          { name: "collateral0", type: "uint256" },
          { name: "collateral1", type: "uint256" },
          { name: "premium0Settled", type: "uint256" },
          { name: "premium1Settled", type: "uint256" },
        ],
      },
    ],
  },
  {
    type: "function",
    name: "series",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [
      { name: "shortLiquidity", type: "uint128" },
      { name: "longLiquidity", type: "uint128" },
    ],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "id", type: "uint256" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "encodeAquaStrategy",
    stateMutability: "view",
    inputs: [
      { name: "maker", type: "address" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [{ type: "bytes" }],
  },
  {
    type: "function",
    name: "aquaStrategyHash",
    stateMutability: "view",
    inputs: [
      { name: "maker", type: "address" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "aquaBackingOf",
    stateMutability: "view",
    inputs: [
      { name: "maker", type: "address" },
      { name: "salt", type: "bytes32" },
      { name: "token", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "BUYER_COLLATERAL_BPS",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "utilisationBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint16" }],
  },
  // --- writes ---
  {
    type: "function",
    name: "sellStrategy",
    stateMutability: "nonpayable",
    inputs: [
      { name: "maker", type: "address" },
      {
        name: "legs",
        type: "tuple[]",
        components: [
          { name: "strikeIndex", type: "uint8" },
          { name: "isPut", type: "bool" },
          { name: "liquidity", type: "uint128" },
        ],
      },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "sellOption",
    stateMutability: "nonpayable",
    inputs: [
      { name: "strikeIndex", type: "uint8" },
      { name: "isPut", type: "bool" },
      { name: "liquidity", type: "uint128" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "sellOptionViaAqua",
    stateMutability: "nonpayable",
    inputs: [
      { name: "maker", type: "address" },
      { name: "strikeIndex", type: "uint8" },
      { name: "isPut", type: "bool" },
      { name: "liquidity", type: "uint128" },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "collateralFor",
    stateMutability: "view",
    inputs: [
      { name: "strikeIndex", type: "uint8" },
      { name: "isPut", type: "bool" },
      { name: "liquidity", type: "uint128" },
    ],
    outputs: [
      { name: "amount0", type: "uint256" },
      { name: "amount1", type: "uint256" },
    ],
  },
  {
    type: "function",
    name: "buyStrategy",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "legs",
        type: "tuple[]",
        components: [
          { name: "strikeIndex", type: "uint8" },
          { name: "isPut", type: "bool" },
          { name: "liquidity", type: "uint128" },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "buyOption",
    stateMutability: "nonpayable",
    inputs: [
      { name: "strikeIndex", type: "uint8" },
      { name: "isPut", type: "bool" },
      { name: "liquidity", type: "uint128" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "closeShort",
    stateMutability: "nonpayable",
    inputs: [
      { name: "strikeIndex", type: "uint8" },
      { name: "isPut", type: "bool" },
      { name: "liquidity", type: "uint128" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "closeLong",
    stateMutability: "nonpayable",
    inputs: [
      { name: "strikeIndex", type: "uint8" },
      { name: "isPut", type: "bool" },
      { name: "liquidity", type: "uint128" },
    ],
    outputs: [],
  },
  // Errors, so a revert reads as a sentence instead of a selector. viem can only decode what the
  // ABI declares — without these, `InsufficientAquaBacking` reaches the user as bare hex, which is
  // barely an improvement on the panic it replaced.
  { type: "error", name: "ZeroLiquidity", inputs: [] },
  { type: "error", name: "EmptyStrategy", inputs: [] },
  { type: "error", name: "NoPosition", inputs: [] },
  { type: "error", name: "LongStillSolvent", inputs: [] },
  { type: "error", name: "NativeCurrencyUnsupported", inputs: [] },
  { type: "error", name: "NotPoolManager", inputs: [] },
  { type: "error", name: "BadStrikeIndex", inputs: [{ name: "index", type: "uint8" }] },
  { type: "error", name: "BadStrikeLadder", inputs: [{ name: "length", type: "uint256" }] },
  {
    type: "error",
    name: "InsufficientWrittenLiquidity",
    inputs: [
      { name: "available", type: "uint128" },
      { name: "requested", type: "uint128" },
    ],
  },
  {
    type: "error",
    name: "PositionTooLarge",
    inputs: [
      { name: "held", type: "uint128" },
      { name: "requested", type: "uint128" },
    ],
  },
  {
    type: "error",
    name: "InsufficientAquaBacking",
    inputs: [
      { name: "token", type: "address" },
      { name: "required", type: "uint256" },
      { name: "available", type: "uint256" },
    ],
  },
] as const;

export const aquaAbi = [
  {
    type: "function",
    name: "ship",
    stateMutability: "nonpayable",
    inputs: [
      { name: "app", type: "address" },
      { name: "strategy", type: "bytes" },
      { name: "tokens", type: "address[]" },
      { name: "amounts", type: "uint256[]" },
    ],
    outputs: [{ type: "bytes32" }],
  },
  {
    type: "function",
    name: "dock",
    stateMutability: "nonpayable",
    inputs: [
      { name: "app", type: "address" },
      { name: "strategyHash", type: "bytes32" },
      { name: "tokens", type: "address[]" },
    ],
    outputs: [],
  },
  {
    // `tokensCount` is the only way to tell a salt that was never shipped (0) from one that was
    // shipped and is now spent or docked (non-zero). A used salt can never be shipped again.
    type: "function",
    name: "rawBalances",
    stateMutability: "view",
    inputs: [
      { name: "maker", type: "address" },
      { name: "app", type: "address" },
      { name: "strategyHash", type: "bytes32" },
      { name: "token", type: "address" },
    ],
    outputs: [
      { name: "balance", type: "uint248" },
      { name: "tokensCount", type: "uint8" },
    ],
  },
  {
    type: "error",
    name: "StrategiesMustBeImmutable",
    inputs: [
      { name: "app", type: "address" },
      { name: "strategyHash", type: "bytes32" },
    ],
  },
] as const;

export const erc20Abi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

/** Uniswap v4 StateView — read-only lens over PoolManager storage. */
export const stateViewAbi = [
  {
    type: "function",
    name: "getSlot0",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" },
    ],
  },
] as const;

/**
 * OptionsHook — the pricing surface.
 *
 * Both inputs to the LP fee are readable, which is the point: a judge (or a writer) can see that
 * premium is a function of measured volatility and measured utilisation, and not of anything
 * quoted off-chain.
 */
export const optionsHookAbi = [
  {
    type: "function",
    name: "realisedVolBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  { type: "function", name: "utilisationBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint16" }] },
  { type: "function", name: "volFee", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
  { type: "function", name: "currentFee", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
  { type: "function", name: "BASE_FEE", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
  { type: "function", name: "VOL_FEE_MAX", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
  { type: "function", name: "MAX_FEE", stateMutability: "view", inputs: [], outputs: [{ type: "uint24" }] },
] as const;
