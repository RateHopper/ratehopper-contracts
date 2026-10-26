// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/// @title SavingsStorage
/// @notice ERC-7201 namespaced storage for the savings handlers, kept
///         apart from `YieldStorage` so a mistake in this layout can never
///         collide with any position's basis, pin, carry or allow-list, and
///         keyed by protocol id so a second savings source registered
///         under another id can never read or move this one's records. The
///         handlers declare no storage variables of their own; the manager's
///         `YieldLayout` is read by them but never written (the basis a
///         handler reports goes back through the `open` return value).
abstract contract SavingsStorage {
    struct SavingsConfig {
        uint16 maxToleranceBps;
        uint16 maxExposureBps;
    }

    /// @custom:storage-location erc7201:ratehopper.storage.savings
    struct SavingsLayout {
        /// @dev Share-token units deposited for a position, net of
        ///      redemptions. `tokenId` is the Safe address as a uint256.
        mapping(uint8 protocolId => mapping(uint256 tokenId => uint256)) sharesOf;
        /// @dev Sum of `sharesOf` across all positions of a protocol; the
        ///      exposure rail reads it.
        mapping(uint8 protocolId => uint256) totalShares;
        /// @dev Admin-tuned ceilings (`configure`); zero means unset, the
        ///      build's constructor defaults apply.
        mapping(uint8 protocolId => SavingsConfig) config;
    }

    // keccak256(abi.encode(uint256(keccak256("ratehopper.storage.savings")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant SAVINGS_STORAGE_SLOT = 0x0962243417e4241c7b748a805e4278155df27784ec85c8b6de11a1df301b4200;

    function _savingsStorage() internal pure returns (SavingsLayout storage $) {
        assembly ("memory-safe") {
            $.slot := SAVINGS_STORAGE_SLOT
        }
    }
}
