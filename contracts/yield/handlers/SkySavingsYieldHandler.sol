// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISparkPSM3} from "../../interfaces/spark/ISparkPSM3.sol";
import {ChainlinkSsrRateProvider} from "../savings/ChainlinkSsrRateProvider.sol";
import {BaseSavingsHandler} from "./BaseSavingsHandler.sol";
import "../../common/Types.sol";

/// @title SkySavingsYieldHandler
/// @notice Savings source for sUSDS on Base through Spark PSM3 (what the
///         Osero Earn SDK calls under the hood): deposit is
///         `USDC.approve(PSM3)` + `PSM3.swapExactIn(USDC -> sUSDS)`, redeem is
///         `sUSDS.approve(PSM3)` + `PSM3.swapExactIn(sUSDS -> USDC)`, each
///         with the Osero referral code as the last argument and the
///         allowance reset to zero afterwards. PSM3 has no fee and no partial
///         fill: USDC comes out of its pocket, and a redemption larger than
///         the pocket reverts inside the USDC transfer.
///
///         Pool param: `abi.encode(address psm3, address susds)`, both equal
///         to this build's immutables. Protocol id 3.
///
///         Price protection is the handler's own floor from
///         `ChainlinkSsrRateProvider` (Chainlink sUSDS/USDS rate vetoed by
///         Spark's SSR oracle); the manager's Uniswap V3 TWAP rule is bypassed
///         by reporting USDC-only pool tokens. That exception belongs in
///         SECURITY_MODEL.md ("Protocol 3 prices from Chainlink, not a pool"),
///         written together with the registration tooling.
/// @dev    Step codes 80 to 85: 80 approve USDC, 81 deposit swap, 82 reset,
///         83 approve sUSDS, 84 redeem swap, 85 reset. A PSM3 failure
///         (81, 84) is therefore distinguishable from an approval failure.
contract SkySavingsYieldHandler is BaseSavingsHandler {
    ISparkPSM3 public immutable PSM3;
    IERC20 public immutable SUSDS;
    uint256 public immutable REFERRAL_CODE;

    /// @dev Takes the concrete provider so `PSM3.rateProvider()` can be checked
    ///      against the oracle the provider vetoes with: the cross-check is
    ///      only worth something if it is against the oracle PSM3 prices with.
    constructor(
        IERC20 _usdc,
        ChainlinkSsrRateProvider _rateProvider,
        uint16 _maxToleranceBps,
        uint16 _maxExposureBps,
        ISparkPSM3 _psm3,
        IERC20 _susds,
        uint256 _referralCode
    ) BaseSavingsHandler(YIELD_PROTOCOL_SKY_SAVINGS, _usdc, _rateProvider, _susds, _maxToleranceBps, _maxExposureBps) {
        if (address(_psm3) == address(0)) revert ZeroAddress();
        if (_psm3.usdc() != address(_usdc)) revert InvalidConfig();
        if (_psm3.susds() != address(_susds)) revert InvalidConfig();
        if (_psm3.rateProvider() != address(_rateProvider.SSR_ORACLE())) revert InvalidConfig();

        PSM3 = _psm3;
        SUSDS = _susds;
        REFERRAL_CODE = _referralCode;
    }

    function _shareToken() internal view override returns (IERC20) {
        return SUSDS;
    }

    function _poolParamMatches(bytes memory poolParam) internal view override returns (bool) {
        (address psm3, address susds) = abi.decode(poolParam, (address, address));
        return psm3 == address(PSM3) && susds == address(SUSDS);
    }

    /// @dev PSM3 pulls exactly `amountIn`, so the reset is a no-op in practice;
    ///      kept so "no allowance survives the call" holds structurally.
    function _depositUsdc(address safe, uint256 usdc6, uint256 minShares) internal override {
        _safeApprove(safe, address(USDC), address(PSM3), usdc6, 80);
        _safeExec(
            safe,
            address(PSM3),
            abi.encodeCall(
                ISparkPSM3.swapExactIn,
                (address(USDC), address(SUSDS), usdc6, minShares, safe, REFERRAL_CODE)
            ),
            81
        );
        _safeApprove(safe, address(USDC), address(PSM3), 0, 82);
    }

    function _redeemShares(address safe, uint256 shares, uint256 minUsdc6) internal override {
        _safeApprove(safe, address(SUSDS), address(PSM3), shares, 83);
        _safeExec(
            safe,
            address(PSM3),
            abi.encodeCall(
                ISparkPSM3.swapExactIn,
                (address(SUSDS), address(USDC), shares, minUsdc6, safe, REFERRAL_CODE)
            ),
            84
        );
        _safeApprove(safe, address(SUSDS), address(PSM3), 0, 85);
    }

    function _liquidityAvailable() internal view override returns (uint256) {
        return USDC.balanceOf(PSM3.pocket());
    }
}
