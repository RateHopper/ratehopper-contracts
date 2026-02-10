import { loadFixture, time, setNextBlockBaseFeePerGas } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { deploySafeContractFixture, deployHandlers } from "./deployUtils";
import { Protocols } from "./constants";

// Helper to get CRITICAL_ROLE bytes32
const CRITICAL_ROLE = ethers.keccak256(ethers.toUtf8Bytes("CRITICAL_ROLE"));

// Timelock delay (2 days in seconds)
const TWO_DAYS = 2 * 24 * 60 * 60;

describe("Set Protocol Handler", function () {
    // Reset base fee before each test to avoid gas price issues on forked networks
    beforeEach(async function () {
        await setNextBlockBaseFeePerGas(1n);
    });
    describe("LeveragedPosition", function () {
        async function deployLeveragedPositionWithRegistry() {
            const { aaveV3Handler, compoundHandler, moonwellHandler, fluidHandler, morphoHandler, protocolRegistry } =
                await deployHandlers();

            const signers = await ethers.getSigners();
            const pauser = signers[3];

            const LeveragedPosition = await ethers.getContractFactory("LeveragedPosition");
            const leveragedPosition = await LeveragedPosition.deploy(
                await protocolRegistry.getAddress(),
                [Protocols.AAVE_V3, Protocols.COMPOUND, Protocols.MORPHO, Protocols.MOONWELL, Protocols.FLUID],
                [
                    await aaveV3Handler.getAddress(),
                    await compoundHandler.getAddress(),
                    await morphoHandler.getAddress(),
                    await moonwellHandler.getAddress(),
                    await fluidHandler.getAddress(),
                ],
                pauser.address,
            );

            // Get the timelock contract
            const timelockAddress = await protocolRegistry.timelock();
            const timelock = await ethers.getContractAt("TimelockController", timelockAddress);

            return { leveragedPosition, protocolRegistry, timelock };
        }

        it("should allow address with CRITICAL_ROLE (timelock) to update handler via schedule/execute", async function () {
            const { leveragedPosition, timelock } = await loadFixture(deployLeveragedPositionWithRegistry);

            // Get current handler
            const oldHandler = await leveragedPosition.protocolHandlers(Protocols.AAVE_V3);

            // Create a new dummy handler address
            const newHandler = ethers.Wallet.createRandom().address;

            // Encode the setProtocolHandler call
            const callData = leveragedPosition.interface.encodeFunctionData("setProtocolHandler", [
                Protocols.AAVE_V3,
                newHandler,
            ]);

            const target = await leveragedPosition.getAddress();
            const value = 0;
            const predecessor = ethers.ZeroHash;
            const salt = ethers.ZeroHash;
            const delay = TWO_DAYS;

            // Schedule the transaction
            await timelock.schedule(target, value, callData, predecessor, salt, delay);

            // Increase time by 2 days
            await time.increase(TWO_DAYS);

            // Execute the transaction
            await expect(timelock.execute(target, value, callData, predecessor, salt))
                .to.emit(leveragedPosition, "ProtocolHandlerUpdated")
                .withArgs(Protocols.AAVE_V3, oldHandler, newHandler);

            // Verify handler was updated
            expect(await leveragedPosition.protocolHandlers(Protocols.AAVE_V3)).to.equal(newHandler);
        });

        it("should revert if caller does not have CRITICAL_ROLE", async function () {
            const { leveragedPosition } = await loadFixture(deployLeveragedPositionWithRegistry);
            const [, nonOwner] = await ethers.getSigners();

            const newHandler = ethers.Wallet.createRandom().address;

            // Try to update handler as non-owner without CRITICAL_ROLE
            await expect(
                leveragedPosition.connect(nonOwner).setProtocolHandler(Protocols.AAVE_V3, newHandler),
            ).to.be.revertedWith("Caller does not have CRITICAL_ROLE");
        });

        it("should revert if new handler is zero address", async function () {
            const { leveragedPosition, timelock } = await loadFixture(deployLeveragedPositionWithRegistry);

            // Encode the setProtocolHandler call with zero address
            const callData = leveragedPosition.interface.encodeFunctionData("setProtocolHandler", [
                Protocols.AAVE_V3,
                ethers.ZeroAddress,
            ]);

            const target = await leveragedPosition.getAddress();
            const value = 0;
            const predecessor = ethers.ZeroHash;
            const salt = ethers.ZeroHash;
            const delay = TWO_DAYS;

            // Schedule the transaction
            await timelock.schedule(target, value, callData, predecessor, salt, delay);

            // Increase time by 2 days
            await time.increase(TWO_DAYS);

            // Execute should revert - the underlying tx reverts with "Invalid handler address"
            await expect(timelock.execute(target, value, callData, predecessor, salt)).to.be.reverted;
        });

        it("should allow updating an existing handler to a new address", async function () {
            const { leveragedPosition, timelock } = await loadFixture(deployLeveragedPositionWithRegistry);

            // Get current handler for AAVE_V3
            const oldHandler = await leveragedPosition.protocolHandlers(Protocols.AAVE_V3);
            expect(oldHandler).to.not.equal(ethers.ZeroAddress);

            const newHandler = ethers.Wallet.createRandom().address;

            // Encode the setProtocolHandler call
            const callData = leveragedPosition.interface.encodeFunctionData("setProtocolHandler", [
                Protocols.AAVE_V3,
                newHandler,
            ]);

            const target = await leveragedPosition.getAddress();
            const value = 0;
            const predecessor = ethers.ZeroHash;
            const salt = ethers.ZeroHash;
            const delay = TWO_DAYS;

            // Schedule the transaction
            await timelock.schedule(target, value, callData, predecessor, salt, delay);

            // Increase time by 2 days
            await time.increase(TWO_DAYS);

            // Execute the transaction
            await expect(timelock.execute(target, value, callData, predecessor, salt))
                .to.emit(leveragedPosition, "ProtocolHandlerUpdated")
                .withArgs(Protocols.AAVE_V3, oldHandler, newHandler);

            expect(await leveragedPosition.protocolHandlers(Protocols.AAVE_V3)).to.equal(newHandler);
        });

        it("should allow admin to revoke CRITICAL_ROLE via registry", async function () {
            const { leveragedPosition, protocolRegistry } = await loadFixture(deployLeveragedPositionWithRegistry);
            const [, newAdmin] = await ethers.getSigners();

            // Grant CRITICAL_ROLE to newAdmin via registry
            await protocolRegistry.grantRole(CRITICAL_ROLE, newAdmin.address);

            // Verify newAdmin can update handler
            const handler1 = ethers.Wallet.createRandom().address;
            await leveragedPosition.connect(newAdmin).setProtocolHandler(Protocols.AAVE_V3, handler1);

            // Revoke CRITICAL_ROLE from newAdmin via registry
            await protocolRegistry.revokeRole(CRITICAL_ROLE, newAdmin.address);

            // newAdmin should no longer be able to update handler
            const newHandler = ethers.Wallet.createRandom().address;
            await expect(
                leveragedPosition.connect(newAdmin).setProtocolHandler(Protocols.AAVE_V3, newHandler),
            ).to.be.revertedWith("Caller does not have CRITICAL_ROLE");
        });

        it("should revert execution if timelock delay has not passed", async function () {
            const { leveragedPosition, timelock } = await loadFixture(deployLeveragedPositionWithRegistry);

            const newHandler = ethers.Wallet.createRandom().address;

            // Encode the setProtocolHandler call
            const callData = leveragedPosition.interface.encodeFunctionData("setProtocolHandler", [
                Protocols.AAVE_V3,
                newHandler,
            ]);

            const target = await leveragedPosition.getAddress();
            const value = 0;
            const predecessor = ethers.ZeroHash;
            const salt = ethers.ZeroHash;
            const delay = TWO_DAYS;

            // Schedule the transaction
            await timelock.schedule(target, value, callData, predecessor, salt, delay);

            // Try to execute immediately without waiting - should revert
            await expect(timelock.execute(target, value, callData, predecessor, salt)).to.be.reverted;
        });

    });

    describe("SafeDebtManager", function () {
        it("should allow address with CRITICAL_ROLE (timelock) to update handler via schedule/execute", async function () {
            const { safeModule, protocolRegistry } = await loadFixture(deploySafeContractFixture);

            // Get the timelock contract
            const timelockAddress = await protocolRegistry.timelock();
            const timelock = await ethers.getContractAt("TimelockController", timelockAddress);

            // Get current handler
            const oldHandler = await safeModule.protocolHandlers(Protocols.AAVE_V3);

            // Create a new dummy handler address
            const newHandler = ethers.Wallet.createRandom().address;

            // Encode the setProtocolHandler call
            const callData = safeModule.interface.encodeFunctionData("setProtocolHandler", [
                Protocols.AAVE_V3,
                newHandler,
            ]);

            const target = await safeModule.getAddress();
            const value = 0;
            const predecessor = ethers.ZeroHash;
            const salt = ethers.ZeroHash;
            const delay = TWO_DAYS;

            // Schedule the transaction
            await timelock.schedule(target, value, callData, predecessor, salt, delay);

            // Increase time by 2 days
            await time.increase(TWO_DAYS);

            // Execute the transaction
            await expect(timelock.execute(target, value, callData, predecessor, salt))
                .to.emit(safeModule, "ProtocolHandlerUpdated")
                .withArgs(Protocols.AAVE_V3, oldHandler, newHandler);

            // Verify handler was updated
            expect(await safeModule.protocolHandlers(Protocols.AAVE_V3)).to.equal(newHandler);
        });

        it("should revert if caller does not have CRITICAL_ROLE", async function () {
            const { safeModule } = await loadFixture(deploySafeContractFixture);
            const [, nonOwner] = await ethers.getSigners();

            const newHandler = ethers.Wallet.createRandom().address;

            // Try to update handler as non-owner without CRITICAL_ROLE
            await expect(
                safeModule.connect(nonOwner).setProtocolHandler(Protocols.AAVE_V3, newHandler),
            ).to.be.revertedWith("Caller does not have CRITICAL_ROLE");
        });

        it("should revert if new handler is zero address", async function () {
            const { safeModule, protocolRegistry } = await loadFixture(deploySafeContractFixture);

            // Get the timelock contract
            const timelockAddress = await protocolRegistry.timelock();
            const timelock = await ethers.getContractAt("TimelockController", timelockAddress);

            // Encode the setProtocolHandler call with zero address
            const callData = safeModule.interface.encodeFunctionData("setProtocolHandler", [
                Protocols.AAVE_V3,
                ethers.ZeroAddress,
            ]);

            const target = await safeModule.getAddress();
            const value = 0;
            const predecessor = ethers.ZeroHash;
            const salt = ethers.ZeroHash;
            const delay = TWO_DAYS;

            // Schedule the transaction
            await timelock.schedule(target, value, callData, predecessor, salt, delay);

            // Increase time by 2 days
            await time.increase(TWO_DAYS);

            // Execute should revert
            await expect(timelock.execute(target, value, callData, predecessor, salt)).to.be.reverted;
        });

        it("should allow updating an existing handler to a new address", async function () {
            const { safeModule, protocolRegistry } = await loadFixture(deploySafeContractFixture);

            // Get the timelock contract
            const timelockAddress = await protocolRegistry.timelock();
            const timelock = await ethers.getContractAt("TimelockController", timelockAddress);

            // Get current handler for AAVE_V3
            const oldHandler = await safeModule.protocolHandlers(Protocols.AAVE_V3);
            expect(oldHandler).to.not.equal(ethers.ZeroAddress);

            const newHandler = ethers.Wallet.createRandom().address;

            // Encode the setProtocolHandler call
            const callData = safeModule.interface.encodeFunctionData("setProtocolHandler", [
                Protocols.AAVE_V3,
                newHandler,
            ]);

            const target = await safeModule.getAddress();
            const value = 0;
            const predecessor = ethers.ZeroHash;
            const salt = ethers.ZeroHash;
            const delay = TWO_DAYS;

            // Schedule the transaction
            await timelock.schedule(target, value, callData, predecessor, salt, delay);

            // Increase time by 2 days
            await time.increase(TWO_DAYS);

            // Execute the transaction
            await expect(timelock.execute(target, value, callData, predecessor, salt))
                .to.emit(safeModule, "ProtocolHandlerUpdated")
                .withArgs(Protocols.AAVE_V3, oldHandler, newHandler);

            expect(await safeModule.protocolHandlers(Protocols.AAVE_V3)).to.equal(newHandler);
        });

        it("should allow admin to revoke CRITICAL_ROLE via registry", async function () {
            const { safeModule, protocolRegistry } = await loadFixture(deploySafeContractFixture);
            const [, newAdmin] = await ethers.getSigners();

            // Grant CRITICAL_ROLE to newAdmin via registry
            await protocolRegistry.grantRole(CRITICAL_ROLE, newAdmin.address);

            // Verify newAdmin can update handler
            const handler1 = ethers.Wallet.createRandom().address;
            await safeModule.connect(newAdmin).setProtocolHandler(Protocols.AAVE_V3, handler1);

            // Revoke CRITICAL_ROLE from newAdmin via registry
            await protocolRegistry.revokeRole(CRITICAL_ROLE, newAdmin.address);

            // newAdmin should no longer be able to update handler
            const newHandler = ethers.Wallet.createRandom().address;
            await expect(
                safeModule.connect(newAdmin).setProtocolHandler(Protocols.AAVE_V3, newHandler),
            ).to.be.revertedWith("Caller does not have CRITICAL_ROLE");
        });

        it("should revert execution if timelock delay has not passed", async function () {
            const { safeModule, protocolRegistry } = await loadFixture(deploySafeContractFixture);

            // Get the timelock contract
            const timelockAddress = await protocolRegistry.timelock();
            const timelock = await ethers.getContractAt("TimelockController", timelockAddress);

            const newHandler = ethers.Wallet.createRandom().address;

            // Encode the setProtocolHandler call
            const callData = safeModule.interface.encodeFunctionData("setProtocolHandler", [
                Protocols.AAVE_V3,
                newHandler,
            ]);

            const target = await safeModule.getAddress();
            const value = 0;
            const predecessor = ethers.ZeroHash;
            const salt = ethers.ZeroHash;
            const delay = TWO_DAYS;

            // Schedule the transaction
            await timelock.schedule(target, value, callData, predecessor, salt, delay);

            // Try to execute immediately without waiting - should revert
            await expect(timelock.execute(target, value, callData, predecessor, salt)).to.be.reverted;
        });

    });
});
