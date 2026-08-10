// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ISlipstreamNonfungiblePositionManager} from "../../interfaces/aerodrome/ISlipstreamNonfungiblePositionManager.sol";
import {ICLFactory} from "../../interfaces/aerodrome/ICLFactory.sol";
import {ICLPool} from "../../interfaces/aerodrome/ICLPool.sol";
import {ICLGauge} from "../../interfaces/aerodrome/ICLGauge.sol";
import {IVoter} from "../../interfaces/aerodrome/IVoter.sol";
import {ISlipstreamSwapRouter} from "../../interfaces/aerodrome/ISlipstreamSwapRouter.sol";
import {BaseYieldHandler} from "./BaseYieldHandler.sol";
import "../../common/Types.sol";

/// @title AerodromeYieldHandler
/// @notice Aerodrome Slipstream adapter for SafeYieldManager. Pool params
///         are `abi.encode(token0, token1, int24 tickSpacing)`. Stateless —
///         executed via delegatecall from the manager.
contract AerodromeYieldHandler is BaseYieldHandler {
    ICLFactory public immutable CL_FACTORY;
    /// @notice Aerodrome Voter — the canonical pool -> CL gauge registry used to
    ///         resolve where a position is staked/unstaked.
    IVoter public immutable VOTER;

    constructor(
        address _positionManager,
        IERC20 _usdc,
        address _swapRouter,
        ICLFactory _clFactory,
        IVoter _voter
    ) BaseYieldHandler(YIELD_PROTOCOL_AERODROME, _positionManager, _usdc, _swapRouter) {
        if (address(_clFactory) == address(0)) revert ZeroAddress();
        if (address(_voter) == address(0)) revert ZeroAddress();
        CL_FACTORY = _clFactory;
        VOTER = _voter;
    }

    /// @dev Stake the minted Slipstream NFT into its pool's CL gauge (resolved
    ///      via the Voter) for AERO emissions: the Safe approves the gauge for
    ///      the NFT, then deposits. Reverts if the pool has no gauge.
    function _stakeInGauge(address _onBehalfOf, uint256 tokenId, bytes memory lpPoolParam) internal override {
        address gauge = VOTER.gauges(_getPool(lpPoolParam));
        if (gauge == address(0)) revert GaugeStakingNotSupported();
        _safeExec(_onBehalfOf, POSITION_MANAGER, abi.encodeCall(IERC721.approve, (gauge, tokenId)), 28);
        _safeExec(_onBehalfOf, gauge, abi.encodeCall(ICLGauge.deposit, (tokenId)), 29);
    }

    /// @dev The pool gauge currently holding `tokenId`, or address(0) when the
    ///      position is unstaked or its pool has no gauge — the single
    ///      definition of "staked" shared by the hooks below.
    function _stakedGaugeOf(uint256 tokenId) internal view returns (address) {
        (, , bytes memory lpPoolParam, ) = _position(tokenId);
        address gauge = VOTER.gauges(_getPool(lpPoolParam));
        if (gauge == address(0) || IERC721(POSITION_MANAGER).ownerOf(tokenId) != gauge) return address(0);
        return gauge;
    }

    /// @dev Withdraw `tokenId` from its pool's gauge back to the Safe when it is
    ///      staked (gauge owns the NFT); a no-op otherwise so unstaked and
    ///      no-gauge positions close normally.
    function _unstakeIfStaked(address _onBehalfOf, uint256 tokenId) internal override {
        address gauge = _stakedGaugeOf(tokenId);
        if (gauge != address(0)) {
            _safeExec(_onBehalfOf, gauge, abi.encodeCall(ICLGauge.withdraw, (tokenId)), 30);
        }
    }

    /// @dev When `tokenId` is staked in its pool's gauge, claim its accrued AERO
    ///      emissions to the Safe and report that the base must temporarily
    ///      unstake it to collect the position's LP trading fees.
    function _collectStakedRewardIfStaked(address _onBehalfOf, uint256 tokenId) internal override returns (bool) {
        address gauge = _stakedGaugeOf(tokenId);
        if (gauge == address(0)) return false;
        _safeExec(_onBehalfOf, gauge, abi.encodeCall(ICLGauge.getReward, (tokenId)), 37);
        return true;
    }

    function _decodePoolParam(
        bytes memory poolParam
    ) internal pure returns (address token0, address token1, int24 tickSpacing) {
        (token0, token1, tickSpacing) = abi.decode(poolParam, (address, address, int24));
    }

    function _poolTokens(bytes memory poolParam) internal pure override returns (address token0, address token1) {
        (token0, token1, ) = _decodePoolParam(poolParam);
    }

    function _getPool(bytes memory poolParam) internal view override returns (address) {
        (address token0, address token1, int24 tickSpacing) = _decodePoolParam(poolParam);
        return CL_FACTORY.getPool(token0, token1, tickSpacing);
    }

    function _poolSqrtPriceX96(address pool) internal view override returns (uint160 sqrtPriceX96) {
        (sqrtPriceX96, , , , , ) = ICLPool(pool).slot0();
    }

    function _buildSwapCalldata(
        address tokenIn,
        address tokenOut,
        bytes memory poolParam,
        address recipient,
        uint256 amountIn,
        uint256 amountOutMin,
        uint256 deadline
    ) internal pure override returns (bytes memory) {
        (, , int24 tickSpacing) = _decodePoolParam(poolParam);
        return
            abi.encodeCall(
                ISlipstreamSwapRouter.exactInputSingle,
                (
                    ISlipstreamSwapRouter.ExactInputSingleParams({
                        tokenIn: tokenIn,
                        tokenOut: tokenOut,
                        tickSpacing: tickSpacing,
                        recipient: recipient,
                        deadline: deadline,
                        amountIn: amountIn,
                        amountOutMinimum: amountOutMin,
                        sqrtPriceLimitX96: 0
                    })
                )
            );
    }

    function _buildMintCalldata(
        bytes memory lpPoolParam,
        int24 tickLower,
        int24 tickUpper,
        uint256 amount0Desired,
        uint256 amount1Desired,
        uint256 amount0Min,
        uint256 amount1Min,
        address recipient,
        uint256 deadline
    ) internal pure override returns (bytes memory) {
        (address token0, address token1, int24 tickSpacing) = _decodePoolParam(lpPoolParam);
        return
            abi.encodeCall(
                ISlipstreamNonfungiblePositionManager.mint,
                (
                    ISlipstreamNonfungiblePositionManager.MintParams({
                        token0: token0,
                        token1: token1,
                        tickSpacing: tickSpacing,
                        tickLower: tickLower,
                        tickUpper: tickUpper,
                        amount0Desired: amount0Desired,
                        amount1Desired: amount1Desired,
                        amount0Min: amount0Min,
                        amount1Min: amount1Min,
                        recipient: recipient,
                        deadline: deadline,
                        sqrtPriceX96: 0
                    })
                )
            );
    }

    function _position(
        uint256 tokenId
    ) internal view override returns (address token0, address token1, bytes memory lpPoolParam, uint128 liquidity) {
        int24 tickSpacing;
        (, , token0, token1, tickSpacing, , , liquidity, , , , ) = ISlipstreamNonfungiblePositionManager(
            POSITION_MANAGER
        ).positions(tokenId);
        lpPoolParam = abi.encode(token0, token1, tickSpacing);
    }
}
