import { time, loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
const { expect } = require("chai");
import { ethers } from "hardhat";
import "dotenv/config";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { LeveragedPosition } from "../typechain-types";
import { abi as ERC20_ABI } from "@openzeppelin/contracts/build/contracts/ERC20.json";
import { approve, getDecimals, getParaswapData, protocolHelperMap } from "./utils";
import Safe, { Eip1193Provider, RequestArguments } from "@safe-global/protocol-kit";
import {
    USDC_ADDRESS,
    USDbC_ADDRESS,
    cbETH_ADDRESS,
    TEST_ADDRESS,
    Protocols,
    WETH_ADDRESS,
    DEFAULT_SUPPLY_AMOUNT,
    cbETH_ETH_POOL,
    cbBTC_ADDRESS,
    cbBTC_USDC_POOL,
    ETH_USDC_POOL,
    ETH_USDbC_POOL,
} from "./constants";
import { MaxUint256 } from "ethers";
import { deployLeveragedPositionContractFixture } from "./deployUtils";
import { mcbETH, mContractAddressMap, MoonwellHelper } from "./protocols/moonwell";
import { eip1193Provider, safeAddress } from "./debtSwapBySafe";
import { MetaTransactionData, OperationType } from "@safe-global/types-kit";
import {
    FLUID_cbBTC_sUSDS_VAULT,
    FLUID_cbBTC_USDC_VAULT,
    FLUID_cbETH_USDC_VAULT,
    fluidVaultMap,
    FluidHelper,
} from "./protocols/fluid";

describe("Create leveraged position by Safe", function () {
    this.timeout(3000000); // 50 minutes

    let myContract: LeveragedPosition;
    let impersonatedSigner: HardhatEthersSigner;

    let deployedContractAddress: string;

    const defaultTargetSupplyAmount = "0.002";
    const cbBTCPrincipleAmount = 0.00006;

    let safeWallet;
    let operator: HardhatEthersSigner;
    const safeOwnerWallet = new ethers.Wallet(process.env.PRIVATE_KEY!, ethers.provider);

    this.beforeEach(async () => {
        impersonatedSigner = await ethers.getImpersonatedSigner(TEST_ADDRESS);

        // Get the operator (third signer)
        const signers = await ethers.getSigners();
        operator = signers[2];

        const leveragedPosition = await loadFixture(deployLeveragedPositionContractFixture);
        deployedContractAddress = await leveragedPosition.getAddress();

        myContract = await ethers.getContractAt("LeveragedPosition", deployedContractAddress, impersonatedSigner);

        safeWallet = await Safe.init({
            provider: eip1193Provider,
            signer: process.env.PRIVATE_KEY,
            safeAddress: safeAddress,
        });
    });

    async function enableSafeModule() {
        const enableModuleTx = await safeWallet.createEnableModuleTx(
            deployedContractAddress,
            // options // Optional
        );
        const safeTxHash = await safeWallet.executeTransaction(enableModuleTx);
        console.log("Safe enable module transaction");
        console.log("Modules:", await safeWallet.getModules());
    }

    async function createLeveragedPosition(
        flashloanPool: string,
        protocol: Protocols,
        collateralAddress = cbETH_ADDRESS,
        debtAddress = USDC_ADDRESS,
        principleAmount = Number(DEFAULT_SUPPLY_AMOUNT),
        targetAmount = Number(defaultTargetSupplyAmount),
    ) {
        await enableSafeModule();

        const Helper = protocolHelperMap.get(protocol)!;
        const protocolHelper = new Helper(impersonatedSigner);

        const collateralContract = new ethers.Contract(collateralAddress, ERC20_ABI, impersonatedSigner);

        const collateralDecimals = await getDecimals(collateralAddress);
        const debtDecimals = await getDecimals(debtAddress);

        let extraData = "0x";

        switch (protocol) {
            case Protocols.FLUID:
                const vaultAddress = fluidVaultMap.get(collateralAddress)!;
                // Encode with isFullRepay = false for Fluid create operation
                extraData = ethers.AbiCoder.defaultAbiCoder().encode(
                    ["address", "uint256", "bool"],
                    [vaultAddress, 0, false],
                );
                break;
        }

        const parsedTargetAmount = ethers.parseUnits(targetAmount.toString(), collateralDecimals);

        const diffAmount = parsedTargetAmount - ethers.parseUnits(principleAmount.toString(), collateralDecimals);

        const paraswapData = await getParaswapData(collateralAddress, debtAddress, deployedContractAddress, diffAmount);

        // send collateral token to safe
        const tx = await collateralContract.transfer(
            safeAddress,
            ethers.parseUnits(principleAmount.toString(), collateralDecimals),
        );
        await tx.wait();

        const approveTransactionData: MetaTransactionData = {
            to: collateralAddress,
            value: "0",
            data: collateralContract.interface.encodeFunctionData("approve", [
                deployedContractAddress,
                MaxUint256, // Use maximum approval to avoid repeated approvals
            ]),
            operation: OperationType.Call,
        };

        const createTransactionData: MetaTransactionData = {
            to: deployedContractAddress,
            value: "0",
            data: myContract.interface.encodeFunctionData("createLeveragedPosition", [
                flashloanPool,
                protocol,
                collateralAddress,
                ethers.parseUnits(principleAmount.toString(), collateralDecimals),
                parsedTargetAmount,
                debtAddress,
                extraData,
                paraswapData,
            ]),
            operation: OperationType.Call,
        };

        let safeTransaction;
        try {
            safeTransaction = await safeWallet.createTransaction({
                transactions: [approveTransactionData, createTransactionData],
            });
        } catch (error) {
            console.error("Error creating transaction:", error);
            throw error;
        }

        const safeTxHash = await safeWallet.executeTransaction(safeTransaction, {
            gasLimit: "10000000", // Total gas limit for the execution transaction
        });
        console.log(safeTxHash);

        const addressForDebtAmount = protocol === Protocols.FLUID ? fluidVaultMap.get(collateralAddress)! : debtAddress;

        const debtAmount = await protocolHelper.getDebtAmount(addressForDebtAmount, safeAddress);

        const collateralAmount = await protocolHelper.getCollateralAmount(collateralAddress, safeAddress);

        // For Fluid protocol, get and log the nftId
        if (protocol === Protocols.FLUID) {
            const fluidHelper = new FluidHelper(impersonatedSigner);
            const vaultAddress = fluidVaultMap.get(collateralAddress)!;
            const nftId = await fluidHelper.getNftId(vaultAddress, safeAddress);
            console.log("Fluid Position NFT ID:", nftId.toString());
            expect(nftId).to.be.gt(0);
        }

        expect(debtAmount).to.be.gt(0);
        expect(Number(collateralAmount)).to.be.gt(0);

        const collateralToken = new ethers.Contract(collateralAddress, ERC20_ABI, impersonatedSigner);
        const collateralRemainingBalance = await collateralToken.balanceOf(deployedContractAddress);
        expect(Number(collateralRemainingBalance)).to.be.equal(0);

        const debtToken = new ethers.Contract(debtAddress, ERC20_ABI, impersonatedSigner);
        const debtRemainingBalance = await debtToken.balanceOf(deployedContractAddress);
        expect(Number(debtRemainingBalance)).to.be.equal(0);
    }

    async function closeLeveragedPosition(
        flashloanPool: string,
        protocol: Protocols,
        collateralAddress = cbETH_ADDRESS,
        debtAddress = USDC_ADDRESS,
    ) {
        const Helper = protocolHelperMap.get(protocol)!;
        const protocolHelper = new Helper(impersonatedSigner);

        const collateralDecimals = await getDecimals(collateralAddress);
        const debtDecimals = await getDecimals(debtAddress);

        // Get current debt and collateral amounts before closing
        const addressForDebtAmount = protocol === Protocols.FLUID ? fluidVaultMap.get(collateralAddress)! : debtAddress;
        const debtAmountBefore = await protocolHelper.getDebtAmount(addressForDebtAmount, safeAddress);
        console.log("Debt amount before closing: ", ethers.formatUnits(debtAmountBefore, debtDecimals));

        const collateralAmountBefore = await protocolHelper.getCollateralAmount(collateralAddress, safeAddress);
        console.log(
            "Collateral amount before closing: ",
            ethers.formatUnits(collateralAmountBefore, collateralDecimals),
        );

        let extraData = "0x";
        switch (protocol) {
            case Protocols.FLUID:
                const fluidHelper = new FluidHelper(impersonatedSigner);
                const vaultAddress = fluidVaultMap.get(collateralAddress)!;
                const nftIdBefore = await fluidHelper.getNftId(vaultAddress, safeAddress);
                console.log("Fluid Position NFT ID before closing:", nftIdBefore.toString());

                // Encode with isFullRepay = true for Fluid close operation
                extraData = ethers.AbiCoder.defaultAbiCoder().encode(
                    ["address", "uint256", "bool"],
                    [vaultAddress, nftIdBefore, true],
                );
                break;
        }

        // Get paraswap data to swap collateral to debt asset
        const paraswapData = await getParaswapData(
            debtAddress,
            collateralAddress,
            deployedContractAddress,
            debtAmountBefore,
        );

        // Get user's collateral token balance before closing
        const collateralToken = new ethers.Contract(collateralAddress, ERC20_ABI, impersonatedSigner);
        const userCollateralBalanceBefore = await collateralToken.balanceOf(safeAddress);

        console.log("=== closeLeveragedPosition Parameters ===");
        console.log("flashloanPool:", flashloanPool);
        console.log("protocol:", protocol);
        console.log("collateralAddress:", collateralAddress);
        console.log("collateralAmountBefore:", ethers.formatUnits(collateralAmountBefore, collateralDecimals));
        console.log("debtAsset:", debtAddress);
        console.log("extraData:", extraData);
        console.log("paraswapData.srcAmount:", paraswapData.srcAmount.toString());
        console.log("paraswapData.swapData length:", paraswapData.swapData.length);
        console.log("=========================================");

        // Add buffer to debt amount to account for interest accrual
        const debtAmountToPass = (debtAmountBefore * 101n) / 100n;

        console.log("Original debt amount:", ethers.formatUnits(debtAmountBefore, debtDecimals));
        console.log("Debt amount with 1% buffer:", ethers.formatUnits(debtAmountToPass, debtDecimals));

        // For Moonwell, we need to approve the mToken
        const transactions: MetaTransactionData[] = [];

        if (protocol === Protocols.MOONWELL) {
            const mTokenAddress = mContractAddressMap.get(collateralAddress)!;
            transactions.push({
                to: mTokenAddress,
                value: "0",
                data: collateralToken.interface.encodeFunctionData("approve", [deployedContractAddress, MaxUint256]),
                operation: OperationType.Call,
            });
        }

        // Create close position transaction
        transactions.push({
            to: deployedContractAddress,
            value: "0",
            data: myContract.interface.encodeFunctionData("closeLeveragedPosition", [
                flashloanPool,
                protocol,
                collateralAddress,
                collateralAmountBefore,
                debtAddress,
                debtAmountToPass,
                safeAddress,
                extraData,
                paraswapData,
            ]),
            operation: OperationType.Call,
        });

        let safeTransaction;
        try {
            safeTransaction = await safeWallet.createTransaction({
                transactions: transactions,
            });
        } catch (error) {
            console.error("Error creating transaction:", error);
            throw error;
        }

        const safeTxHash = await safeWallet.executeTransaction(safeTransaction, {
            gasLimit: "10000000",
        });
        console.log(safeTxHash);

        // Verify debt is now 0
        const debtAmountAfter = await protocolHelper.getDebtAmount(addressForDebtAmount, safeAddress);
        console.log("Debt amount after closing: ", ethers.formatUnits(debtAmountAfter, debtDecimals));
        expect(debtAmountAfter).to.equal(0);

        // Verify collateral in protocol is now 0 or dust
        const collateralAmountAfter = await protocolHelper.getCollateralAmount(collateralAddress, safeAddress);
        console.log("Collateral amount after closing: ", ethers.formatUnits(collateralAmountAfter, collateralDecimals));
        const dustTolerance = ethers.parseUnits("0.00001", collateralDecimals);
        expect(collateralAmountAfter).to.be.lte(dustTolerance);

        // Verify user received collateral back
        const userCollateralBalanceAfter = await collateralToken.balanceOf(safeAddress);
        const collateralReturned = userCollateralBalanceAfter - userCollateralBalanceBefore;
        console.log("Collateral returned to user: ", ethers.formatUnits(collateralReturned, collateralDecimals));
        expect(collateralReturned).to.be.gt(0);

        // Verify no tokens left in contract
        const collateralRemainingBalance = await collateralToken.balanceOf(deployedContractAddress);
        expect(Number(collateralRemainingBalance)).to.be.equal(0);

        const debtToken = new ethers.Contract(debtAddress, ERC20_ABI, impersonatedSigner);
        const debtRemainingBalance = await debtToken.balanceOf(deployedContractAddress);
        console.log("Debt remaining balance in contract: ", ethers.formatUnits(debtRemainingBalance, debtDecimals));
    }

    describe("Operator functionality", function () {
        it("operator can close leveraged position on Fluid", async function () {
            // Fund impersonatedSigner for creating the position
            const signers = await ethers.getSigners();
            const fundImpersonatedTx = await signers[0].sendTransaction({
                to: impersonatedSigner.address,
                value: ethers.parseEther("0.5"), // Send 0.5 ETH for gas fees
            });
            await fundImpersonatedTx.wait();
            console.log("Funded impersonatedSigner with 0.5 ETH for gas fees");

            // Create position first using Safe
            await createLeveragedPosition(cbETH_ETH_POOL, Protocols.FLUID);

            // await time.increaseTo((await time.latest()) + 3600); // 1 hour
            await time.increaseTo((await time.latest()) + 600); // 10 minutes

            console.log("Operator wallet address:", operator.address);

            // Fund operator wallet with ETH for gas fees using hardhat default account
            const fundTx = await signers[0].sendTransaction({
                to: operator.address,
                value: ethers.parseEther("0.2"), // Send 0.2 ETH for gas fees
            });
            await fundTx.wait();
            console.log("Funded operator wallet with 0.2 ETH for gas fees");

            // Get protocol helper to query position data
            const fluidHelper = new FluidHelper(impersonatedSigner);
            const vaultAddress = fluidVaultMap.get(cbETH_ADDRESS)!;
            const addressForDebtAmount = vaultAddress;
            const debtAmountBefore = await fluidHelper.getDebtAmount(addressForDebtAmount, safeAddress);
            const collateralAmountBefore = await fluidHelper.getCollateralAmount(cbETH_ADDRESS, safeAddress);
            const nftId = await fluidHelper.getNftId(vaultAddress, safeAddress);

            console.log("Debt before operator close:", ethers.formatUnits(debtAmountBefore, 6));
            console.log("Collateral before operator close:", ethers.formatUnits(collateralAmountBefore, 18));
            console.log("Fluid Position NFT ID:", nftId.toString());

            // Add 1% buffer to debt amount
            const debtAmountToPass = (debtAmountBefore * 101n) / 100n;

            // Encode extraData for Fluid with isFullRepay = true
            const extraData = ethers.AbiCoder.defaultAbiCoder().encode(
                ["address", "uint256", "bool"],
                [vaultAddress, nftId, true],
            );

            // Get paraswap data
            const paraswapData = await getParaswapData(
                USDC_ADDRESS,
                cbETH_ADDRESS,
                deployedContractAddress,
                debtAmountBefore,
            );

            // Connect contract to operator
            const contractByOperator = await ethers.getContractAt(
                "LeveragedPosition",
                deployedContractAddress,
                operator,
            );

            // Call closeLeveragedPosition from operator wallet
            const tx = await contractByOperator.closeLeveragedPosition(
                ETH_USDC_POOL,
                Protocols.FLUID,
                cbETH_ADDRESS,
                collateralAmountBefore,
                USDC_ADDRESS,
                debtAmountToPass,
                safeAddress, // onBehalfOf
                extraData,
                paraswapData,
                {
                    gasLimit: "10000000",
                },
            );
            await tx.wait();

            // Verify debt is now 0
            const debtAmountAfter = await fluidHelper.getDebtAmount(addressForDebtAmount, safeAddress);
            console.log("Debt after operator close:", ethers.formatUnits(debtAmountAfter, 6));
            expect(debtAmountAfter).to.equal(0);
        });
    });

    describe("on Moonwell", function () {
        it("create and close position with cbETH collateral", async function () {
            await createLeveragedPosition(cbETH_ETH_POOL, Protocols.MOONWELL);

            await time.increaseTo((await time.latest()) + 3600); // 1 hour

            await closeLeveragedPosition(ETH_USDC_POOL, Protocols.MOONWELL);
        });

        it("create and close position with WETH collateral", async function () {
            await createLeveragedPosition(cbETH_ETH_POOL, Protocols.MOONWELL, WETH_ADDRESS, USDC_ADDRESS);

            await time.increaseTo((await time.latest()) + 3600); // 1 hour

            await closeLeveragedPosition(ETH_USDC_POOL, Protocols.MOONWELL, WETH_ADDRESS, USDC_ADDRESS);
        });

        it("with cbBTC collateral", async function () {
            const cbBTCPrincipleAmount = 0.00006;
            const targetAmount = cbBTCPrincipleAmount * 2;
            await createLeveragedPosition(
                cbBTC_USDC_POOL,
                Protocols.MOONWELL,
                cbBTC_ADDRESS,
                USDC_ADDRESS,
                cbBTCPrincipleAmount,
                targetAmount,
            );
        });

        it("with USDC collateral, cbETH debt", async function () {
            const principleAmount = 0.1;
            const targetAmount = principleAmount * 2;

            await createLeveragedPosition(
                cbBTC_USDC_POOL,
                Protocols.MOONWELL,
                USDC_ADDRESS,
                cbETH_ADDRESS,
                principleAmount,
                targetAmount,
            );
        });
    });

    describe("on Fluid", function () {
        it("create and close position with WETH collateral", async function () {
            await createLeveragedPosition(ETH_USDbC_POOL, Protocols.FLUID, WETH_ADDRESS, USDC_ADDRESS);

            await time.increaseTo((await time.latest()) + 3600); // 1 hour

            await closeLeveragedPosition(ETH_USDC_POOL, Protocols.FLUID, WETH_ADDRESS, USDC_ADDRESS);
        });

        it("create and close position with cbETH collateral", async function () {
            await createLeveragedPosition(cbETH_ETH_POOL, Protocols.FLUID);

            await time.increaseTo((await time.latest()) + 3600); // 1 hour

            await closeLeveragedPosition(ETH_USDC_POOL, Protocols.FLUID);
        });

        it("with cbBTC collateral", async function () {
            const cbBTCPrincipleAmount = 0.00006;
            const targetAmount = cbBTCPrincipleAmount * 2;
            await createLeveragedPosition(
                cbBTC_USDC_POOL,
                Protocols.FLUID,
                cbBTC_ADDRESS,
                USDC_ADDRESS,
                cbBTCPrincipleAmount,
                targetAmount,
            );
        });
    });
});
