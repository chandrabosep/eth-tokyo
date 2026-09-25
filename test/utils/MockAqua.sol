// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IAqua} from "../../src/interfaces/IAqua.sol";
import {ERC20} from "solmate/src/tokens/ERC20.sol";
import {SafeTransferLib} from "solmate/src/utils/SafeTransferLib.sol";

/// @notice A faithful-enough stand-in for the deployed Aqua registry, for fast local tests.
/// @dev Mirrors the real contract's observable behaviour: balances keyed by
///      (maker, app, strategyHash, token); strategies immutable once shipped; `pull` callable only
///      by the app and capped at the registered amount; tokens moved with `transferFrom` straight
///      out of the maker's wallet. The real contract is exercised in `test/AquaFork.t.sol`.
contract MockAqua is IAqua {
    using SafeTransferLib for ERC20;

    uint8 internal constant DOCKED = type(uint8).max;

    struct Balance {
        uint248 amount;
        uint8 tokensCount;
    }

    mapping(address => mapping(address => mapping(bytes32 => mapping(address => Balance)))) internal _balances;

    error StrategiesMustBeImmutable(address app, bytes32 strategyHash);
    error DockingShouldCloseAllTokens(address app, bytes32 strategyHash);

    function ship(address app, bytes calldata strategy, address[] calldata tokens, uint256[] calldata amounts)
        external
        returns (bytes32 strategyHash)
    {
        strategyHash = keccak256(strategy);
        uint8 tokensCount = uint8(tokens.length);
        for (uint256 i = 0; i < tokens.length; i++) {
            Balance storage b = _balances[msg.sender][app][strategyHash][tokens[i]];
            require(b.tokensCount == 0, StrategiesMustBeImmutable(app, strategyHash));
            b.amount = uint248(amounts[i]);
            b.tokensCount = tokensCount;
        }
    }

    function dock(address app, bytes32 strategyHash, address[] calldata tokens) external {
        for (uint256 i = 0; i < tokens.length; i++) {
            Balance storage b = _balances[msg.sender][app][strategyHash][tokens[i]];
            require(b.tokensCount == tokens.length, DockingShouldCloseAllTokens(app, strategyHash));
            b.amount = 0;
            b.tokensCount = DOCKED;
        }
    }

    function pull(address maker, bytes32 strategyHash, address token, uint256 amount, address to) external {
        Balance storage b = _balances[maker][msg.sender][strategyHash][token];
        b.amount = uint248(b.amount - amount); // underflows if the offer does not cover it
        ERC20(token).safeTransferFrom(maker, to, amount);
    }

    function push(address maker, address app, bytes32 strategyHash, address token, uint256 amount) external {
        Balance storage b = _balances[maker][app][strategyHash][token];
        b.amount = uint248(b.amount + amount);
        ERC20(token).safeTransferFrom(msg.sender, maker, amount);
    }

    function rawBalances(address maker, address app, bytes32 strategyHash, address token)
        external
        view
        returns (uint248, uint8)
    {
        Balance storage b = _balances[maker][app][strategyHash][token];
        return (b.amount, b.tokensCount);
    }
}
