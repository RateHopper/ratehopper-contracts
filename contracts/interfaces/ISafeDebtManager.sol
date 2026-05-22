// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {Protocol, CollateralAsset} from "../Types.sol";
import {IProtocolRegistry} from "./IProtocolRegistry.sol";

/// @notice Minimal interface exposing the SafeDebtManager surface that
///         RateHopperPositions.closeLp() needs to call. Only `exit(...)` and
///         the `registry()` getter are declared — the full SafeDebtManager
///         surface lives in the implementation contract.
interface ISafeDebtManager {
    function exit(
        Protocol _protocol,
        address _debtAsset,
        uint256 _debtAmount,
        CollateralAsset[] calldata _collateralAssets,
        address _onBehalfOf,
        bytes calldata _extraData,
        bool _withdrawCollateral
    ) external;

    function registry() external view returns (IProtocolRegistry);
}
