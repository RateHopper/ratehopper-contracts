// SPDX-License-Identifier: BUSL-1.1
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ISlipstreamNonfungiblePositionManager} from "../../interfaces/aerodrome/ISlipstreamNonfungiblePositionManager.sol";
import {ICLFactory} from "../../interfaces/aerodrome/ICLFactory.sol";
import {ICLPool} from "../../interfaces/aerodrome/ICLPool.sol";
import {IStakePool} from "../../interfaces/aerodrome/IStakePool.sol";
import {IVoter} from "../../interfaces/aerodrome/IVoter.sol";
import {ISlipstreamSwapRouter} from "../../interfaces/aerodrome/ISlipstreamSwapRouter.sol";
import {BaseYieldHandler} from "./BaseYieldHandler.sol";
import "../../common/Types.sol";

/// @title AerodromeYieldHandler
/// @notice Aerodrome Slipstream adapter for SafeYieldManager. Pool params
///         are `abi.encode(token0, token1, int24 tickSpacing)`. Executed via
///         delegatecall from the manager and records each position's stakePool.
contract AerodromeYieldHandler is BaseYieldHandler {
    ICLFactory public immutable CL_FACTORY;
    /// @notice Aerodrome Voter — the canonical pool -> stake pool registry used to
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

    /// @dev Stake the minted Slipstream NFT into its pool's stake pool (resolved
    ///      via the Voter) for AERO emissions: the Safe approves the stakePool for
    ///      the NFT, then deposits. Reverts if the pool has no live stakePool.
    function _stake(address _onBehalfOf, uint256 tokenId, bytes memory lpPoolParam) internal override {
        address stakePool = VOTER.gauges(_getPool(lpPoolParam));
        if (stakePool == address(0) || !_stakePoolAcceptsDeposits(stakePool)) revert StakingNotSupported();
        _restakeInto(_onBehalfOf, tokenId, stakePool);
        _yieldStorage().stakePoolOf[PROTOCOL][tokenId] = stakePool;
    }

    /// @dev The Voter's liveness flag: a killed gauge reverts `deposit` ("GK").
    function _stakePoolAcceptsDeposits(address stakePool) internal view override returns (bool) {
        return VOTER.isAlive(stakePool);
    }

    /// @dev Deposit `tokenId` into `stakePool`. Shared by the initial stake and by
    ///      the partial-close restake, which passes the PINNED pool rather than
    ///      re-reading the Voter — the mapping is governance-controlled and a
    ///      rotation must not silently move a user's position to another gauge.
    function _restakeInto(address _onBehalfOf, uint256 tokenId, address stakePool) internal override {
        _safeExec(_onBehalfOf, POSITION_MANAGER, abi.encodeCall(IERC721.approve, (stakePool, tokenId)), 28);
        _safeExec(_onBehalfOf, stakePool, abi.encodeCall(IStakePool.deposit, (tokenId)), 29);
    }

    /// @dev The pool stakePool currently holding `tokenId`, or address(0) when the
    ///      position is unstaked or its pool has no stakePool — the single
    ///      definition of "staked" shared by the hooks below.
    function _stakePoolOf(uint256 tokenId) internal view returns (address) {
        address stakePool = _yieldStorage().stakePoolOf[PROTOCOL][tokenId];
        if (stakePool == address(0) || IERC721(POSITION_MANAGER).ownerOf(tokenId) != stakePool) return address(0);
        return stakePool;
    }

    /// @dev Withdraw `tokenId` from its pool's stakePool back to the Safe when it is
    ///      staked (stakePool owns the NFT); a no-op otherwise so unstaked and
    ///      no-stakePool positions close normally. Returns the pool it came out of
    ///      so a surviving partial position is restaked into that same pool; the
    ///      pin itself survives here and is cleared only by a full close.
    function _unstakeIfStaked(address _onBehalfOf, uint256 tokenId) internal override returns (address stakePool) {
        stakePool = _stakePoolOf(tokenId);
        if (stakePool == address(0)) return address(0);

        // Withdrawing from a gauge pays out everything accrued so far. That is the
        // same emission yield an explicit collect claims, so it is settled through
        // the same fee path here — otherwise a close or a switch would be a way to
        // take emissions without paying feeCollectBps. Callers run this BEFORE
        // their own balance snapshots, so the reward can never leak into the close
        // swap delta or the performance-fee valuation.
        // A gauge that reports no reward token gets no snapshot: an exit must not
        // brick on a misbehaving gauge, and `_settleStakedReward` no-ops on zero.
        address rewardToken = IStakePool(stakePool).rewardToken();
        uint256 rewardBefore = rewardToken == address(0) ? 0 : IERC20(rewardToken).balanceOf(_onBehalfOf);
        _safeExec(_onBehalfOf, stakePool, abi.encodeCall(IStakePool.withdraw, (tokenId)), 30);
        _settleStakedReward(_onBehalfOf, tokenId, rewardToken, rewardBefore);
    }

    /// @dev When `tokenId` is staked in its pool's stakePool, claim its accrued AERO
    ///      emissions to the Safe. Staked liquidity earns emissions instead of
    ///      trading fees, so this claim is the position's complete harvest. With
    ///      `captureReward`, snapshot the Safe's AERO balance before the claim so
    ///      the base can swap exactly the claimed amount to USDC.
    function _collectStakedRewardIfStaked(
        address _onBehalfOf,
        uint256 tokenId
    ) internal override returns (bool wasStaked, address rewardToken, uint256 rewardBalanceBefore) {
        address stakePool = _stakePoolOf(tokenId);
        if (stakePool == address(0)) return (false, address(0), 0);
        // Snapshot unconditionally: the claim is fee-bearing even when the caller
        // does not want it swapped, so the amount must always be measurable. A
        // gauge reporting no reward token yields no snapshot and no settlement.
        rewardToken = IStakePool(stakePool).rewardToken();
        rewardBalanceBefore = rewardToken == address(0) ? 0 : IERC20(rewardToken).balanceOf(_onBehalfOf);
        _safeExec(_onBehalfOf, stakePool, abi.encodeCall(IStakePool.getReward, (tokenId)), 37);
        return (true, rewardToken, rewardBalanceBefore);
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
