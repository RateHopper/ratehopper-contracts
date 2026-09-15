/**
 * Exact integer tick and liquidity math for building LP transactions.
 *
 * Every value here is a bigint end to end. Nothing is routed through a
 * JavaScript `number`: sqrt prices are 160-bit, liquidity is 128-bit and token
 * amounts are 256-bit, so a single `Number(...)` or `Math.pow` would silently
 * round the very quantity a transaction minimum is meant to pin. `test/scripts/
 * lpMath.ts` diffs these functions against the pinned Uniswap libraries
 * (TickMath, LiquidityAmounts, SqrtPriceMath) through `LpMathProbe`.
 *
 * Tick indices ARE plain numbers — they are small signed integers, exact in a
 * double, and that is how the contracts' ABI takes them.
 */

export const Q96 = 1n << 96n;
export const MIN_TICK = -887272;
export const MAX_TICK = 887272;
export const BPS = 10_000n;

/// Q128.128 multipliers of the canonical Uniswap TickMath, indexed by the bit
/// of |tick| they correspond to.
const TICK_RATIOS: readonly bigint[] = [
    0xfffcb933bd6fad37aa2d162d1a594001n,
    0xfff97272373d413259a46990580e213an,
    0xfff2e50f5f656932ef12357cf3c7fdccn,
    0xffe5caca7e10e4e61c3624eaa0941cd0n,
    0xffcb9843d60f6159c9db58835c926644n,
    0xff973b41fa98c081472e6896dfb254c0n,
    0xff2ea16466c96a3843ec78b326b52861n,
    0xfe5dee046a99a2a811c461f1969c3053n,
    0xfcbe86c7900a88aedcffc83b479aa3a4n,
    0xf987a7253ac413176f2b074cf7815e54n,
    0xf3392b0822b70005940c7a398e4b70f3n,
    0xe7159475a2c29b7443b29c7fa6e889d9n,
    0xd097f3bdfd2022b8845ad8f792aa5825n,
    0xa9f746462d870fdf8a65dc1f90e061e5n,
    0x70d869a156d2a1b890bb3df62baf32f7n,
    0x31be135f97d08fd981231505542fcfa6n,
    0x9aa508b5b7a84e1c677de54f3e99bc9n,
    0x5d6af8dedb81196699c329225ee604n,
    0x2216e584f5fa1ea926041bedfe98n,
    0x48a170391f7dc42444e8fa2n,
];

const MAX_UINT256 = (1n << 256n) - 1n;
const MAX_UINT128 = (1n << 128n) - 1n;

/// Liquidity is uint128 on-chain, and the Uniswap libraries revert on overflow.
/// Producing an unrepresentable number here would hand the caller a minimum the
/// position manager could never satisfy, so refuse it at the same boundary.
function toUint128(value: bigint): bigint {
    if (value > MAX_UINT128) throw new Error(`liquidity overflows uint128: ${value}`);
    return value;
}

/// Uniswap `TickMath.getSqrtRatioAtTick`, bit for bit.
export function getSqrtRatioAtTick(tick: number): bigint {
    if (!Number.isInteger(tick)) throw new Error(`tick must be an integer: ${tick}`);
    if (tick < MIN_TICK || tick > MAX_TICK) throw new Error(`tick out of range: ${tick}`);

    const absTick = BigInt(Math.abs(tick));
    let ratio = (absTick & 0x1n) !== 0n ? TICK_RATIOS[0] : 1n << 128n;
    for (let i = 1; i < TICK_RATIOS.length; i++) {
        if ((absTick & (1n << BigInt(i))) !== 0n) ratio = (ratio * TICK_RATIOS[i]) >> 128n;
    }
    if (tick > 0) ratio = MAX_UINT256 / ratio;

    // Q128.128 -> Q128.96, rounding up, exactly as the library does.
    return (ratio >> 32n) + (ratio % (1n << 32n) === 0n ? 0n : 1n);
}

/// Largest multiple of `spacing` at or below `tick` (floors toward -infinity,
/// so a negative tick widens outward rather than snapping inward).
export function alignTick(tick: number, spacing: number): number {
    if (spacing <= 0) throw new Error(`spacing must be positive: ${spacing}`);
    return Math.floor(tick / spacing) * spacing;
}

function sortPrices(a: bigint, b: bigint): [bigint, bigint] {
    return a > b ? [b, a] : [a, b];
}

export function getLiquidityForAmount0(sqrtA: bigint, sqrtB: bigint, amount0: bigint): bigint {
    const [lo, hi] = sortPrices(sqrtA, sqrtB);
    if (hi === lo) return 0n;
    const intermediate = (lo * hi) / Q96;
    return toUint128((amount0 * intermediate) / (hi - lo));
}

export function getLiquidityForAmount1(sqrtA: bigint, sqrtB: bigint, amount1: bigint): bigint {
    const [lo, hi] = sortPrices(sqrtA, sqrtB);
    if (hi === lo) return 0n;
    return toUint128((amount1 * Q96) / (hi - lo));
}

/// Liquidity that `amount0`/`amount1` can actually fund — the SMALLER of the
/// two sides in range, which is what the position manager will mint.
export function getLiquidityForAmounts(
    sqrtPriceX96: bigint,
    sqrtA: bigint,
    sqrtB: bigint,
    amount0: bigint,
    amount1: bigint,
): bigint {
    const [lo, hi] = sortPrices(sqrtA, sqrtB);
    if (sqrtPriceX96 <= lo) return getLiquidityForAmount0(lo, hi, amount0);
    if (sqrtPriceX96 < hi) {
        const liquidity0 = getLiquidityForAmount0(sqrtPriceX96, hi, amount0);
        const liquidity1 = getLiquidityForAmount1(lo, sqrtPriceX96, amount1);
        return liquidity0 < liquidity1 ? liquidity0 : liquidity1;
    }
    return getLiquidityForAmount1(lo, hi, amount1);
}

export function getAmount0ForLiquidity(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
    const [lo, hi] = sortPrices(sqrtA, sqrtB);
    if (lo === 0n) throw new Error("sqrt price cannot be zero");
    return ((liquidity << 96n) * (hi - lo)) / hi / lo;
}

export function getAmount1ForLiquidity(sqrtA: bigint, sqrtB: bigint, liquidity: bigint): bigint {
    const [lo, hi] = sortPrices(sqrtA, sqrtB);
    return (liquidity * (hi - lo)) / Q96;
}

/// Token amounts a position of `liquidity` holds at `sqrtPriceX96`. Below the
/// range it is all token0, above it all token1 — which is why a minimum on the
/// unused side must be zero rather than "small".
export function getAmountsForLiquidity(
    sqrtPriceX96: bigint,
    sqrtA: bigint,
    sqrtB: bigint,
    liquidity: bigint,
): { amount0: bigint; amount1: bigint } {
    const [lo, hi] = sortPrices(sqrtA, sqrtB);
    if (sqrtPriceX96 <= lo) return { amount0: getAmount0ForLiquidity(lo, hi, liquidity), amount1: 0n };
    if (sqrtPriceX96 < hi) {
        return {
            amount0: getAmount0ForLiquidity(sqrtPriceX96, hi, liquidity),
            amount1: getAmount1ForLiquidity(lo, sqrtPriceX96, liquidity),
        };
    }
    return { amount0: 0n, amount1: getAmount1ForLiquidity(lo, hi, liquidity) };
}

function applySlippage(amount: bigint, slippageBps: bigint): bigint {
    if (slippageBps < 0n || slippageBps >= BPS) throw new Error(`slippageBps out of range: ${slippageBps}`);
    return (amount * (BPS - slippageBps)) / BPS;
}

export interface RangeAtPrice {
    sqrtPriceX96: bigint;
    tickLower: number;
    tickUpper: number;
}

/**
 * Floors for `mintAmount0Min` / `mintAmount1Min`.
 *
 * The mint consumes the two sides in the ratio the range demands, so the
 * binding constraint is the side that funds the LESS liquidity; the other side
 * is only partly consumed. Deriving the minima from that liquidity — rather
 * than from the desired amounts — is what keeps them achievable: a minimum
 * above what the mint can consume would revert every honest transaction.
 * A side the range cannot consume at the current price comes back as zero,
 * because any positive floor there is unsatisfiable.
 */
export function mintMinimums(
    range: RangeAtPrice,
    amount0Desired: bigint,
    amount1Desired: bigint,
    slippageBps: bigint,
): { amount0Min: bigint; amount1Min: bigint; liquidity: bigint; expected0: bigint; expected1: bigint } {
    const sqrtA = getSqrtRatioAtTick(range.tickLower);
    const sqrtB = getSqrtRatioAtTick(range.tickUpper);
    const liquidity = getLiquidityForAmounts(range.sqrtPriceX96, sqrtA, sqrtB, amount0Desired, amount1Desired);
    const { amount0: expected0, amount1: expected1 } = getAmountsForLiquidity(
        range.sqrtPriceX96,
        sqrtA,
        sqrtB,
        liquidity,
    );
    return {
        amount0Min: applySlippage(expected0, slippageBps),
        amount1Min: applySlippage(expected1, slippageBps),
        liquidity,
        expected0,
        expected1,
    };
}

/**
 * Floors for `decreaseAmount0Min` / `decreaseAmount1Min`.
 *
 * `exitBps` prorates the liquidity first, so a partial close is bounded by what
 * that fraction actually holds instead of by the whole position. As with the
 * mint, a side the position does not hold at the current price yields zero.
 */
export function decreaseMinimums(
    range: RangeAtPrice,
    liquidity: bigint,
    exitBps: bigint,
    slippageBps: bigint,
): { amount0Min: bigint; amount1Min: bigint; liquidityRemoved: bigint; expected0: bigint; expected1: bigint } {
    if (exitBps <= 0n || exitBps > BPS) throw new Error(`exitBps out of range: ${exitBps}`);
    const sqrtA = getSqrtRatioAtTick(range.tickLower);
    const sqrtB = getSqrtRatioAtTick(range.tickUpper);
    const liquidityRemoved = (liquidity * exitBps) / BPS;
    const { amount0: expected0, amount1: expected1 } = getAmountsForLiquidity(
        range.sqrtPriceX96,
        sqrtA,
        sqrtB,
        liquidityRemoved,
    );
    return {
        amount0Min: applySlippage(expected0, slippageBps),
        amount1Min: applySlippage(expected1, slippageBps),
        liquidityRemoved,
        expected0,
        expected1,
    };
}

/**
 * Mint floors for the destination leg of an in-kind switch.
 *
 * The switch feeds the mint whatever the withdrawal delivered, and the smallest
 * withdrawal the transaction will accept is exactly the decrease minima. Sizing
 * the mint floors from that worst accepted budget — not from the expected
 * withdrawal — is what stops a transaction that satisfied the withdraw leg from
 * reverting on the open leg. Anything the withdrawal delivers above the budget
 * (collected fees, favourable rounding) only makes the mint easier to satisfy.
 */
export function switchMintMinimums(
    destination: RangeAtPrice,
    decreaseAmount0Min: bigint,
    decreaseAmount1Min: bigint,
    slippageBps: bigint,
): { amount0Min: bigint; amount1Min: bigint } {
    const { amount0Min, amount1Min } = mintMinimums(destination, decreaseAmount0Min, decreaseAmount1Min, slippageBps);
    return { amount0Min, amount1Min };
}
