import { ethers } from "hardhat";
import { expect } from "chai";
import { deploySafeContractFixture } from "./deployUtils";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { Protocols, USDC_ADDRESS, DAI_ADDRESS, USDC_hyUSD_POOL } from "./constants";
import { SafeDebtManager } from "../typechain-types";

describe("SafeDebtManager Pausable", function () {
    let safeModuleContract: any;
    let owner: any;
    let user: any;
    let operator: any;
    let pauser: any;

    beforeEach(async function () {
        safeModuleContract = await loadFixture(deploySafeContractFixture);

        [owner, user, operator, pauser] = await ethers.getSigners();

        await safeModuleContract.setoperator(operator.address);
    });

    describe("Pause functionality", function () {
        it("Should allow pauser to pause the contract", async function () {
            expect(await safeModuleContract.pauser()).to.equal(pauser.address);
            expect(await safeModuleContract.paused()).to.equal(false);

            await safeModuleContract.connect(pauser).pause();

            expect(await safeModuleContract.paused()).to.equal(true);
        });

        it("Should allow pauser to unpause the contract", async function () {
            await safeModuleContract.connect(pauser).pause();
            expect(await safeModuleContract.paused()).to.equal(true);

            await safeModuleContract.connect(pauser).unpause();
            expect(await safeModuleContract.paused()).to.equal(false);
        });

        it("Should not allow non-pauser to pause the contract", async function () {
            // Try to pause with a non-pauser account
            await expect(safeModuleContract.connect(user).pause()).to.be.revertedWith(
                "Caller is not authorized to pause",
            );

            // Even the owner should not be able to pause directly
            await expect(safeModuleContract.connect(owner).pause()).to.be.revertedWith(
                "Caller is not authorized to pause",
            );
        });

        it("Should not allow non-pauser to unpause the contract", async function () {
            await safeModuleContract.connect(pauser).pause();

            await expect(safeModuleContract.connect(user).unpause()).to.be.revertedWith(
                "Caller is not authorized to pause",
            );

            await expect(safeModuleContract.connect(owner).unpause()).to.be.revertedWith(
                "Caller is not authorized to pause",
            );
        });
    });

    describe("Function behavior when paused", function () {
        beforeEach(async function () {
            await safeModuleContract.connect(pauser).pause();
        });

        it("Should not allow executeDebtSwap when contract is paused", async function () {
            const mockSafeAddress = owner.address;
            await expect(
                safeModuleContract
                    .connect(operator)
                    .executeDebtSwap(
                        USDC_hyUSD_POOL,
                        Protocols.AAVE_V3,
                        Protocols.AAVE_V3,
                        USDC_ADDRESS,
                        DAI_ADDRESS,
                        ethers.parseUnits("100", 6),
                        [],
                        mockSafeAddress,
                        ["0x", "0x"],
                        {
                            srcAmount: 0,
                            swapData: "0x",
                        },
                    ),
            ).to.be.revertedWithCustomError(safeModuleContract, "EnforcedPause");
        });

        it("Should not allow uniswapV3FlashCallback when contract is paused", async function () {
            await expect(safeModuleContract.uniswapV3FlashCallback(0, 0, "0x")).to.be.revertedWithCustomError(
                safeModuleContract,
                "EnforcedPause",
            );
        });

        it("Should still allow emergencyWithdraw when contract is paused", async function () {
            const tx = safeModuleContract.connect(owner).emergencyWithdraw(USDC_ADDRESS, 0);

            await expect(tx).not.to.be.revertedWithCustomError(safeModuleContract, "EnforcedPause");
        });
    });
});
