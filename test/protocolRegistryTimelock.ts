import { expect } from "chai";
import * as ethersLib from "ethers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { ProtocolRegistry } from "../typechain-types/index.js";
import type { TimelockController } from "../typechain-types/@openzeppelin/contracts/governance/TimelockController.js";
import { connectNetwork, getEthers, getTime, loadFixture } from "./testSetup.js";
import { WETH_ADDRESS } from "./constants.js";
import { UNISWAP_V3_FACTORY_ADDRESS } from "../contractAddresses.js";

describe("ProtocolRegistry - Timelock Integration Tests", function () {
    const TWO_DAYS = 2 * 24 * 60 * 60; // 2 days in seconds

    before(async function () {
        await connectNetwork();
    });

    async function deployTimelockFixture() {
        const ethers = getEthers();
        const [deployer, admin, user, mockParaswap, mockOperator] = await ethers.getSigners();

        // Deploy TimelockController first
        // In Hardhat 3, we use the wrapper contract from Imports.sol
        const TimelockController = await ethers.getContractFactory("TimelockControllerForTest");
        const timelock = await TimelockController.deploy(
            TWO_DAYS,
            [deployer.address], // proposers
            [deployer.address], // executors
            deployer.address, // admin
        );
        await timelock.waitForDeployment();

        // Deploy ProtocolRegistry with timelock address
        const ProtocolRegistry = await ethers.getContractFactory("ProtocolRegistry");
        const protocolRegistry = await ProtocolRegistry.deploy(
            WETH_ADDRESS,
            UNISWAP_V3_FACTORY_ADDRESS,
            deployer.address, // initial admin
            await timelock.getAddress(), // timelock
            mockOperator.address, // initial operator
            mockParaswap.address, // initial paraswap
        );
        await protocolRegistry.waitForDeployment();

        // Deploy a mock contract to use as the new paraswap address
        // (setParaswapV6 validates that the address is a contract, and forked state
        // may not persist through loadFixture snapshots)
        const MockContract = await ethers.getContractFactory("TimelockControllerForTest");
        const mockNewParaswap = await MockContract.deploy(
            0, // no delay
            [deployer.address],
            [deployer.address],
            deployer.address,
        );
        await mockNewParaswap.waitForDeployment();
        const newMockParaswapAddress = await mockNewParaswap.getAddress();

        // Note: CRITICAL_ROLE is automatically granted to timelock in constructor
        const CRITICAL_ROLE = await protocolRegistry.CRITICAL_ROLE();

        // Grant DEFAULT_ADMIN_ROLE to admin for routine operations
        const DEFAULT_ADMIN_ROLE = await protocolRegistry.DEFAULT_ADMIN_ROLE();
        await protocolRegistry.grantRole(DEFAULT_ADMIN_ROLE, admin.address);

        return {
            protocolRegistry,
            timelock,
            deployer,
            admin,
            user,
            mockParaswap,
            mockOperator,
            newMockParaswapAddress,
            CRITICAL_ROLE,
            DEFAULT_ADMIN_ROLE,
        };
    }

    describe("Access Control Setup", function () {
        it("Should have correct role assignments", async function () {
            const { protocolRegistry, timelock, deployer, admin, CRITICAL_ROLE, DEFAULT_ADMIN_ROLE } =
                await loadFixture(deployTimelockFixture);

            const timelockAddress = await timelock.getAddress();

            expect(await protocolRegistry.hasRole(CRITICAL_ROLE, timelockAddress)).to.be.true;
            expect(await protocolRegistry.hasRole(DEFAULT_ADMIN_ROLE, deployer.address)).to.be.true;
            expect(await protocolRegistry.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
        });

        it("Should not allow direct call to setParaswapV6 without CRITICAL_ROLE", async function () {
            const { protocolRegistry, user, newMockParaswapAddress, CRITICAL_ROLE } =
                await loadFixture(deployTimelockFixture);

            // user doesn't have CRITICAL_ROLE, so direct call should fail
            await expect(protocolRegistry.connect(user).setParaswapV6(newMockParaswapAddress))
                .to.be.revertedWithCustomError(protocolRegistry, "AccessControlUnauthorizedAccount")
                .withArgs(user.address, CRITICAL_ROLE);
        });

        it("Should not allow admin (with DEFAULT_ADMIN_ROLE) to call critical functions directly", async function () {
            const { protocolRegistry, admin, newMockParaswapAddress, CRITICAL_ROLE, DEFAULT_ADMIN_ROLE } =
                await loadFixture(deployTimelockFixture);

            // Verify admin has DEFAULT_ADMIN_ROLE but not CRITICAL_ROLE
            expect(await protocolRegistry.hasRole(DEFAULT_ADMIN_ROLE, admin.address)).to.be.true;
            expect(await protocolRegistry.hasRole(CRITICAL_ROLE, admin.address)).to.be.false;

            // Admin should not be able to call critical function directly
            await expect(protocolRegistry.connect(admin).setParaswapV6(newMockParaswapAddress))
                .to.be.revertedWithCustomError(protocolRegistry, "AccessControlUnauthorizedAccount")
                .withArgs(admin.address, CRITICAL_ROLE);
        });

        it("Should not allow direct call even if user has CRITICAL_ROLE", async function () {
            const { protocolRegistry, deployer, newMockParaswapAddress, CRITICAL_ROLE } =
                await loadFixture(deployTimelockFixture);

            // Maliciously grant CRITICAL_ROLE to deployer (who has DEFAULT_ADMIN_ROLE)
            await protocolRegistry.grantRole(CRITICAL_ROLE, deployer.address);

            // Verify deployer now has CRITICAL_ROLE
            expect(await protocolRegistry.hasRole(CRITICAL_ROLE, deployer.address)).to.be.true;

            // Even with CRITICAL_ROLE, deployer should NOT be able to call directly
            // because msg.sender is not the timelock address
            await expect(
                protocolRegistry.connect(deployer).setParaswapV6(newMockParaswapAddress),
            ).to.be.revertedWithCustomError(protocolRegistry, "OnlyTimelock");
        });

        it("Should not allow user without any role to call critical functions", async function () {
            const { protocolRegistry, user, newMockParaswapAddress, CRITICAL_ROLE } =
                await loadFixture(deployTimelockFixture);

            await expect(protocolRegistry.connect(user).setParaswapV6(newMockParaswapAddress))
                .to.be.revertedWithCustomError(protocolRegistry, "AccessControlUnauthorizedAccount")
                .withArgs(user.address, CRITICAL_ROLE);
        });
    });

    describe("Timelock for Paraswap V6 Update", function () {
        it("Should successfully schedule and execute Paraswap V6 update after 2 days", async function () {
            const { protocolRegistry, timelock, newMockParaswapAddress } = await loadFixture(deployTimelockFixture);

            // Prepare operation parameters
            const target = await protocolRegistry.getAddress();
            const value = 0;
            const data = protocolRegistry.interface.encodeFunctionData("setParaswapV6", [newMockParaswapAddress]);
            const predecessor = ethersLib.ZeroHash;
            const salt = ethersLib.id("test-paraswap-update");

            // Schedule the operation
            await timelock.schedule(target, value, data, predecessor, salt, TWO_DAYS);

            // Try to execute immediately (should fail)
            await expect(timelock.execute(target, value, data, predecessor, salt)).to.be.revertedWithCustomError(
                timelock,
                "TimelockUnexpectedOperationState",
            );

            // Fast forward 2 days
            const time = getTime();
            await time.increase(TWO_DAYS);

            // Execute the operation
            await timelock.execute(target, value, data, predecessor, salt);

            // Verify the update
            expect(await protocolRegistry.paraswapV6()).to.equal(newMockParaswapAddress);
        });

        it("Should emit ParaswapV6Updated event", async function () {
            const { protocolRegistry, timelock, newMockParaswapAddress } = await loadFixture(deployTimelockFixture);

            const target = await protocolRegistry.getAddress();
            const value = 0;
            const data = protocolRegistry.interface.encodeFunctionData("setParaswapV6", [newMockParaswapAddress]);
            const predecessor = ethersLib.ZeroHash;
            const salt = ethersLib.id("test-paraswap-event");

            await timelock.schedule(target, value, data, predecessor, salt, TWO_DAYS);
            const time = getTime();
            await time.increase(TWO_DAYS);

            const oldAddress = await protocolRegistry.paraswapV6();

            await expect(timelock.execute(target, value, data, predecessor, salt))
                .to.emit(protocolRegistry, "ParaswapV6Updated")
                .withArgs(oldAddress, newMockParaswapAddress);
        });

        it("Should reject zero address for Paraswap V6", async function () {
            const { protocolRegistry, timelock } = await loadFixture(deployTimelockFixture);

            const target = await protocolRegistry.getAddress();
            const value = 0;
            const data = protocolRegistry.interface.encodeFunctionData("setParaswapV6", [ethersLib.ZeroAddress]);
            const predecessor = ethersLib.ZeroHash;
            const salt = ethersLib.id("test-zero-address");

            await timelock.schedule(target, value, data, predecessor, salt, TWO_DAYS);
            const time = getTime();
            await time.increase(TWO_DAYS);

            await expect(timelock.execute(target, value, data, predecessor, salt)).to.be.revertedWithCustomError(
                protocolRegistry,
                "ZeroAddress",
            );
        });

        it("Should reject non-contract address for Paraswap V6", async function () {
            const { protocolRegistry, timelock, user } = await loadFixture(deployTimelockFixture);

            const target = await protocolRegistry.getAddress();
            const value = 0;
            const data = protocolRegistry.interface.encodeFunctionData(
                "setParaswapV6",
                [user.address], // EOA, not a contract
            );
            const predecessor = ethersLib.ZeroHash;
            const salt = ethersLib.id("test-non-contract");

            await timelock.schedule(target, value, data, predecessor, salt, TWO_DAYS);
            const time = getTime();
            await time.increase(TWO_DAYS);

            await expect(timelock.execute(target, value, data, predecessor, salt)).to.be.revertedWith("Not a contract");
        });
    });

    describe("Timelock for Operator Update", function () {
        it("Should successfully schedule and execute operator update after 2 days", async function () {
            const { protocolRegistry, timelock, mockOperator } = await loadFixture(deployTimelockFixture);

            const target = await protocolRegistry.getAddress();
            const value = 0;
            const data = protocolRegistry.interface.encodeFunctionData("setOperator", [mockOperator.address]);
            const predecessor = ethersLib.ZeroHash;
            const salt = ethersLib.id("test-operator-update");

            await timelock.schedule(target, value, data, predecessor, salt, TWO_DAYS);
            const time = getTime();
            await time.increase(TWO_DAYS);
            await timelock.execute(target, value, data, predecessor, salt);

            expect(await protocolRegistry.safeOperator()).to.equal(mockOperator.address);
        });
    });

    describe("Immediate Admin Operations (No Timelock)", function () {
        it("Should allow admin to whitelist tokens immediately", async function () {
            const { protocolRegistry, admin } = await loadFixture(deployTimelockFixture);

            const testToken = "0x1234567890123456789012345678901234567890";

            await protocolRegistry.connect(admin).addToWhitelist(testToken);

            expect(await protocolRegistry.isWhitelisted(testToken)).to.be.true;
        });

        it("Should allow admin to set token mappings immediately", async function () {
            const { protocolRegistry, admin } = await loadFixture(deployTimelockFixture);

            const testToken = "0x1234567890123456789012345678901234567890";
            const testMContract = "0x2345678901234567890123456789012345678901";

            await protocolRegistry.connect(admin).setTokenMContract(testToken, testMContract);

            expect(await protocolRegistry.getMContract(testToken)).to.equal(testMContract);
        });

        it("Should allow admin to set Fluid vault resolver immediately", async function () {
            const { protocolRegistry, admin } = await loadFixture(deployTimelockFixture);

            const testResolver = "0x3456789012345678901234567890123456789012";

            await protocolRegistry.connect(admin).setFluidVaultResolver(testResolver);

            expect(await protocolRegistry.fluidVaultResolver()).to.equal(testResolver);
        });

        it("Should prevent non-admin from performing routine operations", async function () {
            const { protocolRegistry, user, DEFAULT_ADMIN_ROLE } = await loadFixture(deployTimelockFixture);

            const testToken = "0x1234567890123456789012345678901234567890";

            await expect(protocolRegistry.connect(user).addToWhitelist(testToken))
                .to.be.revertedWithCustomError(protocolRegistry, "AccessControlUnauthorizedAccount")
                .withArgs(user.address, DEFAULT_ADMIN_ROLE);
        });
    });

    describe("Operation Cancellation", function () {
        it("Should allow cancellation of scheduled Paraswap update", async function () {
            const { protocolRegistry, timelock, newMockParaswapAddress } = await loadFixture(deployTimelockFixture);

            const target = await protocolRegistry.getAddress();
            const value = 0;
            const data = protocolRegistry.interface.encodeFunctionData("setParaswapV6", [newMockParaswapAddress]);
            const predecessor = ethersLib.ZeroHash;
            const salt = ethersLib.id("test-cancel-operation");

            // Schedule
            await timelock.schedule(target, value, data, predecessor, salt, TWO_DAYS);

            const operationId = await timelock.hashOperation(target, value, data, predecessor, salt);

            // Verify it's pending
            expect(await timelock.isOperationPending(operationId)).to.be.true;

            // Cancel
            await timelock.cancel(operationId);

            // Verify it's no longer pending
            expect(await timelock.isOperationPending(operationId)).to.be.false;

            // Should not be able to execute
            const time = getTime();
            await time.increase(TWO_DAYS);
            await expect(timelock.execute(target, value, data, predecessor, salt)).to.be.revertedWithCustomError(
                timelock,
                "TimelockUnexpectedOperationState",
            );
        });
    });
});
