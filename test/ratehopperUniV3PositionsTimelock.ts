import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import {
    PARASWAP_V6_CONTRACT_ADDRESS,
    UNISWAP_V3_FACTORY_ADDRESS,
    UNISWAP_V3_SWAP_ROUTER_ADDRESS,
    USDC_ADDRESS,
    WETH_ADDRESS,
} from "./constants";

const UNISWAP_V3_NPM_ADDRESS = "0x03a520b32C04BF3bEEf7BEb72E919cf822Ed34f1";
const MAX_FEE_BPS = 2000;
const PERFORMANCE_FEE_BPS = 1000;
const COLLECT_FEE_BPS = 250;
const TWO_DAYS = 2 * 24 * 60 * 60;

describe("RatehopperUniV3Positions - Timelock Bypass Regression", function () {
    async function deployFixture() {
        const [deployer, admin, treasury, attacker, otherTreasury] = await ethers.getSigners();

        // Deploy a real TimelockController for end-to-end verification.
        const TimelockController = await ethers.getContractFactory("TimelockController");
        const timelock = await TimelockController.deploy(
            TWO_DAYS,
            [deployer.address],
            [deployer.address],
            deployer.address,
        );
        await timelock.waitForDeployment();

        const ProtocolRegistry = await ethers.getContractFactory("ProtocolRegistry");
        const protocolRegistry = await ProtocolRegistry.deploy(
            WETH_ADDRESS,
            UNISWAP_V3_FACTORY_ADDRESS,
            admin.address,
            await timelock.getAddress(),
            deployer.address,
            PARASWAP_V6_CONTRACT_ADDRESS,
        );
        await protocolRegistry.waitForDeployment();

        const RHP = await ethers.getContractFactory("RatehopperUniV3Positions");
        const rhp = await RHP.deploy(
            UNISWAP_V3_NPM_ADDRESS,
            await protocolRegistry.getAddress(),
            USDC_ADDRESS,
            WETH_ADDRESS,
            UNISWAP_V3_SWAP_ROUTER_ADDRESS,
            UNISWAP_V3_FACTORY_ADDRESS,
            treasury.address,
            PERFORMANCE_FEE_BPS,
            COLLECT_FEE_BPS,
            MAX_FEE_BPS,
            admin.address,
            await timelock.getAddress(),
            0, // _minPoolLiquidity
            0, // _minPositionLiquidity
        );
        await rhp.waitForDeployment();

        const DEFAULT_ADMIN_ROLE = await rhp.DEFAULT_ADMIN_ROLE();
        const CRITICAL_ROLE = await rhp.CRITICAL_ROLE();

        return {
            rhp,
            protocolRegistry,
            timelock,
            deployer,
            admin,
            treasury,
            attacker,
            otherTreasury,
            DEFAULT_ADMIN_ROLE,
            CRITICAL_ROLE,
        };
    }

    describe("Direct admin calls", function () {
        it("DEFAULT_ADMIN_ROLE cannot directly call setTreasury", async function () {
            const { rhp, admin, otherTreasury, CRITICAL_ROLE } = await loadFixture(deployFixture);
            await expect(rhp.connect(admin).setTreasury(otherTreasury.address))
                .to.be.revertedWithCustomError(rhp, "AccessControlUnauthorizedAccount")
                .withArgs(admin.address, CRITICAL_ROLE);
        });

        it("DEFAULT_ADMIN_ROLE cannot directly call setPerformanceFeeBps", async function () {
            const { rhp, admin, CRITICAL_ROLE } = await loadFixture(deployFixture);
            await expect(rhp.connect(admin).setPerformanceFeeBps(500))
                .to.be.revertedWithCustomError(rhp, "AccessControlUnauthorizedAccount")
                .withArgs(admin.address, CRITICAL_ROLE);
        });

        it("DEFAULT_ADMIN_ROLE cannot directly call setFeeCollectBps", async function () {
            const { rhp, admin, CRITICAL_ROLE } = await loadFixture(deployFixture);
            await expect(rhp.connect(admin).setFeeCollectBps(500))
                .to.be.revertedWithCustomError(rhp, "AccessControlUnauthorizedAccount")
                .withArgs(admin.address, CRITICAL_ROLE);
        });
    });

    describe("Role self-grant bypass", function () {
        it("DEFAULT_ADMIN_ROLE cannot grant itself CRITICAL_ROLE because the role is self-administered", async function () {
            const { rhp, admin, CRITICAL_ROLE } = await loadFixture(deployFixture);
            // CRITICAL_ROLE is admined by itself, not by DEFAULT_ADMIN_ROLE,
            // so admin cannot grant it to anyone (including itself).
            expect(await rhp.getRoleAdmin(CRITICAL_ROLE)).to.equal(CRITICAL_ROLE);

            await expect(rhp.connect(admin).grantRole(CRITICAL_ROLE, admin.address))
                .to.be.revertedWithCustomError(rhp, "AccessControlUnauthorizedAccount")
                .withArgs(admin.address, CRITICAL_ROLE);
        });

        it("Even with CRITICAL_ROLE, non-timelock caller cannot call setTreasury (defense in depth)", async function () {
            const { rhp, timelock, otherTreasury, CRITICAL_ROLE } = await loadFixture(deployFixture);

            // Grant CRITICAL_ROLE to an attacker EOA via the timelock (the only legitimate path).
            const [, , , attacker] = await ethers.getSigners();
            const grantData = rhp.interface.encodeFunctionData("grantRole", [CRITICAL_ROLE, attacker.address]);
            const salt = ethers.id("grant-critical-to-attacker");
            await timelock.schedule(await rhp.getAddress(), 0, grantData, ethers.ZeroHash, salt, TWO_DAYS);
            await time.increase(TWO_DAYS);
            await timelock.execute(await rhp.getAddress(), 0, grantData, ethers.ZeroHash, salt);
            expect(await rhp.hasRole(CRITICAL_ROLE, attacker.address)).to.be.true;

            // Even with CRITICAL_ROLE, the attacker is not the timelock - must revert
            await expect(rhp.connect(attacker).setTreasury(otherTreasury.address)).to.be.revertedWithCustomError(
                rhp,
                "OnlyTimelock",
            );
            await expect(rhp.connect(attacker).setPerformanceFeeBps(500)).to.be.revertedWithCustomError(
                rhp,
                "OnlyTimelock",
            );
            await expect(rhp.connect(attacker).setFeeCollectBps(500)).to.be.revertedWithCustomError(
                rhp,
                "OnlyTimelock",
            );
        });
    });

    describe("Timelock-scheduled execution", function () {
        it("Timelock can call setTreasury after delay", async function () {
            const { rhp, timelock, otherTreasury } = await loadFixture(deployFixture);
            const data = rhp.interface.encodeFunctionData("setTreasury", [otherTreasury.address]);
            const salt = ethers.id("set-treasury");

            await timelock.schedule(await rhp.getAddress(), 0, data, ethers.ZeroHash, salt, TWO_DAYS);
            await time.increase(TWO_DAYS);
            await timelock.execute(await rhp.getAddress(), 0, data, ethers.ZeroHash, salt);

            expect(await rhp.treasury()).to.equal(otherTreasury.address);
        });

        it("Timelock can call setPerformanceFeeBps after delay", async function () {
            const { rhp, timelock } = await loadFixture(deployFixture);
            const data = rhp.interface.encodeFunctionData("setPerformanceFeeBps", [500]);
            const salt = ethers.id("set-perf-fee");

            await timelock.schedule(await rhp.getAddress(), 0, data, ethers.ZeroHash, salt, TWO_DAYS);
            await time.increase(TWO_DAYS);
            await timelock.execute(await rhp.getAddress(), 0, data, ethers.ZeroHash, salt);

            expect(await rhp.performanceFeeBps()).to.equal(500);
        });

        it("Timelock can call setFeeCollectBps after delay", async function () {
            const { rhp, timelock } = await loadFixture(deployFixture);
            const data = rhp.interface.encodeFunctionData("setFeeCollectBps", [400]);
            const salt = ethers.id("set-fee-collect");

            await timelock.schedule(await rhp.getAddress(), 0, data, ethers.ZeroHash, salt, TWO_DAYS);
            await time.increase(TWO_DAYS);
            await timelock.execute(await rhp.getAddress(), 0, data, ethers.ZeroHash, salt);

            expect(await rhp.feeCollectBps()).to.equal(400);
        });

        it("Direct call from timelock signer fails (must go through schedule/execute)", async function () {
            const { rhp, timelock, otherTreasury } = await loadFixture(deployFixture);
            // Direct call as the timelock's deployer/proposer signer - msg.sender will be that EOA, not timelock address
            const [deployer] = await ethers.getSigners();
            await expect(rhp.connect(deployer).setTreasury(otherTreasury.address)).to.be.revertedWithCustomError(
                rhp,
                "AccessControlUnauthorizedAccount",
            );
        });
    });
});
