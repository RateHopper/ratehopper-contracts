// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISSRRateProvider} from "../interfaces/spark/ISSRRateProvider.sol";
import {IIdleSavingsRateProvider} from "../yield/idleSavings/IIdleSavingsRateProvider.sol";
import {OpenLpInKindParams, WithdrawLpParams} from "../interfaces/IYieldHandler.sol";
import {BaseIdleSavingsHandler} from "../yield/handlers/BaseIdleSavingsHandler.sol";

// ─────────────────────────────────────────────────────────────────────────
//  Mocks for the idle savings handler stack (BaseIdleSavingsHandler,
//  SkyIdleSavingsYieldHandler, ChainlinkSsrRateProvider) unit and invariant
//  suites. They let the full deposit / redeem / rollover lifecycle and every
//  defensive revert branch run deterministically without Base, PSM3 or the
//  live oracles. TEST-ONLY, never deployed.
// ─────────────────────────────────────────────────────────────────────────

/// @notice Chainlink AggregatorV3 stand-in. `answeredInRound` and `roundId`
///         are settable independently so the provider's "only updatedAt
///         governs staleness" rule can be proven.
contract MockAggregatorV3 {
    uint8 public decimals = 18;
    int256 public answer;
    uint256 public updatedAt;
    uint80 public roundId;
    uint80 public answeredInRound;
    bool public reverting;

    function set(int256 _answer, uint256 _updatedAt) external {
        answer = _answer;
        updatedAt = _updatedAt;
    }

    function setRound(uint80 _roundId, uint80 _answeredInRound) external {
        roundId = _roundId;
        answeredInRound = _answeredInRound;
    }

    function setDecimals(uint8 value) external {
        decimals = value;
    }

    function setReverting(bool value) external {
        reverting = value;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!reverting, "feed down");
        return (roundId, answer, updatedAt, updatedAt, answeredInRound);
    }
}

/// @notice Spark SSRAuthOracle stand-in: the 27-decimal conversion rate PSM3
///         prices with.
contract MockSSRRateProvider {
    uint256 public conversionRate;
    bool public reverting;

    function set(uint256 rate27) external {
        conversionRate = rate27;
    }

    function setReverting(bool value) external {
        reverting = value;
    }

    function getConversionRate() external view returns (uint256) {
        require(!reverting, "ssr down");
        return conversionRate;
    }
}

/// @notice Reads a provider inside a mined transaction so a test can pin the
///         block timestamp the staleness check sees.
contract MockRateProbe {
    event Rate(uint256 rate);

    function read(address provider, address token) external {
        emit Rate(IIdleSavingsRateProvider(provider).rate(token));
    }
}

/// @notice Circle FiatToken-shaped USDC: the real revert strings a drained PSM3
///         pocket surfaces ("ERC20: transfer amount exceeds balance"), so the
///         inner-revert bubbling the backend classifier relies on is exercised.
///         `burn` lets a test drain the pocket.
contract MockFiatTokenUsdc is IERC20 {
    string public constant name = "USD Coin";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function burn(address from, uint256 amount) external {
        require(amount <= balanceOf[from], "burn exceeds balance");
        balanceOf[from] -= amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        require(amount <= allowance[from][msg.sender], "ERC20: transfer amount exceeds allowance");
        allowance[from][msg.sender] -= amount;
        _transfer(from, to, amount);
        return true;
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(amount <= balanceOf[from], "ERC20: transfer amount exceeds balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// @notice Spark PSM3 stand-in with the real semantics that matter: prices
///         from `rateProvider().getConversionRate()` (27 decimals), rounds the
///         output down, enforces `minAmountOut` with the real revert string,
///         pulls `amountIn` from the caller, pays USDC out of the pocket (the
///         PSM itself) and sUSDS out of its own balance, and emits `Swap` with
///         the referral code. `setReverting` makes every call fail, for the
///         exit-liveness and rollover cases.
contract MockPSM3 {
    address public immutable usdc;
    address public immutable susds;
    address public immutable rateProvider;
    bool public reverting;

    event Swap(
        address indexed assetIn,
        address indexed assetOut,
        address sender,
        address indexed receiver,
        uint256 amountIn,
        uint256 amountOut,
        uint256 referralCode
    );

    constructor(address _usdc, address _susds, address _rateProvider) {
        usdc = _usdc;
        susds = _susds;
        rateProvider = _rateProvider;
    }

    function setReverting(bool value) external {
        reverting = value;
    }

    function pocket() external view returns (address) {
        return address(this);
    }

    function previewSwapExactIn(address assetIn, address assetOut, uint256 amountIn) public view returns (uint256) {
        require(!reverting, "PSM3/down");
        uint256 rate = ISSRRateProvider(rateProvider).getConversionRate();
        if (assetIn == usdc && assetOut == susds) return (amountIn * 1e12 * 1e27) / rate;
        if (assetIn == susds && assetOut == usdc) return (amountIn * rate) / 1e27 / 1e12;
        revert("PSM3/invalid-asset");
    }

    function swapExactIn(
        address assetIn,
        address assetOut,
        uint256 amountIn,
        uint256 minAmountOut,
        address receiver,
        uint256 referralCode
    ) external returns (uint256 amountOut) {
        require(!reverting, "PSM3/down");
        require(amountIn != 0, "PSM3/invalid-amountIn");
        require(receiver != address(0), "PSM3/invalid-receiver");
        amountOut = previewSwapExactIn(assetIn, assetOut, amountIn);
        require(amountOut >= minAmountOut, "PSM3/amountOut-too-low");
        IERC20(assetIn).transferFrom(msg.sender, address(this), amountIn);
        IERC20(assetOut).transfer(receiver, amountOut);
        emit Swap(assetIn, assetOut, msg.sender, receiver, amountIn, amountOut, referralCode);
    }
}

/// @notice A protocol-3-shaped build whose rollover leg adopts one share less
///         than the old build released. The manager then sees a one-share
///         residue it has to value, and `TwapNotConfigured(sUSDS)` from
///         `_settleSwitchResidue` is the backstop against an under-adopting
///         build. Only the surface `setYieldHandler` and the switch open leg
///         touch is implemented.
contract MockUnderAdoptingYieldHandler {
    uint8 public immutable PROTOCOL;
    address public immutable usdc;

    constructor(uint8 _protocol, address _usdc) {
        PROTOCOL = _protocol;
        usdc = _usdc;
    }

    function poolTokens(bytes calldata) external view returns (address, address) {
        return (usdc, usdc);
    }

    function poolParamHasHooks(bytes calldata) external pure returns (bool) {
        return false;
    }

    function openLpInKind(OpenLpInKindParams calldata p) external pure returns (uint256, uint128, uint128) {
        return (uint256(uint160(p.onBehalfOf)), 0, uint128(p.amount1 - 1));
    }
}

/// @notice Rate provider with no oracle logic, for proving BaseIdleSavingsHandler
///         behaviour in isolation from ChainlinkSsrRateProvider.
contract MockIdleSavingsRateProvider is IIdleSavingsRateProvider {
    address public immutable token;
    uint256 public rate18;
    bool public reverting;

    error WrongShareToken(address token);

    constructor(address _token) {
        token = _token;
    }

    function set(uint256 _rate18) external {
        rate18 = _rate18;
    }

    function setReverting(bool value) external {
        reverting = value;
    }

    function rate(address shareToken_) external view returns (uint256) {
        require(!reverting, "provider down");
        if (shareToken_ != token) revert WrongShareToken(shareToken_);
        return rate18;
    }

    function shareToken() external view returns (address) {
        return token;
    }
}

interface IMintableShare {
    function mint(address to, uint256 amount) external;
}

/// @notice A trivial idle savings venue: deposit mints shares at a settable
///         rate, redeem pays USDC at that rate and can be told to short-pay
///         (ignoring the minimum, the way a vault with a withdrawal fee might)
///         or to revert.
contract MockIdleSavingsVenue {
    IERC20 public immutable usdc;
    IERC20 public immutable share;
    uint256 public rate18;
    uint256 public shortPay;
    bool public reverting;

    constructor(IERC20 _usdc, IERC20 _share) {
        usdc = _usdc;
        share = _share;
    }

    function setRate(uint256 _rate18) external {
        rate18 = _rate18;
    }

    function setShortPay(uint256 usdc6) external {
        shortPay = usdc6;
    }

    function setReverting(bool value) external {
        reverting = value;
    }

    function deposit(uint256 usdc6, uint256 minShares, address receiver) external returns (uint256 shares) {
        require(!reverting, "venue down");
        shares = (usdc6 * 1e12 * 1e18) / rate18;
        require(shares >= minShares, "venue/too-few-shares");
        usdc.transferFrom(msg.sender, address(this), usdc6);
        IMintableShare(address(share)).mint(receiver, shares);
    }

    function redeem(uint256 shares, uint256 minUsdc6, address receiver) external returns (uint256 usdc6) {
        require(!reverting, "venue down");
        usdc6 = (shares * rate18) / 1e30;
        usdc6 = shortPay >= usdc6 ? 0 : usdc6 - shortPay;
        if (shortPay == 0) require(usdc6 >= minUsdc6, "venue/too-little-usdc");
        share.transferFrom(msg.sender, address(this), shares);
        usdc.transfer(receiver, usdc6);
    }
}

/// @notice A second concrete idle savings source (protocol id 250) over the
///         mock venue, proving the base is generic: every base case runs
///         against it as well as against the Sky source. Step codes 90 to 95.
contract MockIdleSavingsSource is BaseIdleSavingsHandler {
    MockIdleSavingsVenue public immutable VENUE;
    IERC20 public immutable SHARE;

    constructor(
        IERC20 _usdc,
        IIdleSavingsRateProvider _rateProvider,
        uint16 _maxToleranceBps,
        uint16 _maxExposureBps,
        MockIdleSavingsVenue _venue,
        IERC20 _share
    ) BaseIdleSavingsHandler(250, _usdc, _rateProvider, _share, _maxToleranceBps, _maxExposureBps) {
        VENUE = _venue;
        SHARE = _share;
    }

    function _shareToken() internal view override returns (IERC20) {
        return SHARE;
    }

    function _poolParamMatches(bytes memory lpPoolParam) internal view override returns (bool) {
        (address venue, address share) = abi.decode(lpPoolParam, (address, address));
        return venue == address(VENUE) && share == address(SHARE);
    }

    function _depositUsdc(address safe, uint256 usdc6, uint256 minShares) internal override {
        _safeApprove(safe, address(USDC), address(VENUE), usdc6, 90);
        _safeExec(safe, address(VENUE), abi.encodeCall(MockIdleSavingsVenue.deposit, (usdc6, minShares, safe)), 91);
        _safeApprove(safe, address(USDC), address(VENUE), 0, 92);
    }

    function _redeemShares(address safe, uint256 shares, uint256 minUsdc6) internal override {
        _safeApprove(safe, address(SHARE), address(VENUE), shares, 93);
        _safeExec(safe, address(VENUE), abi.encodeCall(MockIdleSavingsVenue.redeem, (shares, minUsdc6, safe)), 94);
        _safeApprove(safe, address(SHARE), address(VENUE), 0, 95);
    }

    function _liquidityAvailable() internal view override returns (uint256) {
        return USDC.balanceOf(address(VENUE));
    }
}

/// @notice A "from" handler for switchLp whose withdraw leg hands the open
///         leg a fixed `(token0, token1, amount0, amount1)` without moving
///         anything, so every operand of the idle savings in-kind shape check
///         can be reached through the manager. Immutables only: it runs via
///         delegatecall and must not touch storage.
contract MockInKindFeederYieldHandler {
    uint8 public immutable PROTOCOL;
    address private immutable token0;
    address private immutable token1;
    uint256 private immutable amount0;
    uint256 private immutable amount1;

    constructor(uint8 _protocol, address _token0, address _token1, uint256 _amount0, uint256 _amount1) {
        PROTOCOL = _protocol;
        token0 = _token0;
        token1 = _token1;
        amount0 = _amount0;
        amount1 = _amount1;
    }

    function withdrawLp(WithdrawLpParams calldata) external view returns (address, address, uint256, uint256) {
        return (token0, token1, amount0, amount1);
    }
}
