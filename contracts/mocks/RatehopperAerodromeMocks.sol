// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ISlipstreamNonfungiblePositionManager} from "../interfaces/aerodrome/ISlipstreamNonfungiblePositionManager.sol";
import {INonfungiblePositionManager} from "../interfaces/uniswapV3/INonfungiblePositionManager.sol";

// ─────────────────────────────────────────────────────────────────────────
//  Slipstream (Aerodrome CL) mocks for the SafeYieldManager / AerodromeYieldHandler tests.
//
//  These mirror the Uniswap mocks in RatehopperMocks.sol but carry the three
//  load-bearing Slipstream deltas so the handler's tickSpacing-keyed flow
//  exercises end-to-end on a plain Hardhat network:
//    1. pools/mint/positions are keyed by `int24 tickSpacing`, not `uint24 fee`;
//    2. `slot0` has no `feeProtocol` field;
//    3. the swap router's `exactInputSingle` params carry `tickSpacing` +
//       `deadline`, matching `ISlipstreamSwapRouter.exactInputSingle`.
//
//  The shared MockERC20 / MockRegistry / MockSafeHarness / MockERC721 from
//  RatehopperMocks.sol are reused as-is. TEST-ONLY; never deployed.
// ─────────────────────────────────────────────────────────────────────────

/// @notice Mirrors the Slipstream SwapRouter `exactInputSingle` selector
///         (0xa026383e). Pulls `amountIn` of `tokenIn` from the caller (the
///         Safe) and pays a configurable `output` of `tokenOut` to the
///         recipient. `output == 0` drives the `SwapFailed` branch.
contract MockSlipstreamSwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        int24 tickSpacing;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    uint256 public output;
    mapping(address => uint256) public outputFor;

    function setOutput(uint256 newOutput) external {
        output = newOutput;
    }

    function setOutputFor(address tokenOut, uint256 newOutput) external {
        outputFor[tokenOut] = newOutput;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut) {
        if (params.amountIn > 0) {
            IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        }
        amountOut = outputFor[params.tokenOut] != 0 ? outputFor[params.tokenOut] : output;
        if (amountOut > 0) {
            IERC20(params.tokenOut).transfer(params.recipient, amountOut);
        }
    }
}

/// @notice Configurable Slipstream CL pool stub for `_validatePool`. `slot0`
///         returns 6 fields (no `feeProtocol`) per the Slipstream layout.
contract MockCLPool {
    address public token0;
    address public token1;
    uint160 public sqrtPriceX96;
    uint128 public liquidity;

    constructor(address _token0, address _token1, uint160 _sqrtPriceX96, uint128 _liquidity) {
        token0 = _token0;
        token1 = _token1;
        sqrtPriceX96 = _sqrtPriceX96;
        liquidity = _liquidity;
    }

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, bool) {
        return (sqrtPriceX96, 0, 0, 0, 0, true);
    }
}

/// @notice Factory stub returning a single configurable default pool for any
///         lookup, with optional per-(pair, tickSpacing) overrides for
///         multi-pool tests (arbitrary-pair support).
contract MockCLFactory {
    address public pool;
    mapping(bytes32 => address) public keyedPools;

    function setPool(address newPool) external {
        pool = newPool;
    }

    function setPoolFor(address token0, address token1, int24 tickSpacing, address newPool) external {
        keyedPools[keccak256(abi.encode(token0, token1, tickSpacing))] = newPool;
    }

    function getPool(address token0, address token1, int24 tickSpacing) external view returns (address) {
        address keyed = keyedPools[keccak256(abi.encode(token0, token1, tickSpacing))];
        return keyed != address(0) ? keyed : pool;
    }
}

/// @notice Faithful-enough Slipstream Nonfungible Position Manager: tracks
///         per-tokenId owner / pair / liquidity / principal / owed, keyed by
///         `int24 tickSpacing` (not fee), and implements mint / positions /
///         ownerOf / collect / decreaseLiquidity / burn so the full LP
///         lifecycle can be driven on a plain network. Also carries just
///         enough ERC721 surface (approve / getApproved / transferFrom) for
///         MockStakePool to move the NFT in the stakePool-staking tests.
contract MockCLNonfungiblePositionManager {
    struct Position {
        address owner;
        address token0;
        address token1;
        int24 tickSpacing;
        uint128 liquidity;
        uint128 owed0;
        uint128 owed1;
        uint128 principal0;
        uint128 principal1;
        bool exists;
    }

    mapping(uint256 => Position) public positionsData;
    mapping(uint256 => address) public getApproved;
    uint256 public nextId = 1;

    // Config applied to the next `mint`.
    uint128 public mintLiquidity = 1_000_000;
    uint16 public mintUsageBps = 10_000;
    address public mintOwnerOverride;

    function setMintLiquidity(uint128 value) external {
        mintLiquidity = value;
    }

    function setMintUsageBps(uint16 value) external {
        require(value <= 10_000, "usage bps");
        mintUsageBps = value;
    }

    function setMintOwnerOverride(address account) external {
        mintOwnerOverride = account;
    }

    /// @dev Seed a position directly (for collectLp/closeLp tests that bypass
    ///      openLp via a storage-overridden basis).
    function seedPosition(
        uint256 tokenId,
        address owner,
        address token0,
        address token1,
        int24 tickSpacing,
        uint128 liquidity,
        uint128 principal0,
        uint128 principal1
    ) external {
        positionsData[tokenId] = Position(
            owner,
            token0,
            token1,
            tickSpacing,
            liquidity,
            0,
            0,
            principal0,
            principal1,
            true
        );
    }

    function setOwed(uint256 tokenId, uint128 owed0, uint128 owed1) external {
        positionsData[tokenId].owed0 = owed0;
        positionsData[tokenId].owed1 = owed1;
    }

    function setTokens(uint256 tokenId, address token0, address token1) external {
        positionsData[tokenId].token0 = token0;
        positionsData[tokenId].token1 = token1;
    }

    function setOwner(uint256 tokenId, address owner) external {
        positionsData[tokenId].owner = owner;
    }

    function mint(
        ISlipstreamNonfungiblePositionManager.MintParams calldata params
    ) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1) {
        tokenId = nextId++;
        amount0 = (params.amount0Desired * mintUsageBps) / 10_000;
        amount1 = (params.amount1Desired * mintUsageBps) / 10_000;
        if (amount0 > 0) IERC20(params.token0).transferFrom(msg.sender, address(this), amount0);
        if (amount1 > 0) IERC20(params.token1).transferFrom(msg.sender, address(this), amount1);
        liquidity = mintLiquidity;
        address owner = mintOwnerOverride == address(0) ? params.recipient : mintOwnerOverride;
        positionsData[tokenId] = Position(
            owner,
            params.token0,
            params.token1,
            params.tickSpacing,
            liquidity,
            0,
            0,
            uint128(amount0),
            uint128(amount1),
            true
        );
    }

    function positions(
        uint256 tokenId
    )
        external
        view
        returns (uint96, address, address, address, int24, int24, int24, uint128, uint256, uint256, uint128, uint128)
    {
        Position memory p = positionsData[tokenId];
        return (
            0,
            address(0),
            p.token0,
            p.token1,
            p.tickSpacing,
            int24(0),
            int24(0),
            p.liquidity,
            0,
            0,
            p.owed0,
            p.owed1
        );
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        return positionsData[tokenId].owner;
    }

    /// @dev Minimal ERC721 `approve`: only the current owner may set it.
    function approve(address to, uint256 tokenId) external {
        require(msg.sender == positionsData[tokenId].owner, "not owner");
        getApproved[tokenId] = to;
    }

    /// @dev Minimal ERC721 `transferFrom`: caller must be the owner or the
    ///      approved address, `from` must match the current owner.
    function transferFrom(address from, address to, uint256 tokenId) external {
        require(from == positionsData[tokenId].owner, "wrong owner");
        require(msg.sender == from || msg.sender == getApproved[tokenId], "not authorized");
        positionsData[tokenId].owner = to;
        getApproved[tokenId] = address(0);
    }

    function collect(
        INonfungiblePositionManager.CollectParams calldata params
    ) external payable returns (uint256 amount0, uint256 amount1) {
        Position storage p = positionsData[params.tokenId];
        amount0 = p.owed0;
        amount1 = p.owed1;
        p.owed0 = 0;
        p.owed1 = 0;
        if (amount0 > 0) IERC20(p.token0).transfer(params.recipient, amount0);
        if (amount1 > 0) IERC20(p.token1).transfer(params.recipient, amount1);
    }

    function decreaseLiquidity(
        INonfungiblePositionManager.DecreaseLiquidityParams calldata params
    ) external payable returns (uint256 amount0, uint256 amount1) {
        Position storage p = positionsData[params.tokenId];
        require(params.liquidity <= p.liquidity, "liquidity");
        if (p.liquidity > 0) {
            amount0 = (uint256(p.principal0) * params.liquidity) / p.liquidity;
            amount1 = (uint256(p.principal1) * params.liquidity) / p.liquidity;
        }
        require(amount0 >= params.amount0Min && amount1 >= params.amount1Min, "Price slippage check");
        p.principal0 -= uint128(amount0);
        p.principal1 -= uint128(amount1);
        p.owed0 += uint128(amount0);
        p.owed1 += uint128(amount1);
        p.liquidity -= params.liquidity;
    }

    function burn(uint256 tokenId) external payable {
        Position storage p = positionsData[tokenId];
        require(p.liquidity == 0, "not empty");
        delete positionsData[tokenId];
    }
}

/// @notice Settable pool -> stakePool registry stub for `IVoter`, driving
///         AerodromeYieldHandler's `_stake` / `_unstakeIfStaked` hooks.
contract MockVoter {
    mapping(address => address) private _stakePools;

    function setStakePool(address pool, address stakePool) external {
        _stakePools[pool] = stakePool;
    }

    function gauges(address pool) external view returns (address) {
        return _stakePools[pool];
    }
}

/// @notice Minimal `IStakePool` stub: `deposit` pulls the NFT from the caller
///         (the Safe, which must have approved this stakePool), `withdraw` sends
///         it back with the ERC721 receive hook, mirroring the real stakePool's
///         `safeTransferFrom` so the Safe-harness `onERC721Received` path is
///         actually exercised.
contract MockStakePool {
    address public immutable NFT;

    /// @dev Arms a deposit failure so tests can prove a restake that reverts
    ///      takes the whole partial close down with it.
    bool public depositFails;

    constructor(address _nft) {
        NFT = _nft;
    }

    function setDepositFails(bool value) external {
        depositFails = value;
    }

    function deposit(uint256 tokenId) external {
        require(!depositFails, "deposit disabled");
        IERC721(NFT).transferFrom(msg.sender, address(this), tokenId);
    }

    /// @dev Mirrors a real gauge: withdrawing also pays out everything accrued,
    ///      so close/switch paths must settle that reward like a collect does.
    function withdraw(uint256 tokenId) external {
        IERC721(NFT).transferFrom(address(this), msg.sender, tokenId);
        if (rewardToken != address(0) && rewardAmount > 0) {
            emit RewardClaimed(tokenId, msg.sender);
            IERC20(rewardToken).transfer(msg.sender, rewardAmount);
        }
        if (msg.sender.code.length > 0) {
            require(
                IERC721Receiver(msg.sender).onERC721Received(address(this), address(this), tokenId, "") ==
                    IERC721Receiver.onERC721Received.selector,
                "unsafe recipient"
            );
        }
    }

    event RewardClaimed(uint256 indexed tokenId, address indexed to);

    address public rewardToken;
    uint256 public rewardAmount;

    /// @dev Arm the mock with an emission payout so tests can exercise the
    ///      claimed-reward → USDC swap path.
    function setReward(address token, uint256 amount) external {
        rewardToken = token;
        rewardAmount = amount;
    }

    /// @dev Mock reward claim — records the call so tests can assert collectLp
    ///      routed a staked position to the stakePool, and pays the configured
    ///      emission (if armed) like the real stakePool pays AERO.
    function getReward(uint256 tokenId) external {
        emit RewardClaimed(tokenId, msg.sender);
        if (rewardToken != address(0) && rewardAmount > 0) {
            IERC20(rewardToken).transfer(msg.sender, rewardAmount);
        }
    }
}
