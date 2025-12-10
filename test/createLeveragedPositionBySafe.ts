import { time, loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
const { expect } = require("chai");
import { ethers } from "hardhat";
import "dotenv/config";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { LeveragedPosition } from "../typechain-types";
import { abi as ERC20_ABI } from "@openzeppelin/contracts/build/contracts/ERC20.json";
import { getDecimals, getParaswapData, protocolHelperMap } from "./utils";
import Safe from "@safe-global/protocol-kit";
import {
    USDC_ADDRESS,
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
import { mContractAddressMap, MoonwellHelper, COMPTROLLER_ADDRESS } from "./protocols/moonwell";
import { eip1193Provider, safeAddress } from "./debtSwapBySafe";
import { MetaTransactionData, OperationType } from "@safe-global/types-kit";
import { fluidVaultMap, FluidHelper } from "./protocols/fluid";

describe("Create leveraged position by Safe", function () {
    this.timeout(3000000); // 50 minutes

    let myContract: LeveragedPosition;
    let impersonatedSigner: HardhatEthersSigner;

    let deployedContractAddress: string;

    const defaultTargetSupplyAmount = "0.002";
    const cbBTCPrincipleAmount = 0.00006;

    let safeWallet;
    let operator: HardhatEthersSigner;
    const safeOwnerWallet = new ethers.Wallet(process.env.TESTING_SAFE_OWNER_KEY!, ethers.provider);

    this.beforeEach(async () => {
        impersonatedSigner = await ethers.getImpersonatedSigner(TEST_ADDRESS);

        // Get the operator (third signer)
        const signers = await ethers.getSigners();
        operator = signers[2];

        // Fund impersonatedSigner with ETH for gas fees
        const fundImpersonatedTx = await signers[0].sendTransaction({
            to: impersonatedSigner.address,
            value: ethers.parseEther("1"), // Send 1 ETH for gas fees
        });
        await fundImpersonatedTx.wait();
        console.log("Funded impersonatedSigner with 1 ETH for gas fees");

        const leveragedPosition = await loadFixture(deployLeveragedPositionContractFixture);
        deployedContractAddress = await leveragedPosition.getAddress();

        myContract = await ethers.getContractAt("LeveragedPosition", deployedContractAddress, impersonatedSigner);

        safeWallet = await Safe.init({
            provider: eip1193Provider,
            signer: process.env.TESTING_SAFE_OWNER_KEY,
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
                safeAddress, // _onBehalfOf parameter
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

    async function deleveragePosition(
        flashloanPool: string,
        protocol: Protocols,
        collateralAddress = cbETH_ADDRESS,
        debtAddress = USDC_ADDRESS,
        callViaOperator = false,
    ) {
        // Fund operator wallet with ETH if calling via operator
        if (callViaOperator) {
            const signers = await ethers.getSigners();
            const fundTx = await signers[0].sendTransaction({
                to: operator.address,
                value: ethers.parseEther("0.2"),
            });
            await fundTx.wait();
            console.log("Funded operator wallet with 0.2 ETH for gas fees");
        }

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

        // Add buffer to debt amount to account for interest accrual
        const debtAmountToPass = (debtAmountBefore * 103n) / 100n;

        // Get paraswap data to swap collateral to debt asset
        const paraswapData = await getParaswapData(
            debtAddress,
            collateralAddress,
            deployedContractAddress,
            debtAmountToPass,
        );

        // Get user's collateral token balance before closing
        const collateralToken = new ethers.Contract(collateralAddress, ERC20_ABI, impersonatedSigner);
        const userCollateralBalanceBefore = await collateralToken.balanceOf(safeAddress);

        console.log("=== deleveragePosition Parameters ===");
        console.log("flashloanPool:", flashloanPool);
        console.log("protocol:", protocol);
        console.log("collateralAddress:", collateralAddress);
        console.log("collateralAmountBefore:", ethers.formatUnits(collateralAmountBefore, collateralDecimals));
        console.log("debtAsset:", debtAddress);
        console.log("extraData:", extraData);
        console.log("paraswapData.srcAmount:", paraswapData.srcAmount.toString());
        console.log("paraswapData.swapData length:", paraswapData.swapData.length);
        console.log("=========================================");

        console.log("Original debt amount:", ethers.formatUnits(debtAmountBefore, debtDecimals));
        console.log("Debt amount with 1% buffer:", ethers.formatUnits(debtAmountToPass, debtDecimals));

        const debtAmountWithInterestBuffer = (debtAmountBefore * 102n) / 100n;

        if (callViaOperator) {
            // Call via operator directly
            console.log("=== Calling via Operator ===");
            const contractByOperator = await ethers.getContractAt(
                "LeveragedPosition",
                deployedContractAddress,
                operator,
            );

            const tx = await contractByOperator.deleveragePosition(
                flashloanPool,
                protocol,
                collateralAddress,
                collateralAmountBefore,
                debtAddress,
                debtAmountWithInterestBuffer,
                safeAddress, // onBehalfOf
                extraData,
                paraswapData,
                {
                    gasLimit: "10000000",
                },
            );
            await tx.wait();
            console.log("Operator close transaction completed");
        } else {
            // Call via Safe transaction
            console.log("=== Calling via Safe Transaction ===");

            // For Moonwell, we need to approve the mToken
            const transactions: MetaTransactionData[] = [];

            if (protocol === Protocols.MOONWELL) {
                const mTokenAddress = mContractAddressMap.get(collateralAddress)!;
                transactions.push({
                    to: mTokenAddress,
                    value: "0",
                    data: collateralToken.interface.encodeFunctionData("approve", [
                        deployedContractAddress,
                        MaxUint256,
                    ]),
                    operation: OperationType.Call,
                });
            }

            // Create close position transaction
            transactions.push({
                to: deployedContractAddress,
                value: "0",
                data: myContract.interface.encodeFunctionData("deleveragePosition", [
                    flashloanPool,
                    protocol,
                    collateralAddress,
                    collateralAmountBefore,
                    debtAddress,
                    debtAmountWithInterestBuffer,
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
        }

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

            // Wait for some time to accrue interest
            await time.increaseTo((await time.latest()) + 600); // 10 minutes

            console.log("Operator wallet address:", operator.address);

            // Close position via operator
            await deleveragePosition(ETH_USDC_POOL, Protocols.FLUID, cbETH_ADDRESS, USDC_ADDRESS, true);
        });
    });

    describe("on Moonwell", function () {
        it("create normal position and partially deleverage (repay 20%)", async function () {
            // Step 1: Create a normal (non-leveraged) position
            await createNormalPosition(
                Protocols.MOONWELL,
                cbETH_ADDRESS,
                USDC_ADDRESS,
                "0.002", // supply 0.002 cbETH
                "1", // borrow 1 USDC
            );

            // Wait for some time to accrue interest
            await time.increaseTo((await time.latest()) + 600); // 10 minutes

            // Step 2: Partially deleverage - repay 20% of debt
            await partialDeleveragePosition(
                ETH_USDC_POOL,
                Protocols.MOONWELL,
                cbETH_ADDRESS,
                USDC_ADDRESS,
                20n, // repay 20%
                true, // call via operator
            );
        });

        it("create and close position with cbETH collateral", async function () {
            await createLeveragedPosition(cbETH_ETH_POOL, Protocols.MOONWELL);

            await time.increaseTo((await time.latest()) + 3600); // 1 hour

            await deleveragePosition(ETH_USDC_POOL, Protocols.MOONWELL);
        });

        it("create and close position with WETH collateral", async function () {
            await createLeveragedPosition(cbETH_ETH_POOL, Protocols.MOONWELL, WETH_ADDRESS, USDC_ADDRESS);

            await time.increaseTo((await time.latest()) + 3600); // 1 hour

            await deleveragePosition(ETH_USDC_POOL, Protocols.MOONWELL, WETH_ADDRESS, USDC_ADDRESS);
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

    async function createNormalPosition(
        protocol: Protocols,
        collateralAddress: string,
        debtAddress: string,
        supplyAmountStr: string,
        borrowAmountStr: string,
    ) {
        await enableSafeModule();

        const collateralDecimals = await getDecimals(collateralAddress);
        const debtDecimals = await getDecimals(debtAddress);

        const collateralContract = new ethers.Contract(collateralAddress, ERC20_ABI, impersonatedSigner);
        const supplyAmount = ethers.parseUnits(supplyAmountStr, collateralDecimals);
        const borrowAmount = ethers.parseUnits(borrowAmountStr, debtDecimals);

        // Transfer collateral to Safe
        const transferTx = await collateralContract.transfer(safeAddress, supplyAmount);
        await transferTx.wait();
        console.log("Transferred collateral to Safe");

        if (protocol === Protocols.FLUID) {
            const vaultAddress = fluidVaultMap.get(collateralAddress)!;

            // Approve and supply collateral via Safe transaction
            const approveSupplyData: MetaTransactionData = {
                to: collateralAddress,
                value: "0",
                data: collateralContract.interface.encodeFunctionData("approve", [vaultAddress, MaxUint256]),
                operation: OperationType.Call,
            };

            // Get Fluid vault ABI for operate function
            const fluidVaultAbi = [
                "function operate(uint256 nftId_, int256 newCol_, int256 newDebt_, address to_) external returns (uint256, int256, int256)",
            ];
            const fluidVaultInterface = new ethers.Interface(fluidVaultAbi);

            // Supply collateral (nftId=0 for new position, positive newCol for supply, 0 for debt)
            const supplyData: MetaTransactionData = {
                to: vaultAddress,
                value: "0",
                data: fluidVaultInterface.encodeFunctionData("operate", [0, supplyAmount, 0, safeAddress]),
                operation: OperationType.Call,
            };

            let safeTransaction = await safeWallet.createTransaction({
                transactions: [approveSupplyData, supplyData],
            });
            await safeWallet.executeTransaction(safeTransaction, { gasLimit: "10000000" });
            console.log("Supplied collateral to Fluid");

            // Get nftId for the position
            const fluidHelper = new FluidHelper(impersonatedSigner);
            const nftId = await fluidHelper.getNftId(vaultAddress, safeAddress);
            console.log("Position NFT ID:", nftId.toString());
            expect(nftId).to.be.gt(0);

            // Borrow debt via Safe transaction
            const borrowData: MetaTransactionData = {
                to: vaultAddress,
                value: "0",
                data: fluidVaultInterface.encodeFunctionData("operate", [nftId, 0, borrowAmount, safeAddress]),
                operation: OperationType.Call,
            };

            safeTransaction = await safeWallet.createTransaction({
                transactions: [borrowData],
            });
            await safeWallet.executeTransaction(safeTransaction, { gasLimit: "10000000" });
            console.log("Borrowed debt from Fluid");

            // Verify position created
            const debtAmountAfter = await fluidHelper.getDebtAmount(vaultAddress, safeAddress);
            const collateralAmountAfter = await fluidHelper.getCollateralAmount(collateralAddress, safeAddress);
            console.log("Debt amount after borrow:", ethers.formatUnits(debtAmountAfter, debtDecimals));
            console.log("Collateral amount:", ethers.formatUnits(collateralAmountAfter, collateralDecimals));
            expect(debtAmountAfter).to.be.gt(0);
            expect(collateralAmountAfter).to.be.gt(0);
        } else if (protocol === Protocols.MOONWELL) {
            const mCollateralAddress = mContractAddressMap.get(collateralAddress)!;
            const mDebtAddress = mContractAddressMap.get(debtAddress)!;

            const MErc20DelegatorAbi = require("../externalAbi/moonwell/MErc20Delegator.json");
            const ComptrollerAbi = require("../externalAbi/moonwell/comptroller.json");

            const mCollateralContract = new ethers.Contract(mCollateralAddress, MErc20DelegatorAbi, impersonatedSigner);
            const mDebtContract = new ethers.Contract(mDebtAddress, MErc20DelegatorAbi, impersonatedSigner);
            const comptroller = new ethers.Contract(COMPTROLLER_ADDRESS, ComptrollerAbi, impersonatedSigner);

            // Approve collateral for mToken
            const approveData: MetaTransactionData = {
                to: collateralAddress,
                value: "0",
                data: collateralContract.interface.encodeFunctionData("approve", [mCollateralAddress, MaxUint256]),
                operation: OperationType.Call,
            };

            // Mint mToken (supply collateral)
            const mintData: MetaTransactionData = {
                to: mCollateralAddress,
                value: "0",
                data: mCollateralContract.interface.encodeFunctionData("mint", [supplyAmount]),
                operation: OperationType.Call,
            };

            // Enter markets (enable as collateral)
            const enterMarketsData: MetaTransactionData = {
                to: COMPTROLLER_ADDRESS,
                value: "0",
                data: comptroller.interface.encodeFunctionData("enterMarkets", [[mCollateralAddress]]),
                operation: OperationType.Call,
            };

            // Borrow debt
            const borrowData: MetaTransactionData = {
                to: mDebtAddress,
                value: "0",
                data: mDebtContract.interface.encodeFunctionData("borrow", [borrowAmount]),
                operation: OperationType.Call,
            };

            const safeTransaction = await safeWallet.createTransaction({
                transactions: [approveData, mintData, enterMarketsData, borrowData],
            });
            await safeWallet.executeTransaction(safeTransaction, { gasLimit: "10000000" });
            console.log("Created Moonwell position: supplied collateral, enabled as collateral, and borrowed");

            // Verify position created
            const moonwellHelper = new MoonwellHelper(impersonatedSigner);
            const debtAmountAfter = await moonwellHelper.getDebtAmount(debtAddress, safeAddress);
            const collateralAmountAfter = await moonwellHelper.getCollateralAmount(collateralAddress, safeAddress);
            console.log("Debt amount after borrow:", ethers.formatUnits(debtAmountAfter, debtDecimals));
            console.log("Collateral amount:", ethers.formatUnits(collateralAmountAfter, collateralDecimals));
            expect(debtAmountAfter).to.be.gt(0);
            expect(collateralAmountAfter).to.be.gt(0);
        }
    }

    async function partialDeleveragePosition(
        flashloanPool: string,
        protocol: Protocols,
        collateralAddress: string,
        debtAddress: string,
        repayPercentage: bigint,
        callViaOperator = true,
    ) {
        const collateralDecimals = await getDecimals(collateralAddress);
        const debtDecimals = await getDecimals(debtAddress);

        // Get current position state based on protocol
        let debtAmountBefore: bigint;
        let collateralAmountBefore: bigint;
        let extraData: string;

        if (protocol === Protocols.FLUID) {
            const vaultAddress = fluidVaultMap.get(collateralAddress)!;
            const fluidHelper = new FluidHelper(impersonatedSigner);

            debtAmountBefore = await fluidHelper.getDebtAmount(vaultAddress, safeAddress);
            collateralAmountBefore = await fluidHelper.getCollateralAmount(collateralAddress, safeAddress);

            // Get nftId for extraData
            const nftId = await fluidHelper.getNftId(vaultAddress, safeAddress);

            // Encode extraData for Fluid (isFullRepay = false for partial repay)
            extraData = ethers.AbiCoder.defaultAbiCoder().encode(
                ["address", "uint256", "bool"],
                [vaultAddress, nftId, false],
            );
        } else if (protocol === Protocols.MOONWELL) {
            const moonwellHelper = new MoonwellHelper(impersonatedSigner);

            debtAmountBefore = await moonwellHelper.getDebtAmount(debtAddress, safeAddress);
            collateralAmountBefore = await moonwellHelper.getCollateralAmount(collateralAddress, safeAddress);

            // Moonwell doesn't need special extraData
            extraData = "0x";
        } else {
            throw new Error(`Unsupported protocol: ${protocol}`);
        }

        console.log("Debt amount before:", ethers.formatUnits(debtAmountBefore, debtDecimals));
        console.log("Collateral amount before:", ethers.formatUnits(collateralAmountBefore, collateralDecimals));

        // Calculate debt to repay based on percentage
        const debtToRepay = (debtAmountBefore * repayPercentage) / 100n;
        const debtToRepayWithBuffer = (debtToRepay * 105n) / 100n; // 5% buffer

        console.log(`=== Partial Deleverage (${repayPercentage}%) ===`);
        console.log("Debt to repay:", ethers.formatUnits(debtToRepay, debtDecimals));

        // Get paraswap data
        const paraswapData = await getParaswapData(
            debtAddress,
            collateralAddress,
            deployedContractAddress,
            debtToRepayWithBuffer,
        );

        // Collateral amount with buffer for slippage
        const collateralToSell = (BigInt(paraswapData.srcAmount) * 110n) / 100n;

        console.log("Collateral to sell:", ethers.formatUnits(collateralToSell, collateralDecimals));

        // Get user's collateral token balance before
        const collateralContract = new ethers.Contract(collateralAddress, ERC20_ABI, impersonatedSigner);
        const userCollateralBalanceBefore = await collateralContract.balanceOf(safeAddress);

        if (callViaOperator) {
            // Fund operator wallet
            const signers = await ethers.getSigners();
            const fundTx = await signers[0].sendTransaction({
                to: operator.address,
                value: ethers.parseEther("0.2"),
            });
            await fundTx.wait();

            const contractByOperator = await ethers.getContractAt(
                "LeveragedPosition",
                deployedContractAddress,
                operator,
            );

            const tx = await contractByOperator.deleveragePosition(
                flashloanPool,
                protocol,
                collateralAddress,
                collateralToSell,
                debtAddress,
                debtToRepay,
                safeAddress,
                extraData,
                paraswapData,
                { gasLimit: "10000000" },
            );
            await tx.wait();
        } else {
            // Call via Safe transaction
            const transactions: MetaTransactionData[] = [];

            transactions.push({
                to: deployedContractAddress,
                value: "0",
                data: myContract.interface.encodeFunctionData("deleveragePosition", [
                    flashloanPool,
                    protocol,
                    collateralAddress,
                    collateralToSell,
                    debtAddress,
                    debtToRepay,
                    safeAddress,
                    extraData,
                    paraswapData,
                ]),
                operation: OperationType.Call,
            });

            const safeTransaction = await safeWallet.createTransaction({
                transactions: transactions,
            });
            await safeWallet.executeTransaction(safeTransaction, { gasLimit: "10000000" });
        }

        console.log("Partial deleverage completed");

        // Verify partial repayment based on protocol
        let debtAmountAfter: bigint;
        let collateralAmountAfter: bigint;

        if (protocol === Protocols.FLUID) {
            const vaultAddress = fluidVaultMap.get(collateralAddress)!;
            const fluidHelper = new FluidHelper(impersonatedSigner);
            debtAmountAfter = await fluidHelper.getDebtAmount(vaultAddress, safeAddress);
            collateralAmountAfter = await fluidHelper.getCollateralAmount(collateralAddress, safeAddress);
        } else {
            const moonwellHelper = new MoonwellHelper(impersonatedSigner);
            debtAmountAfter = await moonwellHelper.getDebtAmount(debtAddress, safeAddress);
            collateralAmountAfter = await moonwellHelper.getCollateralAmount(collateralAddress, safeAddress);
        }

        console.log("Debt amount after:", ethers.formatUnits(debtAmountAfter, debtDecimals));
        console.log("Collateral amount after:", ethers.formatUnits(collateralAmountAfter, collateralDecimals));

        // Debt should be reduced
        const expectedRemainingDebt = (debtAmountBefore * (100n - repayPercentage)) / 100n;
        expect(debtAmountAfter).to.be.gt(0); // Still has debt
        expect(debtAmountAfter).to.be.lt(debtAmountBefore); // Debt reduced
        expect(debtAmountAfter).to.be.closeTo(expectedRemainingDebt, expectedRemainingDebt / 10n);

        // Collateral should still exist
        expect(collateralAmountAfter).to.be.gt(0);
        expect(collateralAmountAfter).to.be.lt(collateralAmountBefore);

        // User should have received some collateral back
        const userCollateralBalanceAfter = await collateralContract.balanceOf(safeAddress);
        const collateralReturned = userCollateralBalanceAfter - userCollateralBalanceBefore;
        console.log("Collateral returned to user:", ethers.formatUnits(collateralReturned, collateralDecimals));

        // No tokens left in contract
        const contractCollateralBalance = await collateralContract.balanceOf(deployedContractAddress);
        expect(Number(contractCollateralBalance)).to.be.equal(0);

        const debtToken = new ethers.Contract(debtAddress, ERC20_ABI, impersonatedSigner);
        const contractDebtBalance = await debtToken.balanceOf(deployedContractAddress);
        console.log("Contract debt balance:", ethers.formatUnits(contractDebtBalance, debtDecimals));
    }

    describe("on Fluid", function () {
        it("create normal position and partially deleverage (repay 20%)", async function () {
            // Step 1: Create a normal (non-leveraged) position
            await createNormalPosition(
                Protocols.FLUID,
                cbETH_ADDRESS,
                USDC_ADDRESS,
                "0.002", // supply 0.002 cbETH
                "1", // borrow 1 USDC
            );

            // Wait for some time to accrue interest
            await time.increaseTo((await time.latest()) + 600); // 10 minutes

            // Step 2: Partially deleverage - repay 20% of debt
            await partialDeleveragePosition(
                ETH_USDC_POOL,
                Protocols.FLUID,
                cbETH_ADDRESS,
                USDC_ADDRESS,
                20n, // repay 20%
                true, // call via operator
            );
        });

        it("create and close position with WETH collateral", async function () {
            await createLeveragedPosition(ETH_USDbC_POOL, Protocols.FLUID, WETH_ADDRESS, USDC_ADDRESS);

            await time.increaseTo((await time.latest()) + 3600); // 1 hour

            await deleveragePosition(ETH_USDC_POOL, Protocols.FLUID, WETH_ADDRESS, USDC_ADDRESS);
        });

        it("create and close position with cbETH collateral", async function () {
            await createLeveragedPosition(cbETH_ETH_POOL, Protocols.FLUID);

            await time.increaseTo((await time.latest()) + 3600); // 1 hour

            await deleveragePosition(ETH_USDC_POOL, Protocols.FLUID);
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
