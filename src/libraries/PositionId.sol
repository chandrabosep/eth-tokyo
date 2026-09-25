// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @title PositionId
/// @notice Packs an option position's identity into a single ERC-1155 token id.
/// @dev Layout (little end first):
///        bit  0       isLong   (1 = bought the option, 0 = wrote it)
///        bit  1       isPut    (1 = put, 0 = call)
///        bits 8..31   tickLower as uint24 (two's complement of int24)
///        bits 32..55  tickUpper as uint24
///        bits 56..63  marketId
///      The id is decodable rather than hashed so the frontend can render a
///      position's strike and direction straight from the token id.
library PositionId {
    uint256 internal constant LONG_BIT = 1;
    uint256 internal constant PUT_BIT = 2;

    function encode(uint8 marketId, int24 tickLower, int24 tickUpper, bool isPut_, bool isLong_)
        internal
        pure
        returns (uint256 id)
    {
        id = (uint256(marketId) << 56) | (uint256(uint24(tickUpper)) << 32) | (uint256(uint24(tickLower)) << 8)
            | (isPut_ ? PUT_BIT : 0) | (isLong_ ? LONG_BIT : 0);
    }

    function decode(uint256 id)
        internal
        pure
        returns (uint8 marketId, int24 tickLower, int24 tickUpper, bool isPut_, bool isLong_)
    {
        isLong_ = (id & LONG_BIT) != 0;
        isPut_ = (id & PUT_BIT) != 0;
        tickLower = int24(uint24(id >> 8));
        tickUpper = int24(uint24(id >> 32));
        marketId = uint8(id >> 56);
    }

    /// @notice The id of the opposite side of the same series.
    function flipSide(uint256 id) internal pure returns (uint256) {
        return id ^ LONG_BIT;
    }

    function isLong(uint256 id) internal pure returns (bool) {
        return (id & LONG_BIT) != 0;
    }

    function isPut(uint256 id) internal pure returns (bool) {
        return (id & PUT_BIT) != 0;
    }
}
