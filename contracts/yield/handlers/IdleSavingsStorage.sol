// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/// @title IdleSavingsStorage
/// @notice ERC-7201 namespaced storage for the idle savings handlers, kept
///         apart from `YieldStorage` so a mistake in this layout can never
///         collide with any position's basis, pin, carry or allow-list, and
///         keyed by protocol id so a second idle savings source registered
///         under another id can never read or move this one's records. The
///         handlers declare no storage variables of their own; the manager's
///         `YieldLayout` is read by them but never written (the basis a
///         handler reports goes back through the `open` return value).
abstract contract IdleSavingsStorage {
    /// @custom:storage-location erc7201:ratehopper.storage.idleSavings
    struct IdleSavingsLayout {
        /// @dev Share-token units deposited for a position, net of
        ///      redemptions. `tokenId` is the Safe address as a uint256.
        mapping(uint8 protocolId => mapping(uint256 tokenId => uint256)) sharesOf;
        /// @dev Sum of `sharesOf` across all positions of a protocol; the
        ///      exposure rail reads it.
        mapping(uint8 protocolId => uint256) totalShares;
    }

    // keccak256(abi.encode(uint256(keccak256("ratehopper.storage.idleSavings")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 internal constant IDLE_SAVINGS_STORAGE_SLOT =
        0x976ffd6dddc2117eb0340a87bbce8d17054b1d112887edd40565281982b07900;

    function _idleSavingsStorage() internal pure returns (IdleSavingsLayout storage $) {
        assembly ("memory-safe") {
            $.slot := IDLE_SAVINGS_STORAGE_SLOT
        }
    }
}
