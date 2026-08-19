import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import {
    MAX_TICK,
    MIN_TICK,
    alignTick,
    decreaseMinimums,
    getAmountsForLiquidity,
    getLiquidityForAmounts,
    getSqrtRatioAtTick,
    mintMinimums,
    switchMintMinimums,
} from "../../scripts/lpMath";

// ─────────────────────────────────────────────────────────────────────────
//  The operations scripts build transaction minima off these helpers, so the
//  helpers are diffed against the pinned Uniswap libraries themselves
//  (TickMath / LiquidityAmounts / SqrtPriceMath via LpMathProbe) rather than
//  against numbers copied into the test. Everything is bigint end to end: a
//  single Number() would round the exact quantity a minimum exists to pin.
// ─────────────────────────────────────────────────────────────────────────

async function deployProbe() {
    const Probe = await ethers.getContractFactory("LpMathProbe");
    const probe = await Probe.deploy();
    await probe.waitForDeployment();
    return { probe };
}

// WETH/USDC-shaped fixture: 18-decimal token0, 6-decimal token1, price ~4000.
const TICK_SPACING = 10;
const IN_RANGE_TICK = -201_770;
const WETH = 10n ** 18n;
const USDC = 10n ** 6n;

describe("scripts/lpMath", function () {
    describe("getSqrtRatioAtTick vs Uniswap TickMath", function () {
        it("matches the library at the extremes, at zero, and on both signs", async function () {
            const { probe } = await loadFixture(deployProbe);
            const ticks = [
                MIN_TICK,
                MIN_TICK + 1,
                -887_000,
                -201_771,
                -201_770,
                -60,
                -1,
                0,
                1,
                60,
                201_770,
                887_000,
                MAX_TICK - 1,
                MAX_TICK,
            ];
            for (const tick of ticks) {
                expect(getSqrtRatioAtTick(tick), `tick ${tick}`).to.equal(await probe.sqrtPriceAtTick(tick));
            }
        });

        it("matches the library across every power-of-two bit of the tick", async function () {
            const { probe } = await loadFixture(deployProbe);
            // Each bit selects a different Q128.128 multiplier; walking them all
            // is what catches a mistyped constant.
            for (let bit = 0; bit < 20; bit++) {
                const tick = 1 << bit;
                if (tick > MAX_TICK) break;
                expect(getSqrtRatioAtTick(tick), `+2^${bit}`).to.equal(await probe.sqrtPriceAtTick(tick));
                expect(getSqrtRatioAtTick(-tick), `-2^${bit}`).to.equal(await probe.sqrtPriceAtTick(-tick));
            }
        });

        it("rejects a tick outside the representable range", function () {
            expect(() => getSqrtRatioAtTick(MAX_TICK + 1)).to.throw("out of range");
            expect(() => getSqrtRatioAtTick(MIN_TICK - 1)).to.throw("out of range");
        });

        it("floors alignment toward negative infinity so a range only widens", function () {
            expect(alignTick(-201_765, 10)).to.equal(-201_770);
            expect(alignTick(-201_770, 10)).to.equal(-201_770);
            expect(alignTick(201_765, 10)).to.equal(201_760);
            expect(alignTick(-1, 60)).to.equal(-60);
        });
    });

    describe("liquidity conversions vs Uniswap LiquidityAmounts / SqrtPriceMath", function () {
        it("agrees on liquidity-from-amounts and amounts-from-liquidity, in and out of range", async function () {
            const { probe } = await loadFixture(deployProbe);
            const sqrtLower = getSqrtRatioAtTick(IN_RANGE_TICK - 1_000);
            const sqrtUpper = getSqrtRatioAtTick(IN_RANGE_TICK + 1_000);
            const prices = [
                getSqrtRatioAtTick(IN_RANGE_TICK - 5_000), // below the range
                getSqrtRatioAtTick(IN_RANGE_TICK), // in range
                getSqrtRatioAtTick(IN_RANGE_TICK + 5_000), // above the range
            ];

            for (const sqrtPriceX96 of prices) {
                const liquidity = getLiquidityForAmounts(sqrtPriceX96, sqrtLower, sqrtUpper, WETH, 4_000n * USDC);
                expect(liquidity).to.equal(
                    await probe.liquidityForAmounts(sqrtPriceX96, sqrtLower, sqrtUpper, WETH, 4_000n * USDC),
                );

                const ours = getAmountsForLiquidity(sqrtPriceX96, sqrtLower, sqrtUpper, liquidity);
                const [refAmount0, refAmount1] = await probe.amountsForLiquidity(
                    sqrtPriceX96,
                    sqrtLower,
                    sqrtUpper,
                    liquidity,
                );
                expect(ours.amount0).to.equal(refAmount0);
                expect(ours.amount1).to.equal(refAmount1);
            }
        });

        it("keeps full precision on values that would break a JS number", async function () {
            const { probe } = await loadFixture(deployProbe);
            // 1e24 wei is ~1e8 times Number.MAX_SAFE_INTEGER, and the odd tail
            // digits are exactly what a double would drop.
            const sqrtLower = getSqrtRatioAtTick(IN_RANGE_TICK - 1_000);
            const sqrtUpper = getSqrtRatioAtTick(IN_RANGE_TICK + 1_000);
            const sqrtPriceX96 = getSqrtRatioAtTick(IN_RANGE_TICK);
            const huge = 10n ** 24n + 12_345_678_901_234_567n;

            const liquidity = getLiquidityForAmounts(sqrtPriceX96, sqrtLower, sqrtUpper, huge, huge);
            expect(liquidity).to.equal(await probe.liquidityForAmounts(sqrtPriceX96, sqrtLower, sqrtUpper, huge, huge));
            expect(liquidity).to.be.greaterThan(BigInt(Number.MAX_SAFE_INTEGER));

            const ours = getAmountsForLiquidity(sqrtPriceX96, sqrtLower, sqrtUpper, liquidity);
            const [refAmount0, refAmount1] = await probe.amountsForLiquidity(
                sqrtPriceX96,
                sqrtLower,
                sqrtUpper,
                liquidity,
            );
            expect(ours.amount0).to.equal(refAmount0);
            expect(ours.amount1).to.equal(refAmount1);
            expect(ours.amount0).to.be.greaterThan(BigInt(Number.MAX_SAFE_INTEGER));
        });

        it("refuses liquidity that overflows uint128, exactly where the library reverts", async function () {
            const { probe } = await loadFixture(deployProbe);
            // A razor-thin range at the top of the tick space: the liquidity these
            // amounts imply does not fit in uint128. The library reverts, so a
            // helper that returned a number here would be handing out a minimum
            // the position manager could never satisfy.
            const sqrtLower = getSqrtRatioAtTick(MAX_TICK - 2_000);
            const sqrtUpper = getSqrtRatioAtTick(MAX_TICK - 1_000);
            const sqrtPriceX96 = getSqrtRatioAtTick(MAX_TICK - 1_500);
            const huge = 10n ** 24n;

            await expect(probe.liquidityForAmounts(sqrtPriceX96, sqrtLower, sqrtUpper, huge, huge)).to.be.reverted;
            expect(() => getLiquidityForAmounts(sqrtPriceX96, sqrtLower, sqrtUpper, huge, huge)).to.throw(
                "overflows uint128",
            );
        });
    });

    describe("mint minimums", function () {
        const range = (offset: number) => ({
            sqrtPriceX96: getSqrtRatioAtTick(IN_RANGE_TICK + offset),
            tickLower: IN_RANGE_TICK - 1_000,
            tickUpper: IN_RANGE_TICK + 1_000,
        });

        it("returns two nonzero floors in range, each below what the mint consumes", function () {
            const r = range(0);
            const m = mintMinimums(r, WETH, 4_000n * USDC, 100n);
            expect(m.expected0).to.be.greaterThan(0n);
            expect(m.expected1).to.be.greaterThan(0n);
            expect(m.amount0Min).to.be.greaterThan(0n);
            expect(m.amount1Min).to.be.greaterThan(0n);
            expect(m.amount0Min).to.be.lessThan(m.expected0);
            expect(m.amount1Min).to.be.lessThan(m.expected1);
            // 1% slippage, exact integer arithmetic.
            expect(m.amount0Min).to.equal((m.expected0 * 9_900n) / 10_000n);
            expect(m.amount1Min).to.equal((m.expected1 * 9_900n) / 10_000n);
        });

        it("is token0-only below the range", function () {
            const m = mintMinimums(range(-5_000), WETH, 4_000n * USDC, 100n);
            expect(m.amount0Min).to.be.greaterThan(0n);
            expect(m.amount1Min).to.equal(0n);
        });

        it("is token1-only above the range", function () {
            const m = mintMinimums(range(5_000), WETH, 4_000n * USDC, 100n);
            expect(m.amount0Min).to.equal(0n);
            expect(m.amount1Min).to.be.greaterThan(0n);
        });

        it("sizes the floors off the limiting side, so they stay achievable", function () {
            const r = range(0);
            // token1 is starved: the mint can only use the liquidity it funds,
            // so the token0 floor must drop with it rather than track the ask.
            const balanced = mintMinimums(r, WETH, 4_000n * USDC, 100n);
            const starved = mintMinimums(r, WETH, 40n * USDC, 100n);
            expect(starved.liquidity).to.be.lessThan(balanced.liquidity);
            expect(starved.amount0Min).to.be.lessThan(balanced.amount0Min);
            expect(starved.expected0).to.be.lessThan(WETH);
        });

        it("rejects a slippage that would make the floor meaningless", function () {
            expect(() => mintMinimums(range(0), WETH, USDC, 10_000n)).to.throw("slippageBps out of range");
        });
    });

    describe("decrease minimums", function () {
        const LIQUIDITY = 10n ** 15n;
        const range = (offset: number) => ({
            sqrtPriceX96: getSqrtRatioAtTick(IN_RANGE_TICK + offset),
            tickLower: IN_RANGE_TICK - 1_000,
            tickUpper: IN_RANGE_TICK + 1_000,
        });

        it("puts a nonzero floor on every side the position actually holds", function () {
            const d = decreaseMinimums(range(0), LIQUIDITY, 10_000n, 100n);
            expect(d.amount0Min).to.be.greaterThan(0n);
            expect(d.amount1Min).to.be.greaterThan(0n);
            expect(d.amount0Min).to.equal((d.expected0 * 9_900n) / 10_000n);
            expect(d.amount1Min).to.equal((d.expected1 * 9_900n) / 10_000n);
        });

        it("zeroes only the side the position does not hold", function () {
            const below = decreaseMinimums(range(-5_000), LIQUIDITY, 10_000n, 100n);
            expect(below.amount0Min).to.be.greaterThan(0n);
            expect(below.amount1Min).to.equal(0n);

            const above = decreaseMinimums(range(5_000), LIQUIDITY, 10_000n, 100n);
            expect(above.amount0Min).to.equal(0n);
            expect(above.amount1Min).to.be.greaterThan(0n);
        });

        it("prorates a partial close by exitBps only", function () {
            const full = decreaseMinimums(range(0), LIQUIDITY, 10_000n, 100n);
            const half = decreaseMinimums(range(0), LIQUIDITY, 5_000n, 100n);
            expect(half.liquidityRemoved).to.equal(LIQUIDITY / 2n);
            expect(half.expected0).to.be.lessThan(full.expected0);
            expect(half.expected1).to.be.lessThan(full.expected1);
            // Half the liquidity holds half the tokens, to integer rounding.
            expect(full.expected0 - half.expected0 * 2n).to.be.lessThanOrEqual(2n);
            expect(full.expected1 - half.expected1 * 2n).to.be.lessThanOrEqual(2n);
        });

        it("rejects an exitBps outside 1..10000", function () {
            expect(() => decreaseMinimums(range(0), LIQUIDITY, 0n, 100n)).to.throw("exitBps out of range");
            expect(() => decreaseMinimums(range(0), LIQUIDITY, 10_001n, 100n)).to.throw("exitBps out of range");
        });
    });

    describe("encoded transaction parameters", function () {
        // What the scripts actually ship is calldata. These cases assert the
        // helper output survives ABI encoding unchanged, for a position that is
        // in range, below it, and above it.
        const RANGE = { tickLower: IN_RANGE_TICK - 1_000, tickUpper: IN_RANGE_TICK + 1_000 };
        const FIXTURES = [
            { name: "in range", offset: 0 },
            { name: "below range", offset: -5_000 },
            { name: "above range", offset: 5_000 },
        ];

        async function managerInterface() {
            return (await ethers.getContractFactory("SafeYieldManager")).interface;
        }

        for (const fixture of FIXTURES) {
            it(`openLp calldata carries the exact mint minima (${fixture.name})`, async function () {
                const iface = await managerInterface();
                const range = { sqrtPriceX96: getSqrtRatioAtTick(IN_RANGE_TICK + fixture.offset), ...RANGE };
                const mint = mintMinimums(range, WETH, 4_000n * USDC, 100n);

                const data = iface.encodeFunctionData("openLp", [
                    0,
                    {
                        onBehalfOf: ethers.ZeroAddress,
                        usdcAmount: 4_000n * USDC,
                        tickLower: range.tickLower,
                        tickUpper: range.tickUpper,
                        mintAmount0Min: mint.amount0Min,
                        mintAmount1Min: mint.amount1Min,
                        swap0: { amountOutMin: 1n, expectedOut: 1n, poolParam: "0x" },
                        swap1: { amountOutMin: 0n, expectedOut: 0n, poolParam: "0x" },
                        slippageBps: 100,
                        deadline: 1n,
                        lpPoolParam: "0x",
                        stake: false,
                    },
                ]);
                const decoded = iface.decodeFunctionData("openLp", data)[1];
                expect(decoded.mintAmount0Min).to.equal(mint.amount0Min);
                expect(decoded.mintAmount1Min).to.equal(mint.amount1Min);
                // The unused side is zero, the used side is a real floor.
                expect(decoded.mintAmount0Min + decoded.mintAmount1Min).to.be.greaterThan(0n);
            });

            it(`closeLp calldata carries the exact decrease minima (${fixture.name})`, async function () {
                const iface = await managerInterface();
                const range = { sqrtPriceX96: getSqrtRatioAtTick(IN_RANGE_TICK + fixture.offset), ...RANGE };
                const decrease = decreaseMinimums(range, 10n ** 15n, 10_000n, 100n);

                const data = iface.encodeFunctionData("closeLp", [
                    0,
                    {
                        onBehalfOf: ethers.ZeroAddress,
                        tokenId: 1n,
                        exitBps: 10_000,
                        swap0: { amountOutMin: 1n, expectedOut: 1n, poolParam: "0x" },
                        swap1: { amountOutMin: 0n, expectedOut: 0n, poolParam: "0x" },
                        slippageBps: 100,
                        decreaseAmount0Min: decrease.amount0Min,
                        decreaseAmount1Min: decrease.amount1Min,
                        deadline: 1n,
                        minUsdcOut: 0n,
                    },
                ]);
                const decoded = iface.decodeFunctionData("closeLp", data)[1];
                expect(decoded.decreaseAmount0Min).to.equal(decrease.amount0Min);
                expect(decoded.decreaseAmount1Min).to.equal(decrease.amount1Min);
                expect(decoded.decreaseAmount0Min + decoded.decreaseAmount1Min).to.be.greaterThan(0n);
            });

            it(`switchLp calldata carries both floors, mint sized off the withdraw floor (${fixture.name})`, async function () {
                const iface = await managerInterface();
                const range = { sqrtPriceX96: getSqrtRatioAtTick(IN_RANGE_TICK + fixture.offset), ...RANGE };
                const decrease = decreaseMinimums(range, 10n ** 15n, 10_000n, 100n);
                const mint = switchMintMinimums(range, decrease.amount0Min, decrease.amount1Min, 100n);

                const data = iface.encodeFunctionData("switchLp", [
                    0,
                    1,
                    {
                        onBehalfOf: ethers.ZeroAddress,
                        tokenId: 1n,
                        decreaseAmount0Min: decrease.amount0Min,
                        decreaseAmount1Min: decrease.amount1Min,
                        tickLower: range.tickLower,
                        tickUpper: range.tickUpper,
                        mintAmount0Min: mint.amount0Min,
                        mintAmount1Min: mint.amount1Min,
                        lpPoolParam: "0x",
                        deadline: 1n,
                    },
                ]);
                const decoded = iface.decodeFunctionData("switchLp", data)[2];
                expect(decoded.decreaseAmount0Min).to.equal(decrease.amount0Min);
                expect(decoded.decreaseAmount1Min).to.equal(decrease.amount1Min);
                expect(decoded.mintAmount0Min).to.equal(mint.amount0Min);
                expect(decoded.mintAmount1Min).to.equal(mint.amount1Min);
                // Sized off the accepted budget, so never above the withdraw floor.
                expect(decoded.mintAmount0Min).to.be.lessThanOrEqual(decoded.decreaseAmount0Min);
                expect(decoded.mintAmount1Min).to.be.lessThanOrEqual(decoded.decreaseAmount1Min);
            });
        }
    });

    describe("script wiring", function () {
        const read = (file: string) =>
            require("fs").readFileSync(require("path").join(__dirname, "../../scripts", file), "utf8");

        it("open, close and switch all build minima from the shared helpers", function () {
            expect(read("openLpBySafe.ts")).to.match(/mintMinimums\(/);
            expect(read("closeLpBySafe.ts")).to.match(/decreaseMinimums\(/);
            const switchSrc = read("switchLpBySafe.ts");
            expect(switchSrc).to.match(/decreaseMinimums\(/);
            expect(switchSrc).to.match(/switchMintMinimums\(/);
            for (const file of ["openLpBySafe.ts", "closeLpBySafe.ts", "switchLpBySafe.ts"]) {
                expect(read(file), file).to.match(/from "\.\/lpSafeShared"/);
            }
        });

        it("no script hard-codes a zero minimum or reaches for floating-point tick math", function () {
            for (const file of ["openLpBySafe.ts", "closeLpBySafe.ts", "switchLpBySafe.ts", "lpSafeShared.ts"]) {
                const src = read(file);
                expect(src, `${file} mintAmount0Min`).to.not.match(/mintAmount0Min:\s*0n/);
                expect(src, `${file} mintAmount1Min`).to.not.match(/mintAmount1Min:\s*0n/);
                expect(src, `${file} decreaseAmount0Min`).to.not.match(/decreaseAmount0Min:\s*0n/);
                expect(src, `${file} decreaseAmount1Min`).to.not.match(/decreaseAmount1Min:\s*0n/);
                expect(src, `${file} Math.sqrt`).to.not.match(/Math\.sqrt/);
                expect(src, `${file} Math.pow`).to.not.match(/Math\.pow|\*\* tick|1\.0001 \*\*/);
            }
        });
    });

    describe("switch minimums", function () {
        it("builds an achievable mint floor from the worst accepted withdrawal", function () {
            const source = {
                sqrtPriceX96: getSqrtRatioAtTick(IN_RANGE_TICK),
                tickLower: IN_RANGE_TICK - 1_000,
                tickUpper: IN_RANGE_TICK + 1_000,
            };
            const destination = {
                sqrtPriceX96: getSqrtRatioAtTick(IN_RANGE_TICK),
                tickLower: alignTick(IN_RANGE_TICK - 1_000, TICK_SPACING),
                tickUpper: alignTick(IN_RANGE_TICK + 1_000, TICK_SPACING),
            };
            const decrease = decreaseMinimums(source, 10n ** 15n, 10_000n, 100n);
            const mint = switchMintMinimums(destination, decrease.amount0Min, decrease.amount1Min, 100n);

            // A withdrawal landing EXACTLY on its floor must still clear the mint
            // floor — the case that reverts when the mint is sized off the
            // optimistic expected withdrawal instead of the accepted budget.
            const worstCase = mintMinimums(destination, decrease.amount0Min, decrease.amount1Min, 0n);
            expect(mint.amount0Min).to.be.lessThanOrEqual(worstCase.expected0);
            expect(mint.amount1Min).to.be.lessThanOrEqual(worstCase.expected1);
            expect(mint.amount0Min + mint.amount1Min).to.be.greaterThan(0n);

            // And the real withdrawal (expected, plus collected fees) is larger
            // still, so the floor only gets easier to satisfy.
            expect(decrease.expected0).to.be.greaterThanOrEqual(decrease.amount0Min);
            expect(decrease.expected1).to.be.greaterThanOrEqual(decrease.amount1Min);
        });
    });
});
