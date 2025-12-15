// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {IComet} from "../interfaces/compound/IComet.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ProtocolRegistry} from "../ProtocolRegistry.sol";
import {CollateralAsset} from "../Types.sol";
import "./BaseProtocolHandler.sol";

contract CompoundHandler is BaseProtocolHandler {
    using SafeERC20 for IERC20;

    constructor(address _registry, address _uniswapV3Factory) BaseProtocolHandler(_uniswapV3Factory, _registry) {
    }

    function getCContract(address token) internal view returns (address) {
        return registry.getCContract(token);
    }

    function getDebtAmount(
        address asset,
        address onBehalfOf,
        bytes calldata /* extraData */
    ) public view returns (uint256) {
        address cContract = getCContract(asset);
        require(cContract != address(0), "Token not registered");

        IComet comet = IComet(cContract);
        return comet.borrowBalanceOf(onBehalfOf);
    }

    function switchIn(
        address fromAsset,
        address toAsset,
        uint256 amount,
        uint256 amountTotal,
        address onBehalfOf,
        CollateralAsset[] memory collateralAssets,
        bytes calldata fromExtraData,
        bytes calldata toExtraData
    ) external override onlyAuthorizedCaller(onBehalfOf) {
        switchFrom(fromAsset, amount, onBehalfOf, collateralAssets, fromExtraData);
        switchTo(toAsset, amountTotal, onBehalfOf, collateralAssets, toExtraData);
    }

    function switchFrom(
        address fromAsset,
        uint256 amount,
        address onBehalfOf,
        CollateralAsset[] memory collateralAssets,
        bytes calldata /* extraData */
    ) public override onlyAuthorizedCaller(onBehalfOf) {       
        require(registry.isWhitelisted(fromAsset), "From asset is not whitelisted");
 
        address cContract = getCContract(fromAsset);
        require(cContract != address(0), "Token not registered");

        IComet fromComet = IComet(cContract);

        IERC20(fromAsset).forceApprove(address(cContract), amount);
        fromComet.supplyTo(onBehalfOf, fromAsset, amount);
        IERC20(fromAsset).forceApprove(address(cContract), 0);

        _validateCollateralAssets(collateralAssets);
        for (uint256 i = 0; i < collateralAssets.length; i++) {
            require(registry.isWhitelisted(collateralAssets[i].asset), "Collateral asset is not whitelisted");
            fromComet.withdrawFrom(onBehalfOf, address(this), collateralAssets[i].asset, collateralAssets[i].amount);
        }
    }

    function switchTo(
        address toAsset,
        uint256 amount,
        address onBehalfOf,
        CollateralAsset[] memory collateralAssets,
        bytes calldata /* extraData */
    ) public override onlyAuthorizedCaller(onBehalfOf) {        
        require(registry.isWhitelisted(toAsset), "To asset is not whitelisted");
        
        address cContract = getCContract(toAsset);
        require(cContract != address(0), "Token not registered");

        IComet toComet = IComet(cContract);
        
        _validateCollateralAssets(collateralAssets);
        for (uint256 i = 0; i < collateralAssets.length; i++) {
            require(registry.isWhitelisted(collateralAssets[i].asset), "Collateral asset is not whitelisted");
            uint256 currentBalance = IERC20(collateralAssets[i].asset).balanceOf(address(this));
            require(
                currentBalance * 100 < collateralAssets[i].amount * 101,
                "Current balance is more than collateral amount + buffer"
            );
            IERC20(collateralAssets[i].asset).forceApprove(address(cContract), currentBalance);

            // supply collateral
            toComet.supplyTo(onBehalfOf, collateralAssets[i].asset, currentBalance);
            IERC20(collateralAssets[i].asset).forceApprove(address(cContract), 0);
        }

        // borrow
        toComet.withdrawFrom(onBehalfOf, address(this), toAsset, amount);
    }

    function supply(
        address asset,
        uint256 amount,
        address onBehalfOf,
        bytes calldata extraData
    ) external override onlyAuthorizedCaller(onBehalfOf) {
        require(registry.isWhitelisted(asset), "Asset is not whitelisted");
        
        address cContract = abi.decode(extraData, (address));
        require(cContract != address(0), "Invalid comet address");

        IERC20(asset).forceApprove(address(cContract), amount);
        // supply collateral
        IComet(cContract).supplyTo(onBehalfOf, asset, amount);
        IERC20(asset).forceApprove(address(cContract), 0);
    }

    function borrow(
        address asset,
        uint256 amount,
        address onBehalfOf,
        bytes calldata /* extraData */
    ) external override onlyAuthorizedCaller(onBehalfOf) {
        require(registry.isWhitelisted(asset), "Asset is not whitelisted");
        
        address cContract = getCContract(asset);
        require(cContract != address(0), "Token not registered");

        IComet comet = IComet(cContract);
        comet.withdrawFrom(onBehalfOf, address(this), asset, amount);
    }

    function repay(
        address asset,
        uint256 amount,
        address onBehalfOf,
        bytes calldata /* extraData */
    ) external override onlyAuthorizedCaller(onBehalfOf) {
        require(registry.isWhitelisted(asset), "Asset is not whitelisted");

        address cContract = getCContract(asset);
        require(cContract != address(0), "Token not registered");

        IERC20(asset).forceApprove(address(cContract), amount);
        IComet toComet = IComet(cContract);
        toComet.supplyTo(onBehalfOf, asset, amount);
        IERC20(asset).forceApprove(address(cContract), 0);
    }

    function withdraw(
        address asset,
        uint256 amount,
        address onBehalfOf,
        bytes calldata extraData
    ) external override onlyAuthorizedCaller(onBehalfOf) {
        require(registry.isWhitelisted(asset), "Asset is not whitelisted");

        // Decode the comet address from extraData
        address cContract = abi.decode(extraData, (address));
        require(cContract != address(0), "Invalid comet address");

        // Withdraw collateral from user's position to this contract
        IComet comet = IComet(cContract);
        comet.withdrawFrom(onBehalfOf, address(this), asset, amount);
    }
}
