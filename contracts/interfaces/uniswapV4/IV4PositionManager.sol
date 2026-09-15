// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {PoolKey} from "./V4Types.sol";

/// @notice Minimal surface of the Uniswap V4 PositionManager (an ERC-721)
///         used by UniV4YieldHandler. `modifyLiquidities` executes an
///         abi.encode(actions, params) batch and returns nothing — position
///         ids come from reading `nextTokenId` before the mint, amounts from
///         balance deltas.
interface IV4PositionManager {
    /// @notice Batched liquidity operations, unlocked against the PoolManager.
    /// @param unlockData abi.encode(bytes actions, bytes[] params)
    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable;

    /// @notice Id the NEXT minted position will get (assigned, then incremented).
    function nextTokenId() external view returns (uint256);

    /// @return poolKey the pool the position sits in
    /// @return info packed PositionInfo (poolId upper bits | tickUpper | tickLower | subscribe flag)
    function getPoolAndPositionInfo(uint256 tokenId) external view returns (PoolKey memory poolKey, uint256 info);

    function getPositionLiquidity(uint256 tokenId) external view returns (uint128 liquidity);
}
