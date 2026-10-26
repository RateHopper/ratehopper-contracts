import { expect } from "chai";
import * as fs from "fs";
import * as path from "path";
import {
    ONE,
    SOURCES,
    USDC,
    close,
    deployRegistered,
    expectZeroResidue,
    open,
    withdraw,
} from "../helpers/savingsHarness";

// ─────────────────────────────────────────────────────────────────────────
//  Source rules for savings handlers (spec 14.1). Inside a delegatecall
//  `address(this)` is the manager, so any token transfer written in a
//  handler would move the manager's tokens: every movement must be a
//  module call on the Safe, the manager namespace is read-only, every
//  entry point is delegatecall-only, and the manager never ends up holding
//  anything even when the Safe already holds the tokens involved.
// ─────────────────────────────────────────────────────────────────────────

const HANDLERS_DIR = path.join(__dirname, "..", "..", "contracts", "yield", "handlers");
const BASE = "BaseSavingsHandler.sol";
const ENTRY_POINTS = ["open", "close", "withdraw", "openInKind", "collect", "configure"];

function sourceFiles(): string[] {
    const sources = fs.readdirSync(HANDLERS_DIR).filter((name) => name.endsWith("SavingsYieldHandler.sol"));
    return [BASE, ...sources];
}

describe("savings source rules", function () {
    it("covers the base and at least one concrete source", function () {
        expect(sourceFiles().length).to.be.greaterThanOrEqual(2);
    });

    for (const file of sourceFiles()) {
        it(`${file} moves tokens only through the Safe`, function () {
            const lines = fs.readFileSync(path.join(HANDLERS_DIR, file), "utf8").split("\n");
            const offenders = lines
                .map((line, i) => ({ line, i }))
                .filter(
                    ({ line }) =>
                        !line.replace(/\/\/.*$/, "").includes("abi.encodeCall(") &&
                        /\.(transfer|safeTransfer|transferFrom|safeTransferFrom|approve|forceApprove)\(/.test(
                            line.replace(/\/\/.*$/, ""),
                        ),
                )
                .map(({ line, i }) => `${file}:${i + 1}: ${line.trim()}`);
            expect(offenders).to.deep.equal([]);
        });

        it(`${file} never writes the manager namespace`, function () {
            const text = fs.readFileSync(path.join(HANDLERS_DIR, file), "utf8");
            expect(text).to.not.match(/delete\s+_yieldStorage\(\)/);
            expect(text).to.not.match(/_yieldStorage\(\)[^;]*[^=!<>]=[^=]/);
            expect(text).to.not.match(/YieldLayout\s+storage\s+\w+\s*=\s*_yieldStorage\(\)/);
        });
    }

    it("guards every entry point with onlyDelegatecall", function () {
        const text = fs.readFileSync(path.join(HANDLERS_DIR, BASE), "utf8");
        for (const name of ENTRY_POINTS) {
            expect(text, name).to.match(new RegExp(`function ${name}\\(([^{]|\\n)*?onlyDelegatecall`));
        }
    });

    it("leaves no residue on the manager when the Safe already holds the tokens involved", async function () {
        const f = await deployRegistered();
        await (await f.usdc.mint(f.safeAddr, USDC(5_000))).wait();
        await (await f.susds.mint(f.safeAddr, 1_000n * ONE)).wait();
        await (await f.mockShare.mint(f.safeAddr, 1_000n * ONE)).wait();
        for (const src of SOURCES) {
            await (await open(f, src)).wait();
            await expectZeroResidue(f);
            await (await close(f, src, f.safeAddr, { exitBps: 5_000 })).wait();
            await expectZeroResidue(f);
            await (await close(f, src)).wait();
            await expectZeroResidue(f);
            await (await open(f, src, f.safeAddr, { usdcAmount: USDC(50_000) })).wait();
            await expectZeroResidue(f);
            await (await withdraw(f, src)).wait();
            await expectZeroResidue(f);
        }
    });
});
