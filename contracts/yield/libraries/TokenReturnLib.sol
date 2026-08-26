// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

/// @notice Interprets the optional bool returndata of module-mediated ERC20
///         calls (transfer/approve), where SafeERC20 cannot be used because
///         the token call happens inside the Safe, not from this contract.
library TokenReturnLib {
    /// @dev Empty returndata counts as success (no-return tokens like USDT),
    ///      anything shorter than a word is malformed, and a full word must be
    ///      the canonical true — the same strictness as SafeERC20.
    function returnedTrue(bytes memory ret) internal pure returns (bool) {
        if (ret.length == 0) return true;
        if (ret.length < 32) return false;
        uint256 word;
        assembly ("memory-safe") {
            word := mload(add(ret, 0x20))
        }
        return word == 1;
    }
}
