// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {MockERC20} from "./RatehopperMocks.sol";
import {IUniswapV3FlashCallback} from "@uniswap/v3-core/contracts/interfaces/callback/IUniswapV3FlashCallback.sol";
import {CollateralAsset} from "../common/Types.sol";

/// @dev Test-only flash lender installed at the canonical CREATE2 pool address.
///      A fee of exactly one 6-decimal unit isolates PRINCIPAL rounding: the
///      fee conversion cannot accidentally compensate for a truncated principal.
contract MockDebtRoundingFlashPool {
    address public immutable token0;
    address public immutable token1;
    uint24 public constant fee = 500;
    uint256 public constant FLASH_FEE = 1e12;

    constructor(address token0_, address token1_) {
        token0 = token0_;
        token1 = token1_;
    }

    function flash(address recipient, uint256 amount0, uint256 amount1, bytes calldata data) external {
        require((amount0 == 0) != (amount1 == 0), "one flash asset");
        MockERC20 token = MockERC20(amount0 > 0 ? token0 : token1);
        uint256 beforeBalance = token.balanceOf(address(this));
        token.transfer(recipient, amount0 + amount1);
        IUniswapV3FlashCallback(recipient).uniswapV3FlashCallback(
            amount0 > 0 ? FLASH_FEE : 0,
            amount1 > 0 ? FLASH_FEE : 0,
            data
        );
        require(token.balanceOf(address(this)) == beforeBalance + FLASH_FEE, "flash repayment");
    }
}

/// @dev Stateless delegatecall stub: consume the entire source repayment and
///      mint exactly the requested destination borrow. No pre-existing manager
///      balance may hide an undersized swap.
contract MockDebtRoundingHandler {
    address private immutable repaymentSink;

    event Borrowed(address asset, uint256 amount);

    constructor(address repaymentSink_) {
        repaymentSink = repaymentSink_;
    }

    function switchFrom(address asset, uint256 amount, address, CollateralAsset[] calldata, bytes calldata) external {
        MockERC20(asset).transfer(repaymentSink, amount);
    }

    function switchTo(address asset, uint256 amount, address, CollateralAsset[] calldata, bytes calldata) external {
        MockERC20(asset).mint(address(this), amount);
        emit Borrowed(asset, amount);
    }
}

/// @dev Deterministic 1:1 whole-token exchange between 6 and 18 decimals.
///      Consume the manager's actual approval, so swapData cannot supply a
///      separately computed input amount that bypasses the conversion under test.
contract MockDebtRoundingSwap {
    event Swapped(uint256 amountIn, uint256 amountOut);

    function swap(MockERC20 src, MockERC20 dst) external {
        uint256 amountIn = src.allowance(msg.sender, address(this));
        src.transferFrom(msg.sender, address(this), amountIn);
        uint256 amountOut = amountIn * 1e12;
        dst.mint(msg.sender, amountOut);
        emit Swapped(amountIn, amountOut);
    }
}
