// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolKey, ExactInputSingleParams} from "../interfaces/uniswapV4/V4Types.sol";
import {V4Actions} from "../interfaces/uniswapV4/V4Constants.sol";

// ─────────────────────────────────────────────────────────────────────────
//  Mocks for UniV4YieldHandler unit/branch-coverage tests.
//
//  The shared MockERC20 / MockRegistry / MockSafeHarness from
//  RatehopperMocks.sol are reused; this file adds the V4-specific stack:
//  Permit2 (two-hop allowance enforcement), the actions-decoding
//  PositionManager, the UniversalRouter V4_SWAP stub, and the StateView
//  lens. Native ETH (currency == address(0)) is supported end-to-end so the
//  native-pool branches run deterministically. TEST-ONLY.
// ─────────────────────────────────────────────────────────────────────────

/// @notice Faithful-enough Permit2 AllowanceTransfer: records sub-allowances
///         and enforces BOTH hops on `transferFrom` (amount, expiration, and
///         the underlying ERC20 allowance owner -> Permit2), so the handler's
///         grant-exact/reset-to-zero discipline is genuinely exercised.
contract MockPermit2 {
    struct PackedAllowance {
        uint160 amount;
        uint48 expiration;
        uint48 nonce;
    }

    mapping(address => mapping(address => mapping(address => PackedAllowance))) public allowance;

    function approve(address token, address spender, uint160 amount, uint48 expiration) external {
        allowance[msg.sender][token][spender] = PackedAllowance(amount, expiration, 0);
    }

    function transferFrom(address from, address to, uint160 amount, address token) external {
        PackedAllowance storage allowed = allowance[from][token][msg.sender];
        require(block.timestamp <= allowed.expiration, "permit2: expired");
        require(allowed.amount >= amount, "permit2: insufficient allowance");
        if (allowed.amount != type(uint160).max) {
            allowed.amount -= amount;
        }
        require(IERC20(token).transferFrom(from, to, amount), "permit2: transferFrom");
    }
}

/// @notice Configurable StateView lens keyed by PoolId. A zero sqrt price is
///         the "pool not initialized" state, thin liquidity drives PoolTooThin.
contract MockStateView {
    struct PoolState {
        uint160 sqrtPriceX96;
        uint128 liquidity;
    }

    mapping(bytes32 => PoolState) public pools;

    function setPool(bytes32 poolId, uint160 sqrtPriceX96, uint128 liquidity) external {
        pools[poolId] = PoolState(sqrtPriceX96, liquidity);
    }

    function getSlot0(bytes32 poolId) external view returns (uint160, int24, uint24, uint24) {
        return (pools[poolId].sqrtPriceX96, 0, 0, 0);
    }

    function getLiquidity(bytes32 poolId) external view returns (uint128) {
        return pools[poolId].liquidity;
    }
}

/// @notice Actions-decoding V4 PositionManager: ERC721-lite with
///         `modifyLiquidities` handling MINT_POSITION / SETTLE_PAIR / SWEEP /
///         DECREASE_LIQUIDITY / BURN_POSITION / TAKE_PAIR the way the deployed
///         contract decodes them. ERC20 settlement pulls through MockPermit2
///         (msg.sender = the Safe); native settlement consumes call value and
///         SWEEP refunds the remainder.
contract MockV4PositionManager {
    struct Position {
        address owner;
        PoolKey key;
        int24 tickLower;
        int24 tickUpper;
        uint128 liquidity;
        uint128 owed0;
        uint128 owed1;
        uint128 principal0;
        uint128 principal1;
        bool exists;
    }

    MockPermit2 public immutable PERMIT2;

    mapping(uint256 => Position) public positionsData;
    uint256 public nextTokenId = 1;

    // Amounts SETTLE_PAIR pulls for the pending mint; type(uint128).max means
    // "pull the mint's amount0Max/amount1Max in full".
    uint128 public mintUse0 = type(uint128).max;
    uint128 public mintUse1 = type(uint128).max;
    address public mintOwnerOverride;

    // Transient per-call bookkeeping (single-threaded test usage).
    uint256 private pendingSettle0;
    uint256 private pendingSettle1;
    PoolKey private pendingKey;
    uint256 private pendingTake0;
    uint256 private pendingTake1;

    constructor(MockPermit2 _permit2) {
        PERMIT2 = _permit2;
    }

    receive() external payable {}

    function setMintUse(uint128 use0, uint128 use1) external {
        mintUse0 = use0;
        mintUse1 = use1;
    }

    function setMintOwnerOverride(address account) external {
        mintOwnerOverride = account;
    }

    /// @dev Seed a position directly (for closeLp/collectLp tests that bypass
    ///      openLp via a storage-overridden basis).
    function seedPosition(
        uint256 tokenId,
        address owner,
        PoolKey calldata key,
        uint128 liquidity,
        uint128 principal0,
        uint128 principal1
    ) external {
        positionsData[tokenId] = Position(owner, key, 0, 0, liquidity, 0, 0, principal0, principal1, true);
        if (tokenId >= nextTokenId) nextTokenId = tokenId + 1;
    }

    function setOwed(uint256 tokenId, uint128 owed0, uint128 owed1) external {
        positionsData[tokenId].owed0 = owed0;
        positionsData[tokenId].owed1 = owed1;
    }

    function setOwner(uint256 tokenId, address owner) external {
        positionsData[tokenId].owner = owner;
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        require(positionsData[tokenId].exists, "ERC721: invalid token");
        return positionsData[tokenId].owner;
    }

    function getPoolAndPositionInfo(uint256 tokenId) external view returns (PoolKey memory, uint256) {
        return (positionsData[tokenId].key, 0);
    }

    function getPositionLiquidity(uint256 tokenId) external view returns (uint128) {
        return positionsData[tokenId].liquidity;
    }

    function modifyLiquidities(bytes calldata unlockData, uint256 deadline) external payable {
        require(block.timestamp <= deadline, "pm: deadline");
        (bytes memory actions, bytes[] memory params) = abi.decode(unlockData, (bytes, bytes[]));
        uint256 valueLeft = msg.value;

        for (uint256 i = 0; i < actions.length; i++) {
            uint8 action = uint8(actions[i]);
            if (action == V4Actions.MINT_POSITION) {
                valueLeft = _handleMint(params[i]);
            } else if (action == V4Actions.SETTLE_PAIR) {
                valueLeft = _handleSettlePair(params[i], valueLeft);
            } else if (action == V4Actions.SWEEP) {
                (address currency, address to) = abi.decode(params[i], (address, address));
                require(currency == address(0), "pm: sweep erc20");
                if (valueLeft > 0) {
                    (bool sent, ) = to.call{value: valueLeft}("");
                    require(sent, "pm: sweep send");
                    valueLeft = 0;
                }
            } else if (action == V4Actions.DECREASE_LIQUIDITY) {
                _handleDecrease(params[i]);
            } else if (action == V4Actions.BURN_POSITION) {
                _handleBurn(params[i]);
            } else if (action == V4Actions.TAKE_PAIR) {
                _handleTakePair(params[i]);
            } else {
                revert("pm: unsupported action");
            }
        }
    }

    function _handleMint(bytes memory param) internal returns (uint256 valueLeft) {
        (
            PoolKey memory key,
            int24 tickLower,
            int24 tickUpper,
            uint256 liquidity,
            uint128 amount0Max,
            uint128 amount1Max,
            address owner /* hookData */,

        ) = abi.decode(param, (PoolKey, int24, int24, uint256, uint128, uint128, address, bytes));

        uint128 use0 = mintUse0 == type(uint128).max ? amount0Max : mintUse0;
        uint128 use1 = mintUse1 == type(uint128).max ? amount1Max : mintUse1;
        require(use0 <= amount0Max && use1 <= amount1Max, "pm: max exceeded");

        uint256 tokenId = nextTokenId++;
        address recordedOwner = mintOwnerOverride == address(0) ? owner : mintOwnerOverride;
        positionsData[tokenId] = Position(
            recordedOwner,
            key,
            tickLower,
            tickUpper,
            uint128(liquidity),
            0,
            0,
            use0,
            use1,
            true
        );
        pendingKey = key;
        pendingSettle0 = use0;
        pendingSettle1 = use1;
        valueLeft = msg.value;
    }

    function _handleSettlePair(bytes memory param, uint256 valueIn) internal returns (uint256 valueLeft) {
        (address currency0, address currency1) = abi.decode(param, (address, address));
        valueLeft = valueIn;
        if (pendingSettle0 > 0) {
            if (currency0 == address(0)) {
                require(valueLeft >= pendingSettle0, "pm: insufficient value");
                valueLeft -= pendingSettle0;
            } else {
                PERMIT2.transferFrom(msg.sender, address(this), uint160(pendingSettle0), currency0);
            }
        }
        if (pendingSettle1 > 0) {
            PERMIT2.transferFrom(msg.sender, address(this), uint160(pendingSettle1), currency1);
        }
        pendingSettle0 = 0;
        pendingSettle1 = 0;
    }

    function _handleDecrease(bytes memory param) internal {
        (uint256 tokenId, uint256 liquidity, uint128 amount0Min, uint128 amount1Min, ) = abi.decode(
            param,
            (uint256, uint256, uint128, uint128, bytes)
        );
        Position storage p = positionsData[tokenId];
        require(p.exists, "pm: unknown token");
        uint256 amount0;
        uint256 amount1;
        if (liquidity == 0) {
            // Fee-only delta: accrued fees become the take amounts.
            amount0 = p.owed0;
            amount1 = p.owed1;
            p.owed0 = 0;
            p.owed1 = 0;
        } else {
            require(liquidity <= p.liquidity, "pm: liquidity");
            amount0 = (uint256(p.principal0) * liquidity) / p.liquidity;
            amount1 = (uint256(p.principal1) * liquidity) / p.liquidity;
            p.principal0 -= uint128(amount0);
            p.principal1 -= uint128(amount1);
            p.liquidity -= uint128(liquidity);
        }
        require(amount0 >= amount0Min && amount1 >= amount1Min, "pm: slippage");
        pendingKey = p.key;
        pendingTake0 += amount0;
        pendingTake1 += amount1;
    }

    function _handleBurn(bytes memory param) internal {
        (uint256 tokenId, uint128 amount0Min, uint128 amount1Min, ) = abi.decode(
            param,
            (uint256, uint128, uint128, bytes)
        );
        Position storage p = positionsData[tokenId];
        require(p.exists, "pm: unknown token");
        // BURN auto-decreases all remaining liquidity; any unclaimed fees ride
        // along in the final delta (the handler harvests them beforehand).
        uint256 amount0 = uint256(p.principal0) + p.owed0;
        uint256 amount1 = uint256(p.principal1) + p.owed1;
        require(amount0 >= amount0Min && amount1 >= amount1Min, "pm: slippage");
        pendingKey = p.key;
        pendingTake0 += amount0;
        pendingTake1 += amount1;
        delete positionsData[tokenId];
    }

    function _handleTakePair(bytes memory param) internal {
        (address currency0, address currency1, address recipient) = abi.decode(param, (address, address, address));
        uint256 amount0 = pendingTake0;
        uint256 amount1 = pendingTake1;
        pendingTake0 = 0;
        pendingTake1 = 0;
        if (amount0 > 0) {
            if (currency0 == address(0)) {
                (bool sent, ) = recipient.call{value: amount0}("");
                require(sent, "pm: take send");
            } else {
                require(IERC20(currency0).transfer(recipient, amount0), "pm: take0");
            }
        }
        if (amount1 > 0) {
            require(IERC20(currency1).transfer(recipient, amount1), "pm: take1");
        }
    }
}

/// @notice UniversalRouter V4_SWAP stub: decodes the handler's on-chain-built
///         exact-input-single plan, pulls the input (ERC20 via MockPermit2,
///         native via call value) and pays a configurable output to the
///         caller. `output == 0` drives the SwapFailed branch.
contract MockUniversalRouter {
    MockPermit2 public immutable PERMIT2;

    uint256 public output;
    mapping(address => uint256) public outputFor;
    bool public enforceMinOut;
    /// @dev Last min-out the plan actually carried — what a TWAP-floored
    ///      handler is supposed to have raised it to.
    uint256 public lastAmountOutMinimum;
    uint256 public lastAmountIn;

    constructor(MockPermit2 _permit2) {
        PERMIT2 = _permit2;
    }

    receive() external payable {}

    function setOutput(uint256 newOutput) external {
        output = newOutput;
    }

    function setOutputFor(address tokenOut, uint256 newOutput) external {
        outputFor[tokenOut] = newOutput;
    }

    function setEnforceMinOut(bool value) external {
        enforceMinOut = value;
    }

    function execute(bytes calldata commands, bytes[] calldata inputs, uint256 deadline) external payable {
        require(block.timestamp <= deadline, "ur: deadline");
        require(commands.length == 1 && uint8(commands[0]) == 0x10, "ur: not V4_SWAP");
        (bytes memory actions, bytes[] memory params) = abi.decode(inputs[0], (bytes, bytes[]));
        require(actions.length == 3, "ur: plan shape");
        require(uint8(actions[0]) == V4Actions.SWAP_EXACT_IN_SINGLE, "ur: action0");
        require(uint8(actions[1]) == V4Actions.SETTLE_ALL, "ur: action1");
        require(uint8(actions[2]) == V4Actions.TAKE_ALL, "ur: action2");

        ExactInputSingleParams memory swap = abi.decode(params[0], (ExactInputSingleParams));
        (address settleCurrency, uint256 settleAmount) = abi.decode(params[1], (address, uint256));
        (address takeCurrency, uint256 takeMin) = abi.decode(params[2], (address, uint256));

        address tokenIn = swap.zeroForOne ? swap.poolKey.currency0 : swap.poolKey.currency1;
        address tokenOut = swap.zeroForOne ? swap.poolKey.currency1 : swap.poolKey.currency0;
        require(settleCurrency == tokenIn && takeCurrency == tokenOut, "ur: currency mismatch");
        require(settleAmount == swap.amountIn, "ur: settle amount");

        if (tokenIn == address(0)) {
            require(msg.value == swap.amountIn, "ur: value");
        } else {
            PERMIT2.transferFrom(msg.sender, address(this), uint160(uint256(swap.amountIn)), tokenIn);
        }

        lastAmountOutMinimum = swap.amountOutMinimum;
        lastAmountIn = swap.amountIn;
        uint256 amountOut = outputFor[tokenOut] != 0 ? outputFor[tokenOut] : output;
        if (enforceMinOut) {
            require(amountOut >= takeMin && amountOut >= swap.amountOutMinimum, "ur: too little received");
        }
        if (amountOut > 0) {
            if (tokenOut == address(0)) {
                (bool sent, ) = msg.sender.call{value: amountOut}("");
                require(sent, "ur: send");
            } else {
                require(IERC20(tokenOut).transfer(msg.sender, amountOut), "ur: transfer");
            }
        }
    }
}
