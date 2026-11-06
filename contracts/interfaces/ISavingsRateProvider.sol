// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/// @title ISavingsRateProvider
/// @notice Price source for one savings share token, pinned as an
///         immutable on the handler that uses it. Pricing lives outside the
///         handler so that each source has its own price logic, a feed change
///         is a small contract swap plus a handler rollover rather than a
///         handler rewrite, and the backend prices share tokens with the exact
///         same code the contract uses. Providers hold no state.
interface ISavingsRateProvider {
    /// @notice USDC (6 dp) per 1e18 shares of `shareToken`, expressed at 18
    ///         decimals (1e18 == 1 USDC per share). MUST revert, never return 0
    ///         or a stale value, when the price cannot be trusted. MUST revert
    ///         for any token it was not built for.
    function rate(address shareToken) external view returns (uint256);

    /// @notice The one share token this provider prices.
    function shareToken() external view returns (address);
}
