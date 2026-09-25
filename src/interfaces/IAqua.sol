// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title IAqua
/// @notice The subset of 1inch Aqua that this protocol uses.
///
/// @dev Aqua is a self-custodial shared-liquidity registry, not a pool. A maker "ships" a strategy
///      that registers an amount of their own wallet balance as backing for a given app. The tokens
///      never move: they stay in the maker's wallet, fully liquid, and the same balance can back
///      several strategies at once. Only when the app actually executes does Aqua `pull` the tokens
///      straight out of the maker's wallet (a `transferFrom`, so the maker approves Aqua once).
///
///      Signatures match the deployed contract, which lives at the same address on every supported
///      chain: 0x1111113ccf1426a8e30e2bff5e005d929bf6a90a
///      Source: https://github.com/1inch/aqua (src/interfaces/IAqua.sol)
///
///      Only the functions Recycled needs are declared here, to keep the surface small and to avoid
///      vendoring source under Aqua's source-available licence.
interface IAqua {
    /// @notice Register wallet balance as backing for `app` under a caller-defined strategy.
    /// @dev `msg.sender` is the maker. `strategyHash` is `keccak256(strategy)`. A given
    ///      (maker, app, strategyHash) can only be shipped once — strategies are immutable.
    /// @param app The application contract permitted to pull against this balance.
    /// @param strategy Opaque, app-defined strategy bytes (stored in the event for data availability).
    /// @param tokens Tokens being registered.
    /// @param amounts Amount of each token registered.
    /// @return strategyHash keccak256 of `strategy`.
    function ship(address app, bytes calldata strategy, address[] calldata tokens, uint256[] calldata amounts)
        external
        returns (bytes32 strategyHash);

    /// @notice Cancel a strategy, zeroing its registered balances. Must list every token in it.
    function dock(address app, bytes32 strategyHash, address[] calldata tokens) external;

    /// @notice Pull registered tokens out of a maker's wallet. Callable only by the app itself
    ///         (`msg.sender` is the app), and only up to the registered balance.
    function pull(address maker, bytes32 strategyHash, address token, uint256 amount, address to) external;

    /// @notice Push tokens back to a maker and credit the strategy's balance.
    function push(address maker, address app, bytes32 strategyHash, address token, uint256 amount) external;

    /// @notice Balance still registered for (maker, app, strategyHash, token).
    function rawBalances(address maker, address app, bytes32 strategyHash, address token)
        external
        view
        returns (uint248 balance, uint8 tokensCount);
}
