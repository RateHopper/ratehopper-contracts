import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { deployLeveragedPositionContractFixture, deploySafeContractFixture } from "./deployUtils";

describe("Emergency Withdraw ETH", function () {
    describe("LeveragedPosition", function () {
        it("should allow owner to withdraw ETH", async function () {
            const leveragedPosition = await loadFixture(deployLeveragedPositionContractFixture);
            const [owner] = await ethers.getSigners();
            const contractAddress = await leveragedPosition.getAddress();

            // Send ETH to the contract
            const sendAmount = ethers.parseEther("1.0");
            await owner.sendTransaction({
                to: contractAddress,
                value: sendAmount,
            });

            // Verify contract received ETH
            const contractBalanceBefore = await ethers.provider.getBalance(contractAddress);
            expect(contractBalanceBefore).to.equal(sendAmount);

            // Get owner balance before withdrawal
            const ownerBalanceBefore = await ethers.provider.getBalance(owner.address);

            // Withdraw ETH
            const withdrawAmount = ethers.parseEther("0.5");
            const tx = await leveragedPosition.emergencyWithdrawETH(withdrawAmount);
            const receipt = await tx.wait();
            const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

            // Verify contract balance decreased
            const contractBalanceAfter = await ethers.provider.getBalance(contractAddress);
            expect(contractBalanceAfter).to.equal(sendAmount - withdrawAmount);

            // Verify owner received ETH (minus gas)
            const ownerBalanceAfter = await ethers.provider.getBalance(owner.address);
            expect(ownerBalanceAfter).to.equal(ownerBalanceBefore + withdrawAmount - gasUsed);
        });

        it("should emit EmergencyETHWithdrawn event", async function () {
            const leveragedPosition = await loadFixture(deployLeveragedPositionContractFixture);
            const [owner] = await ethers.getSigners();
            const contractAddress = await leveragedPosition.getAddress();

            // Send ETH to the contract
            const sendAmount = ethers.parseEther("1.0");
            await owner.sendTransaction({
                to: contractAddress,
                value: sendAmount,
            });

            const withdrawAmount = ethers.parseEther("0.5");
            await expect(leveragedPosition.emergencyWithdrawETH(withdrawAmount))
                .to.emit(leveragedPosition, "EmergencyETHWithdrawn")
                .withArgs(withdrawAmount, owner.address);
        });

        it("should revert if non-owner tries to withdraw ETH", async function () {
            const leveragedPosition = await loadFixture(deployLeveragedPositionContractFixture);
            const [owner, nonOwner] = await ethers.getSigners();
            const contractAddress = await leveragedPosition.getAddress();

            // Send ETH to the contract
            await owner.sendTransaction({
                to: contractAddress,
                value: ethers.parseEther("1.0"),
            });

            // Try to withdraw as non-owner
            await expect(
                leveragedPosition.connect(nonOwner).emergencyWithdrawETH(ethers.parseEther("0.5"))
            ).to.be.revertedWithCustomError(leveragedPosition, "OwnableUnauthorizedAccount");
        });

        it("should revert if trying to withdraw more than balance", async function () {
            const leveragedPosition = await loadFixture(deployLeveragedPositionContractFixture);
            const [owner] = await ethers.getSigners();
            const contractAddress = await leveragedPosition.getAddress();

            // Send ETH to the contract
            await owner.sendTransaction({
                to: contractAddress,
                value: ethers.parseEther("1.0"),
            });

            // Try to withdraw more than balance
            await expect(
                leveragedPosition.emergencyWithdrawETH(ethers.parseEther("2.0"))
            ).to.be.revertedWith("Insufficient ETH balance");
        });

        it("should allow withdrawing full ETH balance", async function () {
            const leveragedPosition = await loadFixture(deployLeveragedPositionContractFixture);
            const [owner] = await ethers.getSigners();
            const contractAddress = await leveragedPosition.getAddress();

            // Send ETH to the contract
            const sendAmount = ethers.parseEther("1.0");
            await owner.sendTransaction({
                to: contractAddress,
                value: sendAmount,
            });

            // Withdraw full balance
            await leveragedPosition.emergencyWithdrawETH(sendAmount);

            // Verify contract has no ETH
            const contractBalanceAfter = await ethers.provider.getBalance(contractAddress);
            expect(contractBalanceAfter).to.equal(0);
        });
    });

    describe("SafeDebtManager", function () {
        it("should allow owner to withdraw ETH", async function () {
            const { safeModule } = await loadFixture(deploySafeContractFixture);
            const [owner] = await ethers.getSigners();
            const contractAddress = await safeModule.getAddress();

            // Send ETH to the contract
            const sendAmount = ethers.parseEther("1.0");
            await owner.sendTransaction({
                to: contractAddress,
                value: sendAmount,
            });

            // Verify contract received ETH
            const contractBalanceBefore = await ethers.provider.getBalance(contractAddress);
            expect(contractBalanceBefore).to.equal(sendAmount);

            // Get owner balance before withdrawal
            const ownerBalanceBefore = await ethers.provider.getBalance(owner.address);

            // Withdraw ETH
            const withdrawAmount = ethers.parseEther("0.5");
            const tx = await safeModule.emergencyWithdrawETH(withdrawAmount);
            const receipt = await tx.wait();
            const gasUsed = receipt!.gasUsed * receipt!.gasPrice;

            // Verify contract balance decreased
            const contractBalanceAfter = await ethers.provider.getBalance(contractAddress);
            expect(contractBalanceAfter).to.equal(sendAmount - withdrawAmount);

            // Verify owner received ETH (minus gas)
            const ownerBalanceAfter = await ethers.provider.getBalance(owner.address);
            expect(ownerBalanceAfter).to.equal(ownerBalanceBefore + withdrawAmount - gasUsed);
        });

        it("should emit EmergencyETHWithdrawn event", async function () {
            const { safeModule } = await loadFixture(deploySafeContractFixture);
            const [owner] = await ethers.getSigners();
            const contractAddress = await safeModule.getAddress();

            // Send ETH to the contract
            const sendAmount = ethers.parseEther("1.0");
            await owner.sendTransaction({
                to: contractAddress,
                value: sendAmount,
            });

            const withdrawAmount = ethers.parseEther("0.5");
            await expect(safeModule.emergencyWithdrawETH(withdrawAmount))
                .to.emit(safeModule, "EmergencyETHWithdrawn")
                .withArgs(withdrawAmount, owner.address);
        });

        it("should revert if non-owner tries to withdraw ETH", async function () {
            const { safeModule } = await loadFixture(deploySafeContractFixture);
            const [owner, nonOwner] = await ethers.getSigners();
            const contractAddress = await safeModule.getAddress();

            // Send ETH to the contract
            await owner.sendTransaction({
                to: contractAddress,
                value: ethers.parseEther("1.0"),
            });

            // Try to withdraw as non-owner
            await expect(
                safeModule.connect(nonOwner).emergencyWithdrawETH(ethers.parseEther("0.5"))
            ).to.be.revertedWithCustomError(safeModule, "OwnableUnauthorizedAccount");
        });

        it("should revert if trying to withdraw more than balance", async function () {
            const { safeModule } = await loadFixture(deploySafeContractFixture);
            const [owner] = await ethers.getSigners();
            const contractAddress = await safeModule.getAddress();

            // Send ETH to the contract
            await owner.sendTransaction({
                to: contractAddress,
                value: ethers.parseEther("1.0"),
            });

            // Try to withdraw more than balance
            await expect(
                safeModule.emergencyWithdrawETH(ethers.parseEther("2.0"))
            ).to.be.revertedWith("Insufficient ETH balance");
        });

        it("should allow withdrawing full ETH balance", async function () {
            const { safeModule } = await loadFixture(deploySafeContractFixture);
            const [owner] = await ethers.getSigners();
            const contractAddress = await safeModule.getAddress();

            // Send ETH to the contract
            const sendAmount = ethers.parseEther("1.0");
            await owner.sendTransaction({
                to: contractAddress,
                value: sendAmount,
            });

            // Withdraw full balance
            await safeModule.emergencyWithdrawETH(sendAmount);

            // Verify contract has no ETH
            const contractBalanceAfter = await ethers.provider.getBalance(contractAddress);
            expect(contractBalanceAfter).to.equal(0);
        });
    });
});
