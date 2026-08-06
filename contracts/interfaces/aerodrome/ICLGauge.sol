// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/// @notice Minimal Aerodrome Slipstream CL gauge surface. `deposit` stakes a
///         Slipstream LP NFT (pulling it from the caller, who must have
///         approved the gauge) to earn AERO emissions; `withdraw` unstakes it,
///         returning the NFT to the caller; `getReward` claims the accrued AERO
///         emissions for a staked position to its owner (the caller).
interface ICLGauge {
    function deposit(uint256 tokenId) external;

    function withdraw(uint256 tokenId) external;

    function getReward(uint256 tokenId) external;
}
