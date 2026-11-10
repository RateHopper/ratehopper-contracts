import { expect } from "chai";
import { ethers, network } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import { createServer, Server } from "node:http";
import { main, readConfig, buildAction, prepareTransactions } from "../../scripts/savingsBySafe";
import {
    AMOUNT,
    FORK_BLOCK,
    SKY_PARAM,
    SUSDS_ADDR,
    PSM3_ADDR,
    deployStack,
    resetFork,
    susds,
    usdc,
} from "../helpers/savingsForkStack";
import { SKY, MAX_FEED_AGE, openParams, tokenIdOf, timelockCall, switchParams } from "../helpers/savingsHarness";
import { readCanaryConfig, runCanary } from "../../scripts/canarySavings";

// Runs the real CLI orchestration and Safe SDK against an in-process fork.
// The HTTP bridge is loopback-only and delegates every request to Hardhat.
// Only the public deterministic Hardhat test key is used; no live signing.
const OWNER_KEY = ethers.HDNodeWallet.fromPhrase(
    "test test test test test test test test test test test junk",
).privateKey;
const REVERTING = "0x60006000fd";
type Stack = Awaited<ReturnType<typeof deployStack>>;
const configEnv = (f: Stack, action: string, over: Record<string, string> = {}) => ({
    ACTION: action,
    CALLER: "safe",
    DRY_RUN: "false",
    SAFE_ADDRESS: f.safeAddr,
    MANAGER_ADDRESS: f.managerAddr,
    USDC_AMOUNT: "1000",
    MIN_USDC_OUT: "",
    SLIPPAGE_BPS: "20",
    EXIT_BPS: "10000",
    ENABLE_MODULE: "false",
    ...over,
});
const open = async (f: Stack) =>
    (await f.manager.connect(f.operator).open(SKY, openParams(f.safeAddr, SKY_PARAM, { usdcAmount: AMOUNT }))).wait();
const safeAbi = [
    "function isModuleEnabled(address) view returns (bool)",
    "function disableModule(address,address)",
    "function execTransaction(address,uint256,bytes,uint8,uint256,uint256,uint256,address,address,bytes) payable returns (bool)",
];
async function ownerCall(f: Stack, to: string, data: string) {
    const safe = new ethers.Contract(f.safeAddr, safeAbi, f.admin);
    const sig = ethers.concat([ethers.zeroPadValue(f.admin.address, 32), ethers.ZeroHash, "0x01"]);
    return (await safe.execTransaction(to, 0, data, 0, 0, 0, 0, ethers.ZeroAddress, ethers.ZeroAddress, sig)).wait();
}
async function revoke(f: Stack) {
    const iface = new ethers.Interface(safeAbi);
    await ownerCall(
        f,
        f.safeAddr,
        iface.encodeFunctionData("disableModule", ["0x0000000000000000000000000000000000000001", f.managerAddr]),
    );
    expect(await new ethers.Contract(f.safeAddr, safeAbi, ethers.provider).isModuleEnabled(f.managerAddr)).to.equal(
        false,
    );
}

describe("scripts/savingsRecovery - real Safe execution and revoked authority", function () {
    this.timeout(300_000);
    let server: Server;
    let originalUrl: unknown;
    let previousKey: string | undefined;

    before(async function () {
        await resetFork(FORK_BLOCK);
        server = createServer(async (req, res) => {
            const buffers: Buffer[] = [];
            for await (const b of req) buffers.push(Buffer.from(b));
            const parsed = JSON.parse(Buffer.concat(buffers).toString());
            const handle = async (call: any) => {
                try {
                    return {
                        jsonrpc: "2.0",
                        id: call.id,
                        result: await network.provider.request({ method: call.method, params: call.params }),
                    };
                } catch (e: any) {
                    return {
                        jsonrpc: "2.0",
                        id: call.id,
                        error: { code: typeof e.code === "number" ? e.code : -32000, message: e.message, data: e.data },
                    };
                }
            };
            const response = Array.isArray(parsed) ? await Promise.all(parsed.map(handle)) : await handle(parsed);
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(response));
        });
        await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
        const port = (server.address() as any).port;
        originalUrl = (network.config as any).url;
        (network.config as any).url = `http://127.0.0.1:${port}`;
        previousKey = process.env.TESTING_SAFE_OWNER_KEY;
        process.env.TESTING_SAFE_OWNER_KEY = OWNER_KEY;
    });
    after(async function () {
        (network.config as any).url = originalUrl;
        if (previousKey === undefined) delete process.env.TESTING_SAFE_OWNER_KEY;
        else process.env.TESTING_SAFE_OWNER_KEY = previousKey;
        if (server) {
            server.closeAllConnections();
            await new Promise<void>((resolve) => server.close(() => resolve()));
        }
        await resetFork(process.env.BASE_FORK_BLOCK_NUMBER ? Number(process.env.BASE_FORK_BLOCK_NUMBER) : undefined);
    });

    it("executes withdraw and direct redemption with stale Chainlink, real Safe and no residual allowance", async function () {
        const f = await loadFixture(deployStack);
        expect(new ethers.Wallet(OWNER_KEY).address).to.equal(f.admin.address);
        await open(f);
        const shares = await susds.balanceOf(f.safeAddr);
        await time.increase(MAX_FEED_AGE + 1);
        await expect(f.provider.rate(SUSDS_ADDR)).to.be.revertedWithCustomError(f.provider, "StaleRate");
        await main(configEnv(f, "withdraw"));
        expect(await f.manager.positionHandlerOf(SKY, tokenIdOf(f.safeAddr))).to.equal(ethers.ZeroAddress);
        expect(await susds.balanceOf(f.safeAddr)).to.equal(shares);
        await revoke(f);
        const before = await usdc.balanceOf(f.safeAddr);
        await main(configEnv(f, "redeem-direct", { MIN_USDC_OUT: "990" }));
        expect((await usdc.balanceOf(f.safeAddr)) - before).to.be.gte(990_000_000n);
        expect(await susds.balanceOf(f.safeAddr)).to.equal(0n);
        expect(await susds.allowance(f.safeAddr, PSM3_ADDR)).to.equal(0n);
        expect(await new ethers.Contract(f.safeAddr, safeAbi, ethers.provider).isModuleEnabled(f.managerAddr)).to.equal(
            false,
        );
    });

    it("executes close through the healthy pin even when the registered replacement reverts", async function () {
        const f = await loadFixture(deployStack);
        await open(f);
        const replacement = await f.deployBuild();
        const address = await replacement.getAddress();
        await (await timelockCall(f.timelock, f.manager, "setYieldHandler", [SKY, address])).wait();
        await network.provider.send("hardhat_setCode", [address, REVERTING]);
        const before = await usdc.balanceOf(f.safeAddr);
        await main(configEnv(f, "close"));
        expect(await f.manager.positionHandlerOf(SKY, tokenIdOf(f.safeAddr))).to.equal(ethers.ZeroAddress);
        expect(await susds.balanceOf(f.safeAddr)).to.equal(0n);
        expect(await usdc.balanceOf(f.safeAddr)).to.be.greaterThan(before);
    });

    it("executes a partial close and keeps the remaining shares and pin", async function () {
        const f = await loadFixture(deployStack);
        await open(f);
        const beforeShares = await susds.balanceOf(f.safeAddr);
        const beforeUsdc = await usdc.balanceOf(f.safeAddr);
        await main(configEnv(f, "close", { EXIT_BPS: "5000", MIN_USDC_OUT: "490" }));
        expect(await f.manager.positionHandlerOf(SKY, tokenIdOf(f.safeAddr))).to.equal(f.handlerAddr);
        expect(await susds.balanceOf(f.safeAddr)).to.equal(beforeShares - beforeShares / 2n);
        expect((await usdc.balanceOf(f.safeAddr)) - beforeUsdc).to.be.gte(490_000_000n);
    });

    it("executes withdrawal with an unavailable PSM3", async function () {
        const f = await loadFixture(deployStack);
        await open(f);
        const shares = await susds.balanceOf(f.safeAddr);
        await network.provider.send("hardhat_setCode", [PSM3_ADDR, REVERTING]);
        await main(configEnv(f, "withdraw"));
        expect(await f.manager.positionHandlerOf(SKY, tokenIdOf(f.safeAddr))).to.equal(ethers.ZeroAddress);
        expect(await susds.balanceOf(f.safeAddr)).to.equal(shares);
    });

    it("proves bookkeeping withdrawal works with the manager revoked", async function () {
        const f = await loadFixture(deployStack);
        await open(f);
        await revoke(f);
        const built = await buildAction(readConfig(configEnv(f, "withdraw")));
        await ownerCall(f, built.target, built.data);
        expect(await f.manager.positionHandlerOf(SKY, tokenIdOf(f.safeAddr))).to.equal(ethers.ZeroAddress);
        expect(await new ethers.Contract(f.safeAddr, safeAbi, ethers.provider).isModuleEnabled(f.managerAddr)).to.equal(
            false,
        );
    });

    it("preserves revocation through the CLI and blocks subsequent operator spending", async function () {
        const f = await loadFixture(deployStack);
        await open(f);
        await revoke(f);
        const output: string[] = [];
        const log = console.log;
        try {
            console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
            await main(configEnv(f, "withdraw", { DRY_RUN: "true" }));
        } finally {
            console.log = log;
        }
        expect(output.join("\n")).to.not.include("enableModule");
        expect(await new ethers.Contract(f.safeAddr, safeAbi, ethers.provider).isModuleEnabled(f.managerAddr)).to.equal(
            false,
        );
        await main(configEnv(f, "withdraw"));
        expect(await f.manager.positionHandlerOf(SKY, tokenIdOf(f.safeAddr))).to.equal(ethers.ZeroAddress);
        expect(await new ethers.Contract(f.safeAddr, safeAbi, ethers.provider).isModuleEnabled(f.managerAddr)).to.equal(
            false,
        );
        const before = await usdc.balanceOf(f.safeAddr);
        await expect(open(f)).to.be.reverted;
        expect(await usdc.balanceOf(f.safeAddr)).to.equal(before);
    });

    it("refuses an impossible owner minimum without changing balances, allowance or revoked authority", async function () {
        const f = await loadFixture(deployStack);
        await open(f);
        await revoke(f);
        const shares = await susds.balanceOf(f.safeAddr);
        const cash = await usdc.balanceOf(f.safeAddr);
        await expect(main(configEnv(f, "redeem-direct", { MIN_USDC_OUT: "1000000" }))).to.be.rejected;
        expect(await susds.balanceOf(f.safeAddr)).to.equal(shares);
        expect(await usdc.balanceOf(f.safeAddr)).to.equal(cash);
        expect(await susds.allowance(f.safeAddr, PSM3_ADDR)).to.equal(0n);
        expect(await new ethers.Contract(f.safeAddr, safeAbi, ethers.provider).isModuleEnabled(f.managerAddr)).to.equal(
            false,
        );
    });

    it("executes direct redemption without working manager code when an explicit manager address is supplied", async function () {
        const f = await loadFixture(deployStack);
        await open(f);
        await network.provider.send("hardhat_setCode", [f.managerAddr, REVERTING]);
        await main(configEnv(f, "redeem-direct", { MIN_USDC_OUT: "990" }));
        expect(await susds.balanceOf(f.safeAddr)).to.equal(0n);
        expect(await susds.allowance(f.safeAddr, PSM3_ADDR)).to.equal(0n);
    });

    it("rehearses trusted-handler migration with the actual pause and protocol gates", async function () {
        const f = await loadFixture(deployStack);
        await open(f);
        await f.manager.connect(f.pauser).pause();
        await f.manager.connect(f.pauser).setProtocolEnabledForClose(SKY, false);
        await f.manager.connect(f.pauser).setProtocolEnabledForOpen(SKY, false);
        const replacement = await f.deployBuild();
        await timelockCall(f.timelock, f.manager, "setYieldHandler", [SKY, await replacement.getAddress()]);
        const roll = () =>
            f.manager
                .connect(f.operator)
                .switchPosition(SKY, SKY, switchParams(f.safeAddr, tokenIdOf(f.safeAddr), SKY_PARAM));
        await expect(roll()).to.be.revertedWithCustomError(f.manager, "EnforcedPause");
        const canaryCfg = readCanaryConfig(configEnv(f, "open", { SAFE_ADDRESS: f.safe2Addr, USDC_AMOUNT: "1" }));
        let sends = 0;
        const sender = async (_cfg: unknown, built: { target: string; data: string }) => {
            sends++;
            return (await f.operator.sendTransaction({ to: built.target, data: built.data })).hash;
        };
        expect((await runCanary(canaryCfg, sender)).stage).to.equal("preflight");
        expect(sends).to.equal(0);
        await f.manager.connect(f.pauser).unpause();
        await expect(roll()).to.be.revertedWithCustomError(f.manager, "ProtocolDisabled");
        await f.manager.connect(f.pauser).setProtocolEnabledForClose(SKY, true);
        await expect(roll()).to.be.revertedWithCustomError(f.manager, "ProtocolDisabled");
        await f.manager.connect(f.pauser).setProtocolEnabledForOpen(SKY, true);
        const result = await runCanary(canaryCfg, sender);
        expect(result.checks.filter((c) => !c.ok)).to.deep.equal([]);
        expect(result.ok).to.equal(true);
        expect(sends).to.equal(2);
        expect(await f.manager.positionHandlerOf(SKY, tokenIdOf(f.safeAddr))).to.equal(f.handlerAddr);
        const shares = await susds.balanceOf(f.safeAddr);
        const cash = await usdc.balanceOf(f.safeAddr);
        await roll();
        expect(await f.manager.positionHandlerOf(SKY, tokenIdOf(f.safeAddr))).to.equal(await replacement.getAddress());
        expect(await susds.balanceOf(f.safeAddr)).to.equal(shares);
        expect(await usdc.balanceOf(f.safeAddr)).to.equal(cash);
        await main(configEnv(f, "close"));
        expect(await susds.balanceOf(f.safeAddr)).to.equal(0n);
    });

    it("recovers directly with a revoked manager and an unusable pinned handler, without enabling either switch", async function () {
        const f = await loadFixture(deployStack);
        await open(f);
        await revoke(f);
        await f.manager.connect(f.pauser).pause();
        await f.manager.connect(f.pauser).setProtocolEnabledForClose(SKY, false);
        await f.manager.connect(f.pauser).setProtocolEnabledForOpen(SKY, false);
        await network.provider.send("hardhat_setCode", [f.handlerAddr, REVERTING]);
        const cash = await usdc.balanceOf(f.safeAddr);
        await main(configEnv(f, "redeem-direct", { MIN_USDC_OUT: "990" }));
        expect((await usdc.balanceOf(f.safeAddr)) - cash).to.be.gte(990_000_000n);
        expect(await susds.balanceOf(f.safeAddr)).to.equal(0n);
        expect(await susds.allowance(f.safeAddr, PSM3_ADDR)).to.equal(0n);
        expect(await new ethers.Contract(f.safeAddr, safeAbi, ethers.provider).isModuleEnabled(f.managerAddr)).to.equal(
            false,
        );
        expect(await f.manager.paused()).to.equal(true);
        expect(await f.manager.protocolEnabledForClose(SKY)).to.equal(false);
        expect(await f.manager.protocolEnabledForOpen(SKY)).to.equal(false);
        expect(await f.manager.positionHandlerOf(SKY, tokenIdOf(f.safeAddr))).to.equal(f.handlerAddr);
    });

    it("requires explicit owner onboarding and prints every call in the executed bundle", async function () {
        const f = await loadFixture(deployStack);
        await revoke(f);
        const cfg = readConfig(configEnv(f, "open"));
        const built = await buildAction(cfg);
        await expect(prepareTransactions(cfg, built)).to.be.rejectedWith("Manager module is disabled");
        await expect(prepareTransactions({ ...cfg, caller: "operator", enableModule: true }, built)).to.be.rejected;
        for (const action of ["withdraw", "close", "redeem-direct"]) {
            expect(() => readConfig(configEnv(f, action, { ENABLE_MODULE: "true" }))).to.throw(
                "explicit owner onboarding",
            );
        }
        const optedIn = { ...cfg, enableModule: true };
        const bundle = await prepareTransactions(optedIn, built);
        expect(bundle).to.have.length(2);
        const enable = new ethers.Interface(["function enableModule(address)"]);
        expect(bundle[0].to).to.equal(f.safeAddr);
        expect(enable.decodeFunctionData("enableModule", bundle[0].data)[0]).to.equal(f.managerAddr);
        expect(bundle[1].data).to.equal(built.data);
        const output: string[] = [];
        const log = console.log;
        try {
            console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
            await main(configEnv(f, "open", { ENABLE_MODULE: "true", DRY_RUN: "true" }));
        } finally {
            console.log = log;
        }
        expect(output.join("\n")).to.include(JSON.stringify(bundle));
        expect(output.join("\n")).to.include("grants the manager authority");
        expect(await new ethers.Contract(f.safeAddr, safeAbi, ethers.provider).isModuleEnabled(f.managerAddr)).to.equal(
            false,
        );
        output.length = 0;
        try {
            console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));
            await main(configEnv(f, "open", { ENABLE_MODULE: "true" }));
        } finally {
            console.log = log;
        }
        expect(output.join("\n")).to.include(JSON.stringify(bundle));
        const hash = output.find((line) => line.startsWith("Submitted: "))!.slice("Submitted: ".length);
        const tx = (await ethers.provider.getTransaction(hash))!;
        const outer = new ethers.Interface(safeAbi).decodeFunctionData("execTransaction", tx.data);
        expect(outer[3]).to.equal(1n);
        const multiSend = new ethers.Interface(["function multiSend(bytes)"]);
        const packed = ethers.getBytes(multiSend.decodeFunctionData("multiSend", outer[2])[0]);
        const submitted: Array<{ to: string; value: string; data: string; operation: number }> = [];
        let offset = 0;
        while (offset < packed.length) {
            const operation = packed[offset];
            const to = ethers.hexlify(packed.slice(offset + 1, offset + 21));
            const value = BigInt(ethers.hexlify(packed.slice(offset + 21, offset + 53))).toString();
            const length = Number(BigInt(ethers.hexlify(packed.slice(offset + 53, offset + 85))));
            const data = ethers.hexlify(packed.slice(offset + 85, offset + 85 + length));
            submitted.push({ to, value, data, operation });
            offset += 85 + length;
        }
        expect(offset).to.equal(packed.length);
        expect(submitted).to.deep.equal(bundle.map((call) => ({ ...call, to: call.to.toLowerCase() })));
        expect(await new ethers.Contract(f.safeAddr, safeAbi, ethers.provider).isModuleEnabled(f.managerAddr)).to.equal(
            true,
        );
        expect(await f.manager.positionHandlerOf(SKY, tokenIdOf(f.safeAddr))).to.equal(f.handlerAddr);
    });

    it("fails closed for close after revocation and still permits stale-oracle recovery", async function () {
        const f = await loadFixture(deployStack);
        await open(f);
        await revoke(f);
        const cash = await usdc.balanceOf(f.safeAddr);
        await expect(main(configEnv(f, "close"))).to.be.rejectedWith("Manager module is disabled");
        expect(await usdc.balanceOf(f.safeAddr)).to.equal(cash);
        await time.increase(MAX_FEED_AGE + 1);
        await main(configEnv(f, "withdraw"));
        await main(configEnv(f, "redeem-direct", { MIN_USDC_OUT: "990" }));
        expect(await new ethers.Contract(f.safeAddr, safeAbi, ethers.provider).isModuleEnabled(f.managerAddr)).to.equal(
            false,
        );
        expect(await susds.balanceOf(f.safeAddr)).to.equal(0n);
        expect(await susds.allowance(f.safeAddr, PSM3_ADDR)).to.equal(0n);
    });
});
