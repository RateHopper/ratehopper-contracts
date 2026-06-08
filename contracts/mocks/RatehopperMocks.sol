// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {INonfungiblePositionManager} from "../interfaces/uniswapV3/INonfungiblePositionManager.sol";

// ─────────────────────────────────────────────────────────────────────────
//  Mocks for RatehopperUniV3Positions unit/branch-coverage tests.
//
//  These let the full openLp / closeLp / collectLp lifecycle — and every
//  defensive revert branch — run deterministically on a plain Hardhat network
//  WITHOUT a forked Base mainnet, a real Gnosis Safe, or live Uniswap V3
//  contracts. They are TEST-ONLY and never deployed to production.
// ─────────────────────────────────────────────────────────────────────────

/// @notice Minimal mintable ERC20. `falseTransferTo` makes `transfer` return
///         `false` (without reverting) for a single recipient — used to drive
///         the non-reverting `transfer-returns-false` branch in
///         `_chargeCollectFee`.
contract MockERC20 is IERC20 {
    string public name;
    string public symbol;
    uint8 public immutable decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    address public falseTransferTo;
    address public revertTransferTo;

    constructor(string memory _name, string memory _symbol, uint8 _decimals) {
        name = _name;
        symbol = _symbol;
        decimals = _decimals;
    }

    function setFalseTransferTo(address account) external {
        falseTransferTo = account;
    }

    function setRevertTransferTo(address account) external {
        revertTransferTo = account;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        // Simulate a token that reverts for a blacklisted destination (e.g.
        // Circle USDC) — drives the revert/catch fee branches.
        require(to != revertTransferTo, "blacklisted");
        // Simulate a non-compliant token that silently returns false for a
        // blacklisted destination instead of reverting.
        if (to == falseTransferTo) return false;
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) {
            require(allowed >= amount, "ERC20: allowance");
            allowance[from][msg.sender] = allowed - amount;
        }
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "ERC20: balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @notice Stand-in for `IProtocolRegistry` exposing only `safeOperator`.
contract MockRegistry {
    address public safeOperator;

    function setOperator(address operator) external {
        safeOperator = operator;
    }
}

/// @notice Minimal Safe module executor. Mirrors
///         `execTransactionFromModuleReturnData` by performing the inner call
///         and bubbling up `(success, returndata)`. Per-target failure modes
///         let tests exercise the `ModuleCallFailed` (typed) and revert-bubble
///         branches of `_safeApprove` / `_safeExec` / `_safeMintLp`.
contract MockSafeHarness {
    // 0 = execute normally, 1 = fail with empty returndata, 2 = fail with `failData`.
    mapping(address => uint8) public failMode;
    bytes public failData;

    receive() external payable {}

    function setFail(address target, uint8 mode) external {
        failMode[target] = mode;
    }

    function setFailData(bytes calldata data) external {
        failData = data;
    }

    function execTransactionFromModuleReturnData(
        address to,
        uint256 value,
        bytes memory data,
        uint8 /* operation */
    ) external returns (bool success, bytes memory returnData) {
        uint8 mode = failMode[to];
        if (mode == 1) return (false, "");
        if (mode == 2) return (false, failData);
        (success, returnData) = to.call{value: value}(data);
    }
}

/// @notice Mirrors SwapRouter02's `exactInputSingle` selector (0x04e45aaf).
///         Pulls `amountIn` of `tokenIn` from the caller (the Safe) and pays a
///         configurable `output` of `tokenOut` to the recipient. `output == 0`
///         drives the `SwapFailed` branch.
contract MockSwapRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    uint256 public output;
    bool public pullInput = true;

    function setOutput(uint256 newOutput) external {
        output = newOutput;
    }

    function setPullInput(bool enabled) external {
        pullInput = enabled;
    }

    function exactInputSingle(ExactInputSingleParams calldata params) external payable returns (uint256 amountOut) {
        if (pullInput && params.amountIn > 0) {
            IERC20(params.tokenIn).transferFrom(msg.sender, address(this), params.amountIn);
        }
        amountOut = output;
        if (amountOut > 0) {
            IERC20(params.tokenOut).transfer(params.recipient, amountOut);
        }
    }
}

/// @notice Configurable Uniswap V3 pool stub for `_validatePool`.
contract MockUniswapV3Pool {
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

    function slot0() external view returns (uint160, int24, uint16, uint16, uint16, uint8, bool) {
        return (sqrtPriceX96, 0, 0, 0, 0, 0, true);
    }
}

/// @notice Factory stub returning a single configurable pool for any lookup.
contract MockUniswapV3Factory {
    address public pool;

    function setPool(address newPool) external {
        pool = newPool;
    }

    function getPool(address, address, uint24) external view returns (address) {
        return pool;
    }
}

/// @notice Faithful-enough Nonfungible Position Manager: tracks per-tokenId
///         owner / pair / liquidity / principal / owed, and implements
///         mint / positions / ownerOf / collect / decreaseLiquidity / burn so
///         the full LP lifecycle can be driven on a plain network.
contract MockNonfungiblePositionManager {
    struct Position {
        address owner;
        address token0;
        address token1;
        uint24 fee;
        uint128 liquidity;
        uint128 owed0;
        uint128 owed1;
        uint128 principal0;
        uint128 principal1;
        bool exists;
    }

    mapping(uint256 => Position) public positionsData;
    uint256 public nextId = 1;

    // Config applied to the next `mint`.
    uint128 public mintLiquidity = 1_000_000;
    address public mintOwnerOverride;
    bool public pullOnMint = true;

    function setMintLiquidity(uint128 value) external {
        mintLiquidity = value;
    }

    function setMintOwnerOverride(address account) external {
        mintOwnerOverride = account;
    }

    function setPullOnMint(bool enabled) external {
        pullOnMint = enabled;
    }

    /// @dev Seed a position directly (for collectLp/closeLp tests that bypass
    ///      openLp via a storage-overridden basis).
    function seedPosition(
        uint256 tokenId,
        address owner,
        address token0,
        address token1,
        uint24 fee,
        uint128 liquidity,
        uint128 principal0,
        uint128 principal1
    ) external {
        positionsData[tokenId] = Position(owner, token0, token1, fee, liquidity, 0, 0, principal0, principal1, true);
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
        INonfungiblePositionManager.MintParams calldata params
    ) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1) {
        tokenId = nextId++;
        amount0 = params.amount0Desired;
        amount1 = params.amount1Desired;
        if (pullOnMint) {
            if (amount0 > 0) IERC20(params.token0).transferFrom(msg.sender, address(this), amount0);
            if (amount1 > 0) IERC20(params.token1).transferFrom(msg.sender, address(this), amount1);
        }
        liquidity = mintLiquidity;
        address owner = mintOwnerOverride == address(0) ? params.recipient : mintOwnerOverride;
        positionsData[tokenId] = Position(
            owner,
            params.token0,
            params.token1,
            params.fee,
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
        returns (uint96, address, address, address, uint24, int24, int24, uint128, uint256, uint256, uint128, uint128)
    {
        Position memory p = positionsData[tokenId];
        return (0, address(0), p.token0, p.token1, p.fee, int24(0), int24(0), p.liquidity, 0, 0, p.owed0, p.owed1);
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        return positionsData[tokenId].owner;
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

/// @notice Minimal ERC721 for the `rescueERC721` happy path.
contract MockERC721 {
    mapping(uint256 => address) public ownerOf;

    function mint(address to, uint256 tokenId) external {
        ownerOf[tokenId] = to;
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        require(ownerOf[tokenId] == from, "not owner");
        ownerOf[tokenId] = to;
    }
}
