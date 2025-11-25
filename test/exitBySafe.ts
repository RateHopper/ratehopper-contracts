import { ethers } from "hardhat";
import dotenv from "dotenv";
dotenv.config();
import Safe from "@safe-global/protocol-kit";
import { cbETH_ADDRESS, DEFAULT_SUPPLY_AMOUNT, Protocols, USDC_ADDRESS, WETH_ADDRESS } from "./constants";
import { abi as ERC20_ABI } from "@openzeppelin/contracts/build/contracts/ERC20.json";
import { MetaTransactionData, OperationType } from "@safe-global/types-kit";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { fundETH } from "./utils";
import { FLUID_cbETH_USDC_VAULT, FLUID_WETH_USDC_VAULT, FluidHelper } from "./protocols/fluid";
import { CompoundHelper, USDC_COMET_ADDRESS } from "./protocols/compound";
import { morphoMarket1Id, MorphoHelper } from "./protocols/morpho";
import { AaveV3Helper } from "./protocols/aaveV3";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { deploySafeContractFixture } from "./deployUtils";
import { eip1193Provider, safeAddress, createSafeTestHelpers } from "./debtSwapBySafe";

describe("Safe wallet exit function tests", function () {
    // Increase timeout for memory-intensive operations
    this.timeout(300000); // 5 minutes

    const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, ethers.provider);
    let operator: HardhatEthersSigner;
    let safeWallet;
    let safeModuleContract;
    let safeModuleAddress;
    let helpers: ReturnType<typeof createSafeTestHelpers>;

    this.beforeEach(async () => {
        // Get the operator (third signer)
        const signers = await ethers.getSigners();
        operator = signers[2];

        safeWallet = await Safe.init({
            provider: eip1193Provider,
            signer: process.env.PRIVATE_KEY,
            safeAddress: safeAddress,
        });

        const { safeModule } = await loadFixture(deploySafeContractFixture);
        safeModuleContract = safeModule;
        safeModuleAddress = await safeModuleContract.getAddress();

        // Initialize helpers with the context
        helpers = createSafeTestHelpers({ signer, safeWallet, safeModuleAddress });

        await fundETH(safeAddress);
        await enableSafeModule();
    });

    async function enableSafeModule() {
        const enableModuleTx = await safeWallet.createEnableModuleTx(safeModuleAddress);
        const safeTxHash = await safeWallet.executeTransaction(enableModuleTx);
        console.log("Safe enable module transaction");

        console.log("Modules:", await safeWallet.getModules());
    }

    this.afterEach(async () => {
        // Force garbage collection to free memory
        if (global.gc) {
            global.gc();
        }

        await new Promise((resolve) => setTimeout(resolve, 100));
    });

    // Use helper functions from debtSwapBySafe.ts
    const supplyAndBorrow = (...args: Parameters<ReturnType<typeof createSafeTestHelpers>["supplyAndBorrow"]>) =>
        helpers.supplyAndBorrow(...args);
    const supplyAndBorrowOnFluid = (
        ...args: Parameters<ReturnType<typeof createSafeTestHelpers>["supplyAndBorrowOnFluid"]>
    ) => helpers.supplyAndBorrowOnFluid(...args);
    const morphoAuthorizeTxBySafe = () => helpers.morphoAuthorizeTxBySafe();
    const compoundAllowTxBySafe = (tokenAddress: string) => helpers.compoundAllowTxBySafe(tokenAddress);

    /**
     * Helper function to test exit functionality for different protocols (DRY principle)
     */
    async function testExitPosition(options: {
        protocol: Protocols;
        debtAsset: string;
        debtDecimals: number;
        collateralAsset: string;
        collateralDecimals: number;
        setupPosition: () => Promise<void>;
        getDebtAmount: () => Promise<bigint>;
        getCollateralAmount: () => Promise<bigint>;
        getExtraData: () => Promise<string>;
        validateDebtRepaid: () => Promise<void>;
        withdrawCollateral?: boolean;
        debtAmountOverride?: bigint;
        callViaSafe?: boolean;
    }) {
        const {
            protocol,
            debtAsset,
            debtDecimals,
            collateralAsset,
            collateralDecimals,
            setupPosition,
            getDebtAmount,
            getCollateralAmount,
            getExtraData,
            validateDebtRepaid,
            withdrawCollateral = true,
            debtAmountOverride,
            callViaSafe = false,
        } = options;

        await time.increaseTo((await time.latest()) + 3600); // 1 hour

        // Step 0: Fund the operator with ETH for gas (only if not calling via Safe)
        if (!callViaSafe) {
            const fundTx = await signer.sendTransaction({
                to: operator.address,
                value: ethers.parseEther("0.01"),
            });
            await fundTx.wait();
            console.log("Operator funded with ETH");
        }

        // Step 1: Create a position (supply collateral and borrow)
        await setupPosition();

        // Step 2: Get current debt amount
        const debtBefore = await getDebtAmount();
        console.log("Debt before exit:", ethers.formatUnits(debtBefore, debtDecimals));
        expect(debtBefore).to.be.gt(0);

        // Step 3: Send debt tokens to Safe to cover the repayment (including any accrued interest)
        const debtContract = new ethers.Contract(debtAsset, ERC20_ABI, signer);
        const repayAmount = debtBefore + ethers.parseUnits("1", debtDecimals); // Add buffer for interest
        const transferTx = await debtContract.transfer(safeAddress, repayAmount);
        await transferTx.wait();
        console.log("Debt tokens transferred to Safe");

        // Step 4: Get collateral amount
        const collateralAmount = await getCollateralAmount();
        console.log("Collateral amount:", ethers.formatUnits(collateralAmount, collateralDecimals));

        // Step 5: Get collateral balance before exit
        const collateralContract = new ethers.Contract(collateralAsset, ERC20_ABI, signer);
        const collateralBalanceBefore = await collateralContract.balanceOf(safeAddress);
        console.log("Collateral balance before exit:", ethers.formatUnits(collateralBalanceBefore, collateralDecimals));
        // Step 7: Get extra data for protocol-specific parameters
        const extraData = await getExtraData();

        // Use override amount if provided, otherwise use actual debt amount with 1% buffer
        const debtAmountToUse = debtAmountOverride !== undefined ? debtAmountOverride : (debtBefore * 101n) / 100n;

        // Step 8: Call exit function
        let receipt;
        if (callViaSafe) {
            // Call exit via Safe transaction
            const moduleContract = await ethers.getContractAt("SafeDebtManager", safeModuleAddress);

            const exitCallData: MetaTransactionData = {
                to: safeModuleAddress,
                value: "0",
                data: moduleContract.interface.encodeFunctionData("exit", [
                    protocol,
                    debtAsset,
                    debtAmountToUse,
                    [{ asset: collateralAsset, amount: collateralAmount }],
                    safeAddress,
                    extraData,
                    withdrawCollateral,
                ]),
                operation: OperationType.Call,
            };

            const safeTransaction = await safeWallet.createTransaction({
                transactions: [exitCallData],
            });

            await safeWallet.executeTransaction(safeTransaction);
            console.log(`Exit transaction completed via Safe with withdrawCollateral=${withdrawCollateral}`);
            // Note: We can't easily get the receipt for Safe transactions, so we'll skip event verification for Safe calls
        } else {
            // Call exit via operator
            const moduleContract = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, operator);

            const exitTx = await moduleContract.exit(
                protocol,
                debtAsset,
                debtAmountToUse,
                [{ asset: collateralAsset, amount: collateralAmount }],
                safeAddress,
                extraData,
                withdrawCollateral,
                {
                    gasLimit: "2000000",
                },
            );

            receipt = await exitTx.wait();
            console.log(`Exit transaction completed with withdrawCollateral=${withdrawCollateral}`);
        }

        // Verify DebtPositionExited event was emitted (only for operator calls)
        if (!callViaSafe && receipt) {
            const moduleContract = await ethers.getContractAt("SafeDebtManager", safeModuleAddress);
            const exitEvent = receipt.logs.find((log: any) => {
                try {
                    const parsed = moduleContract.interface.parseLog({
                        topics: [...log.topics],
                        data: log.data,
                    });
                    return parsed?.name === "DebtPositionExited";
                } catch {
                    return false;
                }
            });
            expect(exitEvent).to.not.be.undefined;
        }

        // Step 9: Verify debt is repaid
        await validateDebtRepaid();

        // Step 10: Verify collateral is withdrawn from protocol
        const collateralInProtocolAfter = await getCollateralAmount();
        console.log(
            "Collateral in protocol after exit:",
            ethers.formatUnits(collateralInProtocolAfter, collateralDecimals),
        );

        // Step 11: Verify collateral withdrawal behavior based on withdrawCollateral parameter
        const collateralBalanceAfter = await collateralContract.balanceOf(safeAddress);
        console.log("Collateral balance after exit:", ethers.formatUnits(collateralBalanceAfter, collateralDecimals));

        if (withdrawCollateral) {
            // When withdrawCollateral=true, balance should increase
            expect(collateralBalanceAfter).to.be.gt(collateralBalanceBefore);

            // The withdrawn collateral should approximately equal the collateral amount
            const withdrawnAmount = collateralBalanceAfter - collateralBalanceBefore;
            console.log("Withdrawn collateral:", ethers.formatUnits(withdrawnAmount, collateralDecimals));
            const tolerance =
                collateralDecimals === 18 ? ethers.parseEther("0.001") : ethers.parseUnits("0.001", collateralDecimals);
            expect(withdrawnAmount).to.be.closeTo(collateralAmount, tolerance);

            // Collateral should be 0 or very close to 0 (allowing small rounding errors)
            const collateralTolerance =
                collateralDecimals === 18
                    ? ethers.parseEther("0.0001")
                    : ethers.parseUnits("0.0001", collateralDecimals);
            expect(collateralInProtocolAfter).to.be.closeTo(0n, collateralTolerance);
        } else {
            // When withdrawCollateral=false, balance should remain unchanged
            expect(collateralBalanceAfter).to.equal(collateralBalanceBefore);
            console.log("Collateral not withdrawn (as expected with withdrawCollateral=false)");
        }
    }

    describe("exit function", function () {
        it("Should exit a Fluid position successfully with cbETH", async function () {
            const vaultAddress = FLUID_cbETH_USDC_VAULT;
            const fluidHelper = new FluidHelper(signer);

            await testExitPosition({
                protocol: Protocols.FLUID,
                debtAsset: USDC_ADDRESS,
                debtDecimals: 6,
                collateralAsset: cbETH_ADDRESS,
                collateralDecimals: 18,
                setupPosition: async () => {
                    await supplyAndBorrowOnFluid();
                },
                getDebtAmount: async () => {
                    return await fluidHelper.getDebtAmount(vaultAddress, safeAddress);
                },
                getCollateralAmount: async () => {
                    return await fluidHelper.getCollateralAmount(cbETH_ADDRESS, safeAddress);
                },
                getExtraData: async () => {
                    const nftId = await fluidHelper.getNftId(vaultAddress, safeAddress);
                    return ethers.AbiCoder.defaultAbiCoder().encode(
                        ["address", "uint256", "bool"],
                        [vaultAddress, nftId, true], // isFullRepay = true
                    );
                },
                validateDebtRepaid: async () => {
                    const debtAfter = await fluidHelper.getDebtAmount(vaultAddress, safeAddress);
                    console.log("Debt after exit:", ethers.formatUnits(debtAfter, 6));
                    expect(debtAfter).to.equal(0);
                },
            });
        });

        it("Should exit a Fluid position successfully with WETH", async function () {
            const vaultAddress = FLUID_WETH_USDC_VAULT;
            const fluidHelper = new FluidHelper(signer);

            await testExitPosition({
                protocol: Protocols.FLUID,
                debtAsset: USDC_ADDRESS,
                debtDecimals: 6,
                collateralAsset: WETH_ADDRESS,
                collateralDecimals: 18,
                setupPosition: async () => {
                    await supplyAndBorrowOnFluid(FLUID_WETH_USDC_VAULT, WETH_ADDRESS);
                },
                getDebtAmount: async () => {
                    return await fluidHelper.getDebtAmount(vaultAddress, safeAddress);
                },
                getCollateralAmount: async () => {
                    return await fluidHelper.getCollateralAmount(WETH_ADDRESS, safeAddress);
                },
                getExtraData: async () => {
                    const nftId = await fluidHelper.getNftId(vaultAddress, safeAddress);
                    return ethers.AbiCoder.defaultAbiCoder().encode(
                        ["address", "uint256", "bool"],
                        [vaultAddress, nftId, true], // isFullRepay = true
                    );
                },
                validateDebtRepaid: async () => {
                    const debtAfter = await fluidHelper.getDebtAmount(vaultAddress, safeAddress);
                    console.log("Debt after exit:", ethers.formatUnits(debtAfter, 6));
                    expect(debtAfter).to.equal(0);
                },
            });
        });

        it("Should exit a Fluid position successfully - Safe owner call via Safe transaction", async function () {
            const vaultAddress = FLUID_cbETH_USDC_VAULT;
            const fluidHelper = new FluidHelper(signer);

            await testExitPosition({
                protocol: Protocols.FLUID,
                debtAsset: USDC_ADDRESS,
                debtDecimals: 6,
                collateralAsset: cbETH_ADDRESS,
                collateralDecimals: 18,
                setupPosition: async () => {
                    await supplyAndBorrowOnFluid();
                },
                getDebtAmount: async () => {
                    return await fluidHelper.getDebtAmount(vaultAddress, safeAddress);
                },
                getCollateralAmount: async () => {
                    return await fluidHelper.getCollateralAmount(cbETH_ADDRESS, safeAddress);
                },
                getExtraData: async () => {
                    const nftId = await fluidHelper.getNftId(vaultAddress, safeAddress);
                    return ethers.AbiCoder.defaultAbiCoder().encode(
                        ["address", "uint256", "bool"],
                        [vaultAddress, nftId, true], // isFullRepay = true
                    );
                },
                validateDebtRepaid: async () => {
                    const debtAfter = await fluidHelper.getDebtAmount(vaultAddress, safeAddress);
                    console.log("Debt after exit:", ethers.formatUnits(debtAfter, 6));
                    expect(debtAfter).to.equal(0);
                },
                callViaSafe: true, // Call exit via Safe transaction instead of operator
            });
        });

        it("Should exit a Fluid position with withdrawCollateral=false - debt repaid, collateral remains", async function () {
            const vaultAddress = FLUID_cbETH_USDC_VAULT;
            const fluidHelper = new FluidHelper(signer);

            await testExitPosition({
                protocol: Protocols.FLUID,
                debtAsset: USDC_ADDRESS,
                debtDecimals: 6,
                collateralAsset: cbETH_ADDRESS,
                collateralDecimals: 18,
                setupPosition: async () => {
                    await supplyAndBorrowOnFluid();
                },
                getDebtAmount: async () => {
                    return await fluidHelper.getDebtAmount(vaultAddress, safeAddress);
                },
                getCollateralAmount: async () => {
                    return await fluidHelper.getCollateralAmount(cbETH_ADDRESS, safeAddress);
                },
                getExtraData: async () => {
                    const nftId = await fluidHelper.getNftId(vaultAddress, safeAddress);
                    return ethers.AbiCoder.defaultAbiCoder().encode(
                        ["address", "uint256", "bool"],
                        [vaultAddress, nftId, true], // isFullRepay = true
                    );
                },
                validateDebtRepaid: async () => {
                    const debtAfter = await fluidHelper.getDebtAmount(vaultAddress, safeAddress);
                    console.log("Debt after exit:", ethers.formatUnits(debtAfter, 6));
                    expect(debtAfter).to.equal(0);
                },
                withdrawCollateral: false, // Test with withdrawCollateral=false
            });
        });

        it("Should exit a Morpho position successfully", async function () {
            const marketId = morphoMarket1Id;
            const morphoHelper = new MorphoHelper(signer);

            await testExitPosition({
                protocol: Protocols.MORPHO,
                debtAsset: USDC_ADDRESS,
                debtDecimals: 6,
                collateralAsset: cbETH_ADDRESS,
                collateralDecimals: 18,
                setupPosition: async () => {
                    await supplyAndBorrow(Protocols.MORPHO);
                    // Authorize Morpho for exit operations
                    await morphoAuthorizeTxBySafe();
                },
                getDebtAmount: async () => {
                    return await morphoHelper.getDebtAmount(marketId, safeAddress);
                },
                getCollateralAmount: async () => {
                    return await morphoHelper.getCollateralAmount(marketId, safeAddress);
                },
                getExtraData: async () => {
                    const borrowShares = await morphoHelper.getBorrowShares(marketId, safeAddress);
                    return morphoHelper.encodeExtraData(marketId, borrowShares);
                },
                validateDebtRepaid: async () => {
                    const debtAfter = await morphoHelper.getDebtAmount(marketId, safeAddress);
                    console.log("Debt after exit:", ethers.formatUnits(debtAfter, 6));
                    expect(debtAfter).to.equal(0);
                },
            });
        });

        it("Should exit a Compound position successfully", async function () {
            const cometAddress = USDC_COMET_ADDRESS;
            const compoundHelper = new CompoundHelper(signer);

            await testExitPosition({
                protocol: Protocols.COMPOUND,
                debtAsset: USDC_ADDRESS,
                debtDecimals: 6,
                collateralAsset: cbETH_ADDRESS,
                collateralDecimals: 18,
                setupPosition: async () => {
                    await supplyAndBorrow(Protocols.COMPOUND);
                    // Authorize Compound for exit operations
                    await compoundAllowTxBySafe(USDC_ADDRESS);
                },
                getDebtAmount: async () => {
                    return await compoundHelper.getDebtAmount(USDC_ADDRESS, safeAddress);
                },
                getCollateralAmount: async () => {
                    return await compoundHelper.getCollateralAmount(cometAddress, cbETH_ADDRESS, safeAddress);
                },
                getExtraData: async () => {
                    return compoundHelper.encodeExtraData(cometAddress);
                },
                validateDebtRepaid: async () => {
                    const debtAfter = await compoundHelper.getDebtAmount(USDC_ADDRESS, safeAddress);
                    console.log("Debt after exit:", ethers.formatUnits(debtAfter, 6));
                    expect(debtAfter).to.equal(0);
                },
            });
        });

        it("Should exit an Aave position successfully", async function () {
            const aaveHelper = new AaveV3Helper(signer);

            await testExitPosition({
                protocol: Protocols.AAVE_V3,
                debtAsset: USDC_ADDRESS,
                debtDecimals: 6,
                collateralAsset: cbETH_ADDRESS,
                collateralDecimals: 18,
                setupPosition: async () => {
                    await supplyAndBorrow(Protocols.AAVE_V3);

                    // Approve aToken for SafeDebtManager to withdraw collateral
                    const aTokenAddress = await aaveHelper.getATokenAddress(cbETH_ADDRESS);
                    const token = new ethers.Contract(aTokenAddress, ERC20_ABI, signer);

                    const approveTransactionData: MetaTransactionData = {
                        to: aTokenAddress,
                        value: "0",
                        data: token.interface.encodeFunctionData("approve", [
                            safeModuleAddress,
                            ethers.parseEther("1"),
                        ]),
                        operation: OperationType.Call,
                    };

                    const safeApproveTransaction = await safeWallet.createTransaction({
                        transactions: [approveTransactionData],
                    });

                    await safeWallet.executeTransaction(safeApproveTransaction);
                    console.log("Safe transaction: Aave aToken approved");
                },
                getDebtAmount: async () => {
                    return await aaveHelper.getDebtAmount(USDC_ADDRESS, safeAddress);
                },
                getCollateralAmount: async () => {
                    return await aaveHelper.getCollateralAmount(cbETH_ADDRESS, safeAddress);
                },
                getExtraData: async () => {
                    return "0x";
                },
                validateDebtRepaid: async () => {
                    const debtAfter = await aaveHelper.getDebtAmount(USDC_ADDRESS, safeAddress);
                    console.log("Debt after exit:", ethers.formatUnits(debtAfter, 6));
                    expect(debtAfter).to.equal(0);
                },
            });
        });

        it("Should exit a Fluid position using type(uint256).max for debt amount", async function () {
            const vaultAddress = FLUID_cbETH_USDC_VAULT;
            const fluidHelper = new FluidHelper(signer);

            await testExitPosition({
                protocol: Protocols.FLUID,
                debtAsset: USDC_ADDRESS,
                debtDecimals: 6,
                collateralAsset: cbETH_ADDRESS,
                collateralDecimals: 18,
                setupPosition: async () => {
                    await supplyAndBorrowOnFluid();
                },
                getDebtAmount: async () => {
                    return await fluidHelper.getDebtAmount(vaultAddress, safeAddress);
                },
                getCollateralAmount: async () => {
                    return await fluidHelper.getCollateralAmount(cbETH_ADDRESS, safeAddress);
                },
                getExtraData: async () => {
                    const nftId = await fluidHelper.getNftId(vaultAddress, safeAddress);
                    return ethers.AbiCoder.defaultAbiCoder().encode(
                        ["address", "uint256", "bool"],
                        [vaultAddress, nftId, true], // isFullRepay = true
                    );
                },
                validateDebtRepaid: async () => {
                    const debtAfter = await fluidHelper.getDebtAmount(vaultAddress, safeAddress);
                    console.log("Debt after exit:", ethers.formatUnits(debtAfter, 6));
                    expect(debtAfter).to.equal(0);
                },
                debtAmountOverride: ethers.MaxUint256, // Use type(uint256).max
            });
        });
    });
});
