import { ethers } from "hardhat";
import dotenv from "dotenv";
dotenv.config();
import Safe from "@safe-global/protocol-kit";
import {
    AAVE_V3_POOL_ADDRESS,
    cbBTC_ADDRESS,
    cbETH_ADDRESS,
    DAI_ADDRESS,
    DAI_USDC_POOL,
    DEFAULT_SUPPLY_AMOUNT,
    ETH_USDbC_POOL,
    EURC_ADDRESS,
    Protocols,
    sUSDS_ADDRESS,
    TEST_ADDRESS,
    TEST_FEE_BENEFICIARY_ADDRESS,
    USDbC_ADDRESS,
    USDC_ADDRESS,
    ETH_USDC_POOL,
    WETH_ADDRESS,
    wstETH_ADDRESS,
} from "./constants";
import { abi as ERC20_ABI } from "@openzeppelin/contracts/build/contracts/ERC20.json";
import cometAbi from "../externalAbi/compound/comet.json";
import morphoAbi from "../externalAbi/morpho/morpho.json";
import { MetaTransactionData, OperationType } from "@safe-global/types-kit";
import { MaxUint256 } from "ethers";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import {
    eip1193Provider,
    formatAmount,
    fundETH,
    fundSignerWithETH,
    getDecimals,
    getParaswapData,
    protocolHelperMap,
} from "./utils";
import {
    FLUID_cbETH_EURC_VAULT,
    FLUID_cbETH_USDC_VAULT,
    FLUID_WETH_USDC_VAULT,
    FLUID_wstETH_sUSDS_VAULT,
    FLUID_wstETH_USDC_VAULT,
    FluidHelper,
} from "./protocols/fluid";
import { cometAddressMap, CompoundHelper, USDC_COMET_ADDRESS } from "./protocols/compound";
import { MORPHO_ADDRESS, morphoMarket1Id, morphoMarket2Id, morphoMarket7Id, MorphoHelper } from "./protocols/morpho";
import { AaveV3Helper } from "./protocols/aaveV3";
import FluidVaultAbi from "../externalAbi/fluid/fluidVaultT1.json";
import aaveDebtTokenJson from "../externalAbi/aaveV3/aaveDebtToken.json";
import aaveV3PoolJson from "../externalAbi/aaveV3/aaveV3Pool.json";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { deploySafeContractFixture } from "./deployUtils";
import { zeroAddress } from "viem";

export const safeAddress = process.env.TESTING_SAFE_WALLET_ADDRESS!;

// Export helper functions for reuse in other test files
export function createSafeTestHelpers(context: { signer: ethers.Wallet; safeWallet: any; safeModuleAddress: string }) {
    const { signer, safeWallet, safeModuleAddress } = context;

    async function sendCollateralToSafe(tokenAddress = cbETH_ADDRESS, protocol?: Protocols) {
        if (tokenAddress === WETH_ADDRESS && protocol === Protocols.FLUID) {
            // Send ETH directly to Safe for WETH only for Fluid protocol
            const tx = await signer.sendTransaction({
                to: safeAddress,
                value: ethers.parseEther("0.001"),
            });
            await tx.wait();
        } else {
            const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
            const tx = await tokenContract.transfer(safeAddress, ethers.parseEther("0.001"));
            await tx.wait();
        }
    }

    async function supplyAndBorrow(
        protocol: Protocols,
        debtTokenAddress = USDC_ADDRESS,
        collateralTokenAddress = cbETH_ADDRESS,
    ) {
        await sendCollateralToSafe(collateralTokenAddress, protocol);
        const Helper = protocolHelperMap.get(protocol)!;
        const helper = new Helper(signer);

        // Use smaller borrow amount for WETH to avoid requiring excessive collateral
        const customBorrowAmount = debtTokenAddress === WETH_ADDRESS ? ethers.parseEther("0.0005") : undefined;
        const protocolCallData = await helper.getSupplyAndBorrowTxdata(
            debtTokenAddress,
            collateralTokenAddress,
            customBorrowAmount,
        );

        const tokenContract = new ethers.Contract(debtTokenAddress, ERC20_ABI, signer);

        const decimals = await getDecimals(debtTokenAddress);
        // Transfer amount should match borrow amount for WETH
        const transferAmount =
            debtTokenAddress === WETH_ADDRESS ? ethers.parseEther("0.0004") : ethers.parseUnits("1", decimals);

        const transferTransactionData: MetaTransactionData = {
            to: debtTokenAddress,
            value: "0",
            data: tokenContract.interface.encodeFunctionData("transfer", [TEST_ADDRESS, transferAmount]),
            operation: OperationType.Call,
        };

        const safeTransaction = await safeWallet.createTransaction({
            transactions: [...protocolCallData, transferTransactionData],
        });

        const safeTxHash = await safeWallet.executeTransaction(safeTransaction);
        console.log(`Supplied and borrowed on protocol: ${protocol}`);

        const tokenBalance = await tokenContract.balanceOf(safeAddress);
        console.log("Token Balance on Safe:", ethers.formatUnits(tokenBalance, decimals));

        const userTokenBalance = await tokenContract.balanceOf(TEST_ADDRESS);
        console.log("Token Balance on user:", ethers.formatUnits(userTokenBalance, decimals));
    }

    async function supplyAndBorrowOnFluid(
        vaultAddress = FLUID_cbETH_USDC_VAULT,
        collateralTokenAddress = cbETH_ADDRESS,
        supplyAmount = ethers.parseEther(DEFAULT_SUPPLY_AMOUNT),
    ) {
        await sendCollateralToSafe(collateralTokenAddress, Protocols.FLUID);
        const collateralTokenContract = new ethers.Contract(collateralTokenAddress, ERC20_ABI, signer);

        const fluidVault = new ethers.Contract(vaultAddress, FluidVaultAbi, signer);

        const transactions: MetaTransactionData[] = [];

        // Skip approval for WETH (sending ETH directly)
        if (collateralTokenAddress !== WETH_ADDRESS) {
            const approveTransactionData: MetaTransactionData = {
                to: collateralTokenAddress,
                value: "0",
                data: collateralTokenContract.interface.encodeFunctionData("approve", [
                    vaultAddress,
                    ethers.parseEther("1"),
                ]),
                operation: OperationType.Call,
            };
            transactions.push(approveTransactionData);
        }

        const supplyTransactionData: MetaTransactionData = {
            to: vaultAddress,
            value: collateralTokenAddress === WETH_ADDRESS ? supplyAmount.toString() : "0",
            data: fluidVault.interface.encodeFunctionData("operate", [0, supplyAmount, 0, safeAddress]),
            operation: OperationType.Call,
        };
        transactions.push(supplyTransactionData);

        const safeTransaction = await safeWallet.createTransaction({
            transactions: transactions,
        });

        const safeTxHash = await safeWallet.executeTransaction(safeTransaction);
        console.log(`Supplied on Fluid`);

        const fluidHelper = new FluidHelper(signer);
        const nftId = await fluidHelper.getNftId(vaultAddress, safeAddress);

        const borrowTransactionData: MetaTransactionData = {
            to: vaultAddress,
            value: "0",
            data: fluidVault.interface.encodeFunctionData("operate", [
                nftId,
                0,
                ethers.parseUnits("1", 6),
                safeAddress,
            ]),
            operation: OperationType.Call,
        };

        const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, signer);

        const transferTransactionData: MetaTransactionData = {
            to: USDC_ADDRESS,
            value: "0",
            data: usdcContract.interface.encodeFunctionData("transfer", [TEST_ADDRESS, ethers.parseUnits("1", 6)]),
            operation: OperationType.Call,
        };

        const safeTransactionBorrow = await safeWallet.createTransaction({
            transactions: [borrowTransactionData, transferTransactionData],
        });

        const safeTxHashBorrow = await safeWallet.executeTransaction(safeTransactionBorrow);
        console.log(`Borrowed on Fluid`);
    }

    async function morphoAuthorizeTxBySafe() {
        const morphoContract = new ethers.Contract(MORPHO_ADDRESS, morphoAbi, signer);

        const authTransactionData: MetaTransactionData = {
            to: MORPHO_ADDRESS,
            value: "0",
            data: morphoContract.interface.encodeFunctionData("setAuthorization", [safeModuleAddress, true]),
            operation: OperationType.Call,
        };

        const safeTransaction = await safeWallet.createTransaction({
            transactions: [authTransactionData],
        });

        const safeTxHash = await safeWallet.executeTransaction(safeTransaction);
        console.log("Safe transaction: setAuthorization");
    }

    async function compoundAllowTxBySafe(tokenAddress: string) {
        const cometAddress = cometAddressMap.get(tokenAddress)!;
        const comet = new ethers.Contract(cometAddress, cometAbi, signer);

        const allowTransactionData: MetaTransactionData = {
            to: cometAddress,
            value: "0",
            data: comet.interface.encodeFunctionData("allow", [safeModuleAddress, true]),
            operation: OperationType.Call,
        };

        const safeAllowTransaction = await safeWallet.createTransaction({
            transactions: [allowTransactionData],
        });

        await safeWallet.executeTransaction(safeAllowTransaction);
        console.log("Safe transaction: Compound allow");
    }

    return {
        sendCollateralToSafe,
        supplyAndBorrow,
        supplyAndBorrowOnFluid,
        morphoAuthorizeTxBySafe,
        compoundAllowTxBySafe,
    };
}

describe.only("Safe wallet should debtSwap", function () {
    // Increase timeout for memory-intensive operations
    this.timeout(300000); // 5 minutes

    const signer = new ethers.Wallet(process.env.TESTING_SAFE_OWNER_KEY!, ethers.provider);
    let operator: HardhatEthersSigner;
    let safeWallet;
    let safeModuleContract;
    let safeModuleAddress;
    let protocolRegistryContract;
    let helpers: ReturnType<typeof createSafeTestHelpers>;
    let aaveV3Helper: AaveV3Helper;
    let compoundHelper: CompoundHelper;
    let morphoHelper: MorphoHelper;

    this.beforeEach(async () => {
        // Get the operator (third signer)
        const signers = await ethers.getSigners();
        operator = signers[2];

        // Fund the signer wallet (TESTING_SAFE_OWNER_KEY) with ETH for gas fees
        await fundSignerWithETH(signer.address);

        safeWallet = await Safe.init({
            provider: eip1193Provider,
            signer: process.env.TESTING_SAFE_OWNER_KEY,
            safeAddress: safeAddress,
        });

        const { safeModule, protocolRegistry } = await loadFixture(deploySafeContractFixture);
        safeModuleContract = safeModule;
        protocolRegistryContract = protocolRegistry;

        safeModuleAddress = await safeModuleContract.getAddress();

        // Initialize helpers with the context
        helpers = createSafeTestHelpers({ signer, safeWallet, safeModuleAddress });

        aaveV3Helper = new AaveV3Helper(signer);
        compoundHelper = new CompoundHelper(signer);
        morphoHelper = new MorphoHelper(signer);

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

    // Use helper functions from the factory
    const supplyAndBorrow = (...args: Parameters<ReturnType<typeof createSafeTestHelpers>["supplyAndBorrow"]>) =>
        helpers.supplyAndBorrow(...args);
    const supplyAndBorrowOnFluid = (
        ...args: Parameters<ReturnType<typeof createSafeTestHelpers>["supplyAndBorrowOnFluid"]>
    ) => helpers.supplyAndBorrowOnFluid(...args);

    describe("switch In", function () {
        describe("In Aave", function () {
            it("from USDC to USDbC", async function () {
                await supplyAndBorrow(Protocols.AAVE_V3);

                await executeDebtSwap(ETH_USDC_POOL, USDC_ADDRESS, USDbC_ADDRESS, Protocols.AAVE_V3, Protocols.AAVE_V3);
            });

            it("from USDC to USDbC with specific amount", async function () {
                await supplyAndBorrow(Protocols.AAVE_V3);

                await executeDebtSwap(
                    ETH_USDC_POOL,
                    USDC_ADDRESS,
                    USDbC_ADDRESS,
                    Protocols.AAVE_V3,
                    Protocols.AAVE_V3,
                    cbETH_ADDRESS,
                    { useMaxAmount: false },
                );
            });

            it("from USDbC to USDC, cbETH Collateral", async function () {
                await supplyAndBorrow(Protocols.AAVE_V3, USDbC_ADDRESS);

                await executeDebtSwap(
                    ETH_USDbC_POOL,
                    USDbC_ADDRESS,
                    USDC_ADDRESS,
                    Protocols.AAVE_V3,
                    Protocols.AAVE_V3,
                );
            });

            it("from USDC to USDbC, WETH Collateral", async function () {
                await supplyAndBorrow(Protocols.AAVE_V3, USDC_ADDRESS, WETH_ADDRESS);

                await executeDebtSwap(
                    ETH_USDC_POOL,
                    USDC_ADDRESS,
                    USDbC_ADDRESS,
                    Protocols.AAVE_V3,
                    Protocols.AAVE_V3,
                    WETH_ADDRESS,
                );
            });

            it("from USDbC to USDC, WETH Collateral", async function () {
                await supplyAndBorrow(Protocols.AAVE_V3, USDbC_ADDRESS, WETH_ADDRESS);

                await executeDebtSwap(
                    ETH_USDbC_POOL,
                    USDbC_ADDRESS,
                    USDC_ADDRESS,
                    Protocols.AAVE_V3,
                    Protocols.AAVE_V3,
                    WETH_ADDRESS,
                );
            });
        });

        // USDbC is not available on Compound anymore
        it.skip("Compound from USDC to USDbC", async function () {
            await supplyAndBorrow(Protocols.COMPOUND);
            await executeDebtSwap(ETH_USDC_POOL, USDC_ADDRESS, USDbC_ADDRESS, Protocols.COMPOUND, Protocols.COMPOUND);
        });

        describe("In Morpho", function () {
            it("from market 1 to market 2", async function () {
                await supplyAndBorrow(Protocols.MORPHO);
                await executeDebtSwap(
                    ETH_USDC_POOL,
                    USDC_ADDRESS,
                    USDC_ADDRESS,
                    Protocols.MORPHO,
                    Protocols.MORPHO,
                    cbETH_ADDRESS,
                    {
                        morphoFromMarketId: morphoMarket1Id,
                        morphoToMarketId: morphoMarket2Id,
                    },
                );
            });
        });

        // we don't support DAI anymore
        it.skip("In Moonwell from USDC to DAI", async function () {
            await supplyAndBorrow(Protocols.MOONWELL);
            await executeDebtSwap(ETH_USDC_POOL, USDC_ADDRESS, DAI_ADDRESS, Protocols.MOONWELL, Protocols.MOONWELL);
        });

        // sUSDS market is not available on Fluid anymore
        it.skip("In Fluid from USDC to sUSDS with cbBTC collateral", async function () {
            await supplyAndBorrowOnFluid(FLUID_wstETH_USDC_VAULT, wstETH_ADDRESS);
            await executeDebtSwap(
                ETH_USDC_POOL,
                USDC_ADDRESS,
                sUSDS_ADDRESS,
                Protocols.FLUID,
                Protocols.FLUID,
                wstETH_ADDRESS,
                {
                    fromFluidVaultAddress: FLUID_wstETH_USDC_VAULT,
                    tofluidVaultAddress: FLUID_wstETH_sUSDS_VAULT,
                },
            );
        });

        it("In Fluid from USDC to EURC with cbETH collateral", async function () {
            await supplyAndBorrowOnFluid();
            await executeDebtSwap(
                ETH_USDC_POOL,
                USDC_ADDRESS,
                EURC_ADDRESS,
                Protocols.FLUID,
                Protocols.FLUID,
                cbETH_ADDRESS,
                {
                    fromFluidVaultAddress: FLUID_cbETH_USDC_VAULT,
                    tofluidVaultAddress: FLUID_cbETH_EURC_VAULT,
                },
            );
        });
    });

    describe("switch between protocols", function () {
        it("from Aave to Compound", async function () {
            await supplyAndBorrow(Protocols.AAVE_V3);
            await executeDebtSwap(ETH_USDC_POOL, USDC_ADDRESS, USDC_ADDRESS, Protocols.AAVE_V3, Protocols.COMPOUND);
        });

        it("from Aave to Compound with protocol fee", async function () {
            // set protocol fee
            const signers = await ethers.getSigners();
            const contractByOwner = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, signers[0]);
            const setTx = await contractByOwner.setProtocolFee(10);
            await setTx.wait();

            const setFeeBeneficiaryTx = await contractByOwner.setFeeBeneficiary(TEST_FEE_BENEFICIARY_ADDRESS);
            await setFeeBeneficiaryTx.wait();

            await supplyAndBorrow(Protocols.AAVE_V3);
            await executeDebtSwap(ETH_USDC_POOL, USDC_ADDRESS, USDC_ADDRESS, Protocols.AAVE_V3, Protocols.COMPOUND);
        });

        it("from Compound to Aave", async function () {
            await supplyAndBorrow(Protocols.COMPOUND);
            await executeDebtSwap(ETH_USDC_POOL, USDC_ADDRESS, USDbC_ADDRESS, Protocols.COMPOUND, Protocols.AAVE_V3);
        });

        it("USDbC debt on Aave to USDC on Compound", async function () {
            await supplyAndBorrow(Protocols.AAVE_V3, USDbC_ADDRESS);
            await executeDebtSwap(ETH_USDbC_POOL, USDbC_ADDRESS, USDC_ADDRESS, Protocols.AAVE_V3, Protocols.COMPOUND);
        });

        it("from Compound to Moonwell", async function () {
            await supplyAndBorrow(Protocols.COMPOUND);
            await executeDebtSwap(ETH_USDC_POOL, USDC_ADDRESS, USDC_ADDRESS, Protocols.COMPOUND, Protocols.MOONWELL);
        });

        it("from Moonwell to Compound", async function () {
            await supplyAndBorrow(Protocols.MOONWELL);
            await executeDebtSwap(ETH_USDC_POOL, USDC_ADDRESS, USDC_ADDRESS, Protocols.MOONWELL, Protocols.COMPOUND);
        });

        it("from Fluid to Moonwell", async function () {
            await supplyAndBorrowOnFluid();

            await time.increaseTo((await time.latest()) + 86400); // 1 day

            await executeDebtSwap(ETH_USDC_POOL, USDC_ADDRESS, USDC_ADDRESS, Protocols.FLUID, Protocols.MOONWELL);
        });

        it("from Fluid to Aave", async function () {
            await supplyAndBorrowOnFluid();
            await executeDebtSwap(ETH_USDC_POOL, USDC_ADDRESS, USDC_ADDRESS, Protocols.FLUID, Protocols.AAVE_V3);
        });

        it("from Fluid to Aave with WETH collateral", async function () {
            await supplyAndBorrowOnFluid(FLUID_WETH_USDC_VAULT, WETH_ADDRESS);
            await executeDebtSwap(
                ETH_USDC_POOL,
                USDC_ADDRESS,
                USDC_ADDRESS,
                Protocols.FLUID,
                Protocols.AAVE_V3,
                WETH_ADDRESS,
                {
                    fromFluidVaultAddress: FLUID_WETH_USDC_VAULT,
                },
            );
        });

        it("from Fluid to Morpho", async function () {
            await supplyAndBorrowOnFluid();
            await executeDebtSwap(
                ETH_USDC_POOL,
                USDC_ADDRESS,
                USDC_ADDRESS,
                Protocols.FLUID,
                Protocols.MORPHO,
                cbETH_ADDRESS,
                {
                    fromFluidVaultAddress: FLUID_cbETH_USDC_VAULT,
                    morphoToMarketId: morphoMarket2Id,
                },
            );
        });

        it("from Fluid to Compound", async function () {
            await supplyAndBorrowOnFluid();
            await executeDebtSwap(ETH_USDC_POOL, USDC_ADDRESS, USDC_ADDRESS, Protocols.FLUID, Protocols.COMPOUND);
        });

        it("from Moonwell to Fluid", async function () {
            await supplyAndBorrow(Protocols.MOONWELL);

            await executeDebtSwap(ETH_USDC_POOL, USDC_ADDRESS, USDC_ADDRESS, Protocols.MOONWELL, Protocols.FLUID);
        });

        it("from Moonwell to Fluid with WETH collateral", async function () {
            await supplyAndBorrow(Protocols.MOONWELL, USDC_ADDRESS, WETH_ADDRESS);

            await executeDebtSwap(
                ETH_USDC_POOL,
                USDC_ADDRESS,
                USDC_ADDRESS,
                Protocols.MOONWELL,
                Protocols.FLUID,
                WETH_ADDRESS,
                {
                    tofluidVaultAddress: FLUID_WETH_USDC_VAULT,
                },
            );
        });

        it("from Aave to Fluid with WETH collateral", async function () {
            await supplyAndBorrow(Protocols.AAVE_V3, USDC_ADDRESS, WETH_ADDRESS);

            await executeDebtSwap(
                ETH_USDC_POOL,
                USDC_ADDRESS,
                USDC_ADDRESS,
                Protocols.AAVE_V3,
                Protocols.FLUID,
                WETH_ADDRESS,
                {
                    tofluidVaultAddress: FLUID_WETH_USDC_VAULT,
                },
            );
        });

        it.skip("from Moonwell DAI to Fluid USDC", async function () {
            await supplyAndBorrow(Protocols.MOONWELL, DAI_ADDRESS);
            await executeDebtSwap(DAI_USDC_POOL, DAI_ADDRESS, USDC_ADDRESS, Protocols.MOONWELL, Protocols.FLUID);
        });

        it("from Moonwell to Aave", async function () {
            await supplyAndBorrow(Protocols.MOONWELL);
            await executeDebtSwap(ETH_USDC_POOL, USDC_ADDRESS, USDC_ADDRESS, Protocols.MOONWELL, Protocols.AAVE_V3);
        });

        it("from Aave to Moonwell", async function () {
            await supplyAndBorrow(Protocols.AAVE_V3);

            await executeDebtSwap(ETH_USDC_POOL, USDC_ADDRESS, USDC_ADDRESS, Protocols.AAVE_V3, Protocols.MOONWELL);
        });

        it("from Aave to Moonwell with protocol fee", async function () {
            // set protocol fee
            const signers = await ethers.getSigners();
            const contractByOwner = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, signers[0]);
            const setTx = await contractByOwner.setProtocolFee(10);
            await setTx.wait();

            const setFeeBeneficiaryTx = await contractByOwner.setFeeBeneficiary(TEST_FEE_BENEFICIARY_ADDRESS);
            await setFeeBeneficiaryTx.wait();

            await supplyAndBorrow(Protocols.AAVE_V3);

            await executeDebtSwap(ETH_USDC_POOL, USDC_ADDRESS, USDC_ADDRESS, Protocols.AAVE_V3, Protocols.MOONWELL);
        });

        // TODO: Fix this test
        it.skip("from Moonwell USDC to DAI with protocol fee - tests decimal mismatch", async function () {
            // set protocol fee to 1% (100 basis points)
            const signers = await ethers.getSigners();
            const contractByOwner = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, signers[0]);
            const setTx = await contractByOwner.setProtocolFee(100); // 1%
            await setTx.wait();

            const setFeeBeneficiaryTx = await contractByOwner.setFeeBeneficiary(TEST_FEE_BENEFICIARY_ADDRESS);
            await setFeeBeneficiaryTx.wait();

            // Supply and borrow USDC (6 decimals)
            await supplyAndBorrow(Protocols.MOONWELL, USDC_ADDRESS);

            // Get DAI contract for balance checks
            const daiContract = new ethers.Contract(DAI_ADDRESS, ERC20_ABI, signer);

            // Record fee beneficiary's DAI balance before swap
            const beneficiaryDaiBalanceBefore = await daiContract.balanceOf(TEST_FEE_BENEFICIARY_ADDRESS);

            // Execute debt swap from USDC (6 decimals) to DAI (18 decimals)
            await executeDebtSwap(DAI_USDC_POOL, USDC_ADDRESS, DAI_ADDRESS, Protocols.MOONWELL, Protocols.AAVE_V3);

            // Check fee beneficiary's DAI balance after swap
            const beneficiaryDaiBalanceAfter = await daiContract.balanceOf(TEST_FEE_BENEFICIARY_ADDRESS);
            const feeReceived = beneficiaryDaiBalanceAfter - beneficiaryDaiBalanceBefore;

            // Log the fee received
            console.log("Protocol fee received (DAI):", ethers.formatUnits(feeReceived, 18));

            // The fee should be approximately 1% of the debt amount in DAI terms
            // For example, if swapping 100 USDC to ~100 DAI, fee should be ~1 DAI (not 0.000001 DAI)
            expect(feeReceived).to.be.gt(ethers.parseUnits("0.5", 18)); // At least 0.5 DAI
            expect(feeReceived).to.be.lt(ethers.parseUnits("5", 18)); // Less than 5 DAI
        });

        it("from Aave to Morpho", async function () {
            await supplyAndBorrow(Protocols.AAVE_V3);

            await executeDebtSwap(
                ETH_USDC_POOL,
                USDC_ADDRESS,
                USDC_ADDRESS,
                Protocols.AAVE_V3,
                Protocols.MORPHO,
                cbETH_ADDRESS,
                {
                    morphoToMarketId: morphoMarket1Id,
                },
            );
        });

        it("from Morpho to Aave", async function () {
            await supplyAndBorrow(Protocols.MORPHO);

            await executeDebtSwap(
                ETH_USDC_POOL,
                USDC_ADDRESS,
                USDC_ADDRESS,
                Protocols.MORPHO,
                Protocols.AAVE_V3,
                cbETH_ADDRESS,
                {
                    morphoFromMarketId: morphoMarket1Id,
                },
            );
        });

        it("from Morpho to Compound", async function () {
            await supplyAndBorrow(Protocols.MORPHO);

            await executeDebtSwap(
                ETH_USDC_POOL,
                USDC_ADDRESS,
                USDC_ADDRESS,
                Protocols.MORPHO,
                Protocols.COMPOUND,
                cbETH_ADDRESS,
                {
                    morphoFromMarketId: morphoMarket1Id,
                },
            );
        });

        it("from Compound to Morpho with WETH collateral", async function () {
            await supplyAndBorrow(Protocols.COMPOUND, USDC_ADDRESS, WETH_ADDRESS);

            await executeDebtSwap(
                ETH_USDC_POOL,
                USDC_ADDRESS,
                USDC_ADDRESS,
                Protocols.COMPOUND,
                Protocols.MORPHO,
                WETH_ADDRESS,
                {
                    morphoToMarketId: morphoMarket7Id,
                },
            );
        });

        it("from Morpho to USDbC on Aave", async function () {
            await supplyAndBorrow(Protocols.MORPHO);

            await executeDebtSwap(
                ETH_USDC_POOL,
                USDC_ADDRESS,
                USDbC_ADDRESS,
                Protocols.MORPHO,
                Protocols.AAVE_V3,
                cbETH_ADDRESS,
                {
                    morphoFromMarketId: morphoMarket1Id,
                },
            );
        });

        it.only("WETH debt on Aave to Compound", async function () {
            await supplyAndBorrow(Protocols.AAVE_V3, WETH_ADDRESS, cbETH_ADDRESS);

            await executeDebtSwap(
                ETH_USDC_POOL,
                WETH_ADDRESS,
                WETH_ADDRESS,
                Protocols.AAVE_V3,
                Protocols.COMPOUND,
                cbETH_ADDRESS,
            );
        });

        it("Multiple collateral case from Aave to Compound", async function () {
            // Supply cbETH collateral
            await supplyAndBorrow(Protocols.AAVE_V3);
            // Supply WETH collateral additionally
            await helpers.sendCollateralToSafe(WETH_ADDRESS);

            // Create supply transaction for WETH to Aave
            const wethContract = new ethers.Contract(WETH_ADDRESS, ERC20_ABI, signer);
            const aavePool = new ethers.Contract(AAVE_V3_POOL_ADDRESS, aaveV3PoolJson, signer);

            const wethBalance = await wethContract.balanceOf(safeAddress);
            if (wethBalance > 0n) {
                const approveTransactionData: MetaTransactionData = {
                    to: WETH_ADDRESS,
                    value: "0",
                    data: wethContract.interface.encodeFunctionData("approve", [
                        AAVE_V3_POOL_ADDRESS,
                        ethers.parseEther("1"),
                    ]),
                    operation: OperationType.Call,
                };

                const supplyTransactionData: MetaTransactionData = {
                    to: AAVE_V3_POOL_ADDRESS,
                    value: "0",
                    data: aavePool.interface.encodeFunctionData("supply", [
                        WETH_ADDRESS,
                        ethers.parseEther(DEFAULT_SUPPLY_AMOUNT),
                        safeAddress,
                        0,
                    ]),
                    operation: OperationType.Call,
                };

                const safeTransaction = await safeWallet.createTransaction({
                    transactions: [approveTransactionData, supplyTransactionData],
                });
                await safeWallet.executeTransaction(safeTransaction);
            }

            const WETHAmountInAaveBefore = await aaveV3Helper.getCollateralAmount(WETH_ADDRESS, safeAddress);
            console.log("WETH collateralAmountInAaveBefore:", ethers.formatEther(WETHAmountInAaveBefore));
            const WETHAmountInCompoundBefore = await compoundHelper.getCollateralAmount(
                USDC_COMET_ADDRESS,
                WETH_ADDRESS,
                safeAddress,
            );
            console.log("WETH collateralAmountInCompoundBefore:", ethers.formatEther(WETHAmountInCompoundBefore));

            const cbETHAmountInAaveBefore = await aaveV3Helper.getCollateralAmount(cbETH_ADDRESS, safeAddress);
            console.log("cbETH collateralAmountInAaveBefore:", ethers.formatEther(cbETHAmountInAaveBefore));
            const cbETHAmountInCompoundBefore = await compoundHelper.getCollateralAmount(
                USDC_COMET_ADDRESS,
                cbETH_ADDRESS,
                safeAddress,
            );
            console.log("cbETH collateralAmountInCompoundBefore:", ethers.formatEther(cbETHAmountInCompoundBefore));

            await executeDebtSwap(
                ETH_USDC_POOL,
                USDC_ADDRESS,
                USDC_ADDRESS,
                Protocols.AAVE_V3,
                Protocols.COMPOUND,
                cbETH_ADDRESS,
                { anotherCollateralTokenAddress: WETH_ADDRESS },
            );

            const WETHAmountInAave = await aaveV3Helper.getCollateralAmount(WETH_ADDRESS, safeAddress);
            console.log("WETH collateralAmountInAave:", ethers.formatEther(WETHAmountInAave));
            const WETHAmountInCompound = await compoundHelper.getCollateralAmount(
                USDC_COMET_ADDRESS,
                WETH_ADDRESS,
                safeAddress,
            );
            console.log("WETH collateralAmountInCompound:", ethers.formatEther(WETHAmountInCompound));

            const cbETHAmountInAave = await aaveV3Helper.getCollateralAmount(cbETH_ADDRESS, safeAddress);
            console.log("cbETH collateralAmountInAave:", ethers.formatEther(cbETHAmountInAave));
            const cbETHAmountInCompound = await compoundHelper.getCollateralAmount(
                USDC_COMET_ADDRESS,
                cbETH_ADDRESS,
                safeAddress,
            );
            console.log("cbETH collateralAmountInCompound:", ethers.formatEther(cbETHAmountInCompound));
        });

        it("Multiple collateral case from Compound to Aave", async function () {
            // Supply cbETH collateral on Compound
            await supplyAndBorrow(Protocols.COMPOUND);
            // Supply WETH collateral additionally on Compound
            await helpers.sendCollateralToSafe(WETH_ADDRESS);

            // Create supply transaction for WETH to Compound
            const wethContract = new ethers.Contract(WETH_ADDRESS, ERC20_ABI, signer);
            const cometContract = new ethers.Contract(USDC_COMET_ADDRESS, cometAbi, signer);

            const approveTransactionData: MetaTransactionData = {
                to: WETH_ADDRESS,
                value: "0",
                data: wethContract.interface.encodeFunctionData("approve", [
                    USDC_COMET_ADDRESS,
                    ethers.parseEther("1"),
                ]),
                operation: OperationType.Call,
            };

            const supplyTransactionData: MetaTransactionData = {
                to: USDC_COMET_ADDRESS,
                value: "0",
                data: cometContract.interface.encodeFunctionData("supply", [
                    WETH_ADDRESS,
                    ethers.parseEther(DEFAULT_SUPPLY_AMOUNT),
                ]),
                operation: OperationType.Call,
            };

            const safeTransaction = await safeWallet.createTransaction({
                transactions: [approveTransactionData, supplyTransactionData],
            });
            await safeWallet.executeTransaction(safeTransaction);

            await executeDebtSwap(
                ETH_USDC_POOL,
                USDC_ADDRESS,
                USDbC_ADDRESS,
                Protocols.COMPOUND,
                Protocols.AAVE_V3,
                cbETH_ADDRESS,
                { anotherCollateralTokenAddress: WETH_ADDRESS },
            );

            const WETHAmountInAave = await aaveV3Helper.getCollateralAmount(WETH_ADDRESS, safeAddress);
            console.log("WETH collateralAmountInAave:", ethers.formatEther(WETHAmountInAave));
            const WETHAmountInCompound = await compoundHelper.getCollateralAmount(
                USDC_COMET_ADDRESS,
                WETH_ADDRESS,
                safeAddress,
            );
            console.log("WETH collateralAmountInCompound:", ethers.formatEther(WETHAmountInCompound));

            const cbETHAmountInAave = await aaveV3Helper.getCollateralAmount(cbETH_ADDRESS, safeAddress);
            console.log("cbETH collateralAmountInAave:", ethers.formatEther(cbETHAmountInAave));
            const cbETHAmountInCompound = await compoundHelper.getCollateralAmount(
                USDC_COMET_ADDRESS,
                cbETH_ADDRESS,
                safeAddress,
            );
            console.log("cbETH collateralAmountInCompound:", ethers.formatEther(cbETHAmountInCompound));
        });
    });

    describe("Util function", function () {
        it("emergency withdraw", async function () {
            const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, signer);
            const transfer = await usdcContract.transfer(safeModuleAddress, ethers.parseUnits("1", 6));
            await transfer.wait();

            const signers = await ethers.getSigners();
            const contract = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, signers[0]);
            await contract.emergencyWithdraw(USDC_ADDRESS, ethers.parseUnits("1", 6));
            const balance = await usdcContract.balanceOf(signers[0].address);
            console.log(`Balance:`, ethers.formatUnits(balance, 6));
        });
    });

    describe("operator and authorization", function () {
        it("call executeDebtSwap by operator", async function () {
            await supplyAndBorrow(Protocols.MOONWELL);
            await executeDebtSwap(
                ETH_USDC_POOL,
                USDC_ADDRESS,
                USDC_ADDRESS,
                Protocols.MOONWELL,
                Protocols.AAVE_V3,
                cbETH_ADDRESS,
                {
                    operator,
                },
            );
        });

        it("revert when calling executeDebtSwap by non operator(wallet4)", async function () {
            const [_, , , wallet4] = await ethers.getSigners();

            await supplyAndBorrow(Protocols.MOONWELL);
            await expect(
                executeDebtSwap(
                    ETH_USDC_POOL,
                    USDC_ADDRESS,
                    USDC_ADDRESS,
                    Protocols.MOONWELL,
                    Protocols.AAVE_V3,
                    cbETH_ADDRESS,
                    {
                        operator: wallet4,
                    },
                ),
            ).to.be.revertedWith("Caller is not authorized");
        });
    });

    describe("should revert", function () {
        it("if flashloan pool is not uniswap v3 pool", async function () {
            await supplyAndBorrow(Protocols.MOONWELL);

            await expect(
                executeDebtSwap(
                    USDC_ADDRESS, // Using USDC contract address which doesn't have token0() function
                    USDC_ADDRESS,
                    USDC_ADDRESS,
                    Protocols.MOONWELL,
                    Protocols.AAVE_V3,
                    cbETH_ADDRESS,
                    {
                        operator, // Call directly to properly catch the revert reason
                    },
                ),
            ).to.be.revertedWith("Invalid flashloan pool address");
        });

        it("if non-owner call setProtocolFee()", async function () {
            const signers = await ethers.getSigners();
            const contractByNotOwner = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, signers[1]);
            await expect(contractByNotOwner.setProtocolFee(100)).to.be.reverted;
        });

        it("Call uniswapV3FlashCallback() directly with invalid callback data", async function () {
            const signers = await ethers.getSigners();
            const contractByNotOwner = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, signers[1]);
            await expect(contractByNotOwner.uniswapV3FlashCallback(100, 100, "0x")).to.be.reverted;
        });

        it("if flashloan pool is zero address", async function () {
            await expect(
                executeDebtSwap(
                    zeroAddress,
                    USDC_ADDRESS,
                    USDC_ADDRESS,
                    Protocols.AAVE_V3,
                    Protocols.AAVE_V3,
                    cbETH_ADDRESS,
                    { operator },
                ),
            ).to.be.reverted;
        });

        it("if fromTokenAddress is zero address", async function () {
            await expect(
                executeDebtSwap(
                    ETH_USDC_POOL,
                    zeroAddress,
                    USDC_ADDRESS,
                    Protocols.AAVE_V3,
                    Protocols.AAVE_V3,
                    cbETH_ADDRESS,
                    { operator },
                ),
            ).to.be.reverted;
        });

        it("if toTokenAddress is zero address", async function () {
            await expect(
                executeDebtSwap(
                    ETH_USDC_POOL,
                    USDC_ADDRESS,
                    zeroAddress,
                    Protocols.AAVE_V3,
                    Protocols.AAVE_V3,
                    cbETH_ADDRESS,
                    { operator },
                ),
            ).to.be.reverted;
        });

        it("if collateralArray is empty", async function () {
            const moduleContract = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, operator);
            await expect(
                moduleContract.executeDebtSwap(
                    ETH_USDC_POOL,
                    Protocols.AAVE_V3,
                    Protocols.AAVE_V3,
                    USDC_ADDRESS,
                    USDC_ADDRESS,
                    MaxUint256,
                    [],
                    safeAddress,
                    ["0x", "0x"],
                    { srcAmount: 0n, swapData: "0x" },
                ),
            ).to.be.reverted;
        });

        it("if collateralArray contains zero address", async function () {
            const moduleContract = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, operator);
            await expect(
                moduleContract.executeDebtSwap(
                    ETH_USDC_POOL,
                    Protocols.AAVE_V3,
                    Protocols.AAVE_V3,
                    USDC_ADDRESS,
                    USDC_ADDRESS,
                    MaxUint256,
                    [{ asset: zeroAddress, amount: ethers.parseEther(DEFAULT_SUPPLY_AMOUNT) }],
                    safeAddress,
                    ["0x", "0x"],
                    { srcAmount: 0n, swapData: "0x" },
                ),
            ).to.be.reverted;
        });

        it("if collateralArray contains zero amount", async function () {
            const moduleContract = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, operator);
            await expect(
                moduleContract.executeDebtSwap(
                    ETH_USDC_POOL,
                    Protocols.AAVE_V3,
                    Protocols.AAVE_V3,
                    USDC_ADDRESS,
                    USDC_ADDRESS,
                    MaxUint256,
                    [{ asset: cbETH_ADDRESS, amount: 0n }],
                    safeAddress,
                    ["0x", "0x"],
                    { srcAmount: 0n, swapData: "0x" },
                ),
            ).to.be.reverted;
        });

        it("if debtAmount is zero", async function () {
            const moduleContract = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, operator);
            await expect(
                moduleContract.executeDebtSwap(
                    ETH_USDC_POOL,
                    Protocols.AAVE_V3,
                    Protocols.AAVE_V3,
                    USDC_ADDRESS,
                    USDC_ADDRESS,
                    0n,
                    [{ asset: cbETH_ADDRESS, amount: ethers.parseEther(DEFAULT_SUPPLY_AMOUNT) }],
                    safeAddress,
                    ["0x", "0x"],
                    { srcAmount: 0n, swapData: "0x" },
                ),
            ).to.be.reverted;
        });

        it("if fromProtocol is invalid (out of range)", async function () {
            const moduleContract = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, operator);
            await expect(
                moduleContract.executeDebtSwap(
                    ETH_USDC_POOL,
                    99, // Invalid protocol number
                    Protocols.AAVE_V3,
                    USDC_ADDRESS,
                    USDC_ADDRESS,
                    MaxUint256,
                    [{ asset: cbETH_ADDRESS, amount: ethers.parseEther(DEFAULT_SUPPLY_AMOUNT) }],
                    safeAddress,
                    ["0x", "0x"],
                    { srcAmount: 0n, swapData: "0x" },
                ),
            ).to.be.reverted;
        });

        it("if toProtocol is invalid (out of range)", async function () {
            const moduleContract = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, operator);
            await expect(
                moduleContract.executeDebtSwap(
                    ETH_USDC_POOL,
                    Protocols.AAVE_V3,
                    99, // Invalid protocol number
                    USDC_ADDRESS,
                    USDC_ADDRESS,
                    MaxUint256,
                    [{ asset: cbETH_ADDRESS, amount: ethers.parseEther(DEFAULT_SUPPLY_AMOUNT) }],
                    safeAddress,
                    ["0x", "0x"],
                    { srcAmount: 0n, swapData: "0x" },
                ),
            ).to.be.reverted;
        });

        it("if fromTokenAddress is not a valid ERC20 token", async function () {
            const moduleContract = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, operator);
            await expect(
                moduleContract.executeDebtSwap(
                    ETH_USDC_POOL,
                    Protocols.AAVE_V3,
                    Protocols.AAVE_V3,
                    "0x1234567890123456789012345678901234567890", // Invalid token address
                    USDC_ADDRESS,
                    MaxUint256,
                    [{ asset: cbETH_ADDRESS, amount: ethers.parseEther(DEFAULT_SUPPLY_AMOUNT) }],
                    safeAddress,
                    ["0x", "0x"],
                    { srcAmount: 0n, swapData: "0x" },
                ),
            ).to.be.reverted;
        });

        it("if toTokenAddress is not a valid ERC20 token", async function () {
            const moduleContract = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, operator);
            await expect(
                moduleContract.executeDebtSwap(
                    ETH_USDC_POOL,
                    Protocols.AAVE_V3,
                    Protocols.AAVE_V3,
                    USDC_ADDRESS,
                    "0x1234567890123456789012345678901234567890", // Invalid token address
                    MaxUint256,
                    [{ asset: cbETH_ADDRESS, amount: ethers.parseEther(DEFAULT_SUPPLY_AMOUNT) }],
                    safeAddress,
                    ["0x", "0x"],
                    { srcAmount: 0n, swapData: "0x" },
                ),
            ).to.be.reverted;
        });

        it("if collateralArray asset is not a valid ERC20 token", async function () {
            const moduleContract = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, operator);
            await expect(
                moduleContract.executeDebtSwap(
                    ETH_USDC_POOL,
                    Protocols.AAVE_V3,
                    Protocols.AAVE_V3,
                    USDC_ADDRESS,
                    USDC_ADDRESS,
                    MaxUint256,
                    [
                        {
                            asset: "0x1234567890123456789012345678901234567890",
                            amount: ethers.parseEther(DEFAULT_SUPPLY_AMOUNT),
                        },
                    ],
                    safeAddress,
                    ["0x", "0x"],
                    { srcAmount: 0n, swapData: "0x" },
                ),
            ).to.be.reverted;
        });

        it("if paraswapData has excessively large srcAmount", async function () {
            const moduleContract = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, operator);
            await expect(
                moduleContract.executeDebtSwap(
                    ETH_USDC_POOL,
                    Protocols.AAVE_V3,
                    Protocols.AAVE_V3,
                    USDC_ADDRESS,
                    USDC_ADDRESS,
                    MaxUint256,
                    [{ asset: cbETH_ADDRESS, amount: ethers.parseEther(DEFAULT_SUPPLY_AMOUNT) }],
                    safeAddress,
                    ["0x", "0x"],
                    { srcAmount: MaxUint256, swapData: "0x12345678" },
                ),
            ).to.be.reverted;
        });

        it("if collateralArray has mixed valid and invalid assets", async function () {
            const moduleContract = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, operator);
            await expect(
                moduleContract.executeDebtSwap(
                    ETH_USDC_POOL,
                    Protocols.AAVE_V3,
                    Protocols.AAVE_V3,
                    USDC_ADDRESS,
                    USDC_ADDRESS,
                    MaxUint256,
                    [
                        { asset: cbETH_ADDRESS, amount: ethers.parseEther(DEFAULT_SUPPLY_AMOUNT) },
                        { asset: zeroAddress, amount: ethers.parseEther("0.1") },
                    ],
                    safeAddress,
                    ["0x", "0x"],
                    { srcAmount: 0n, swapData: "0x" },
                ),
            ).to.be.reverted;
        });

        it("if collateralArray has excessively large amount", async function () {
            const moduleContract = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, operator);
            await expect(
                moduleContract.executeDebtSwap(
                    ETH_USDC_POOL,
                    Protocols.AAVE_V3,
                    Protocols.AAVE_V3,
                    USDC_ADDRESS,
                    USDC_ADDRESS,
                    MaxUint256,
                    [{ asset: cbETH_ADDRESS, amount: MaxUint256 }],
                    safeAddress,
                    ["0x", "0x"],
                    { srcAmount: 0n, swapData: "0x" },
                ),
            ).to.be.reverted;
        });

        it("if user has no debt to swap", async function () {
            // Use a fresh Safe address with no positions
            const moduleContract = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, operator);
            await expect(
                moduleContract.executeDebtSwap(
                    ETH_USDC_POOL,
                    Protocols.AAVE_V3,
                    Protocols.AAVE_V3,
                    USDC_ADDRESS,
                    USDC_ADDRESS,
                    MaxUint256,
                    [{ asset: cbETH_ADDRESS, amount: ethers.parseEther(DEFAULT_SUPPLY_AMOUNT) }],
                    safeAddress, // Safe has no debt position
                    ["0x", "0x"],
                    { srcAmount: 0n, swapData: "0x" },
                ),
            ).to.be.reverted;
        });

        it("if same fromProtocol and toProtocol but different invalid tokens", async function () {
            const moduleContract = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, operator);
            await expect(
                moduleContract.executeDebtSwap(
                    ETH_USDC_POOL,
                    Protocols.AAVE_V3,
                    Protocols.AAVE_V3,
                    "0x1111111111111111111111111111111111111111",
                    "0x2222222222222222222222222222222222222222",
                    MaxUint256,
                    [{ asset: cbETH_ADDRESS, amount: ethers.parseEther(DEFAULT_SUPPLY_AMOUNT) }],
                    safeAddress,
                    ["0x", "0x"],
                    { srcAmount: 0n, swapData: "0x" },
                ),
            ).to.be.reverted;
        });

        it("revert when paraswap data is fetched with wrong contract address", async function () {
            await supplyAndBorrow(Protocols.MOONWELL);

            // Fetch paraswap data with wrong contract address (using TEST_ADDRESS instead of safeModuleAddress)
            const wrongContractAddress = TEST_ADDRESS;

            const FromHelper = protocolHelperMap.get(Protocols.MOONWELL)!;
            const fromHelper = new FromHelper(signer);

            const srcDebtAmount = await fromHelper.getDebtAmount(USDC_ADDRESS, safeAddress);

            // Get paraswap data with wrong contract address
            const wrongParaswapData = await getParaswapData(
                USDC_ADDRESS,
                DAI_ADDRESS,
                wrongContractAddress,
                srcDebtAmount,
            );

            // Try to execute debt swap with wrong paraswap data - should fail
            await expect(
                executeDebtSwapWithCustomParaswapData(
                    ETH_USDC_POOL,
                    USDC_ADDRESS,
                    DAI_ADDRESS,
                    Protocols.MOONWELL,
                    Protocols.AAVE_V3,
                    cbETH_ADDRESS,
                    wrongParaswapData,
                    {
                        operator, // Call directly to properly catch the revert
                    },
                ),
            ).to.be.reverted;
        });
    });

    describe("Fuzz testing", function () {
        it("randomize debt amount", async function () {
            await supplyAndBorrow(Protocols.AAVE_V3);

            await executeDebtSwap(
                ETH_USDC_POOL,
                USDC_ADDRESS,
                USDbC_ADDRESS,
                Protocols.AAVE_V3,
                Protocols.AAVE_V3,
                cbETH_ADDRESS,
                {
                    useMaxAmount: false,
                    randomizeDebtAmount: true,
                },
            );
        });
    });

    async function executeDebtSwapWithCustomParaswapData(
        flashloanPool: string,
        fromTokenAddress: string,
        toTokenAddress: string,
        fromProtocol: Protocols,
        toProtocol: Protocols,
        collateralTokenAddress: string,
        customParaswapData: { srcAmount: bigint; swapData: string },
        options: {
            morphoFromMarketId?: string;
            morphoToMarketId?: string;
            operator?: HardhatEthersSigner;
            fromFluidVaultAddress?: string;
            tofluidVaultAddress?: string;
        } = {},
    ) {
        const FromHelper = protocolHelperMap.get(fromProtocol)!;
        const fromHelper = new FromHelper(signer);
        const ToHelper = protocolHelperMap.get(toProtocol)!;
        const toHelper = new ToHelper(signer);

        const safeModuleAddress = await safeModuleContract.getAddress();
        const moduleContract = await ethers.getContractAt(
            "SafeDebtManager",
            safeModuleAddress,
            options.operator || signer,
        );

        let fromExtraData = "0x";
        let toExtraData = "0x";

        // Handle toProtocol setup (Aave approveDelegation)
        if (toProtocol === Protocols.AAVE_V3) {
            const debtTokenAddress = await toHelper.getDebtTokenAddress(toTokenAddress);
            const aaveDebtToken = new ethers.Contract(debtTokenAddress, aaveDebtTokenJson, signer);

            const authTransactionData: MetaTransactionData = {
                to: debtTokenAddress,
                value: "0",
                data: aaveDebtToken.interface.encodeFunctionData("approveDelegation", [safeModuleAddress, MaxUint256]),
                operation: OperationType.Call,
            };

            const safeTransaction = await safeWallet.createTransaction({
                transactions: [authTransactionData],
            });

            await safeWallet.executeTransaction(safeTransaction);
        }

        let collateralAmount = ethers.parseEther(DEFAULT_SUPPLY_AMOUNT);
        if (fromProtocol === Protocols.MOONWELL) {
            collateralAmount = await fromHelper.getCollateralAmount(collateralTokenAddress, safeAddress);
        }

        // simulate waiting for user's confirmation
        await time.increaseTo((await time.latest()) + 60);

        // Execute with operator to catch revert reason
        await moduleContract.executeDebtSwap(
            flashloanPool,
            fromProtocol,
            toProtocol,
            fromTokenAddress,
            toTokenAddress,
            MaxUint256,
            [{ asset: collateralTokenAddress, amount: collateralAmount }],
            safeAddress,
            [fromExtraData, toExtraData],
            customParaswapData,
            { gasLimit: "2000000" },
        );
    }

    async function executeDebtSwap(
        flashloanPool: string,
        fromTokenAddress: string,
        toTokenAddress: string,
        fromProtocol: Protocols,
        toProtocol: Protocols,
        collateralTokenAddress = cbETH_ADDRESS,
        options: {
            morphoFromMarketId?: string;
            morphoToMarketId?: string;
            useMaxAmount?: boolean;
            anotherCollateralTokenAddress?: string;
            operator?: HardhatEthersSigner;
            fromFluidVaultAddress?: string;
            tofluidVaultAddress?: string;
            randomizeDebtAmount?: boolean;
        } = {
            useMaxAmount: true,
            fromFluidVaultAddress: FLUID_cbETH_USDC_VAULT,
            tofluidVaultAddress: FLUID_cbETH_USDC_VAULT,
        },
    ) {
        const FromHelper = protocolHelperMap.get(fromProtocol)!;
        const fromHelper = new FromHelper(signer);
        const ToHelper = protocolHelperMap.get(toProtocol)!;
        const toHelper = new ToHelper(signer);

        const safeModuleAddress = await safeModuleContract.getAddress();
        const moduleContract = await ethers.getContractAt(
            "SafeDebtManager",
            safeModuleAddress,
            options.operator || signer,
        );

        let fromDebtAmountParameter;
        if (fromProtocol === Protocols.MORPHO) {
            fromDebtAmountParameter = options!.morphoFromMarketId!;
        } else if (fromProtocol === Protocols.FLUID) {
            fromDebtAmountParameter = options?.fromFluidVaultAddress;
        } else {
            fromDebtAmountParameter = fromTokenAddress;
        }

        let toDebtAmountParameter;
        if (toProtocol === Protocols.MORPHO) {
            toDebtAmountParameter = options!.morphoToMarketId!;
        } else if (toProtocol === Protocols.FLUID) {
            toDebtAmountParameter = options?.tofluidVaultAddress;
        } else {
            toDebtAmountParameter = toTokenAddress;
        }

        const srcDebtBefore: bigint = await fromHelper.getDebtAmount(fromDebtAmountParameter, safeAddress);
        const dstDebtBefore: bigint = await toHelper.getDebtAmount(toDebtAmountParameter, safeAddress);

        // Calculate debt amount based on options
        let actualDebtAmount = srcDebtBefore;
        if (options.randomizeDebtAmount) {
            actualDebtAmount = BigInt(Math.floor(Math.random() * Number(srcDebtBefore)));
        }

        // Add 0.001% of initial amount (rounded up) for non-max amounts
        const debtAmount =
            options.useMaxAmount !== false
                ? MaxUint256
                : actualDebtAmount + (actualDebtAmount * 1n + 9_999n) / 1_000_000n;

        // get paraswap data
        let paraswapData = {
            srcAmount: BigInt(0),
            swapData: "0x",
        };

        if (fromTokenAddress != toTokenAddress) {
            paraswapData = await getParaswapData(fromTokenAddress, toTokenAddress, safeModuleAddress, srcDebtBefore);
        }

        let fromExtraData = "0x";
        let toExtraData = "0x";

        switch (fromProtocol) {
            case Protocols.AAVE_V3:
                // if switch to another protocol, must give approval for aToken
                if (toProtocol != Protocols.AAVE_V3) {
                    const aTokenAddress = await fromHelper.getATokenAddress(collateralTokenAddress || cbETH_ADDRESS);

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

                    const approveTransactions = [approveTransactionData];

                    // If another collateral is provided, approve that aToken too
                    if (options.anotherCollateralTokenAddress) {
                        const anotherATokenAddress = await fromHelper.getATokenAddress(
                            options.anotherCollateralTokenAddress,
                        );
                        const anotherToken = new ethers.Contract(anotherATokenAddress, ERC20_ABI, signer);

                        approveTransactions.push({
                            to: anotherATokenAddress,
                            value: "0",
                            data: anotherToken.interface.encodeFunctionData("approve", [
                                safeModuleAddress,
                                ethers.parseEther("1"),
                            ]),
                            operation: OperationType.Call,
                        });
                    }

                    const safeApproveTransaction = await safeWallet.createTransaction({
                        transactions: approveTransactions,
                    });

                    await safeWallet.executeTransaction(safeApproveTransaction);
                    console.log("Safe transaction: Aave approved");
                }
                break;
            case Protocols.COMPOUND:
                const cometAddress = cometAddressMap.get(fromTokenAddress)!;
                const comet = new ethers.Contract(cometAddress, cometAbi, signer);

                const allowTransactionData: MetaTransactionData = {
                    to: cometAddress,
                    value: "0",
                    data: comet.interface.encodeFunctionData("allow", [safeModuleAddress, true]),
                    operation: OperationType.Call,
                };

                const safeAllowTransaction = await safeWallet.createTransaction({
                    transactions: [allowTransactionData],
                });

                await safeWallet.executeTransaction(safeAllowTransaction);
                console.log("Safe transaction: Compound allow");
                break;
            case Protocols.MORPHO:
                await helpers.morphoAuthorizeTxBySafe();

                const borrowShares = await fromHelper.getBorrowShares(options!.morphoFromMarketId!, safeAddress);

                fromExtraData = fromHelper.encodeExtraData(options!.morphoFromMarketId!, borrowShares);
                break;
            case Protocols.FLUID:
                const vaultAddress = options.fromFluidVaultAddress || FLUID_cbETH_USDC_VAULT;
                const nftId = await fromHelper.getNftId(vaultAddress, safeAddress);
                fromExtraData = ethers.AbiCoder.defaultAbiCoder().encode(
                    ["address", "uint256", "bool"],
                    [vaultAddress, nftId, true],
                );
                break;
        }

        switch (toProtocol) {
            case Protocols.AAVE_V3:
                const debtTokenAddress = await toHelper.getDebtTokenAddress(toTokenAddress);
                const aaveDebtToken = new ethers.Contract(debtTokenAddress, aaveDebtTokenJson, signer);

                const authTransactionData: MetaTransactionData = {
                    to: debtTokenAddress,
                    value: "0",
                    data: aaveDebtToken.interface.encodeFunctionData("approveDelegation", [
                        safeModuleAddress,
                        MaxUint256,
                    ]),
                    operation: OperationType.Call,
                };

                const safeTransaction = await safeWallet.createTransaction({
                    transactions: [authTransactionData],
                });

                const safeTxHash = await safeWallet.executeTransaction(safeTransaction);
                console.log("Safe transaction: Aave  approveDelegation");
                break;
            case Protocols.COMPOUND:
                const cometAddress = cometAddressMap.get(toTokenAddress)!;
                const comet = new ethers.Contract(cometAddress, cometAbi, signer);

                const allowTransactionData: MetaTransactionData = {
                    to: cometAddress,
                    value: "0",
                    data: comet.interface.encodeFunctionData("allow", [safeModuleAddress, true]),
                    operation: OperationType.Call,
                };

                const safeAllowTransaction = await safeWallet.createTransaction({
                    transactions: [allowTransactionData],
                });

                await safeWallet.executeTransaction(safeAllowTransaction);
                console.log("Safe transaction: Compound allow");
                break;
            case Protocols.MORPHO:
                // If fromProtocol is not Morpho, authorize Morpho
                const shouldAuthorizeMorpho = fromProtocol !== Protocols.MORPHO;
                if (shouldAuthorizeMorpho) await helpers.morphoAuthorizeTxBySafe();

                const borrowShares = await toHelper.getBorrowShares(options!.morphoToMarketId!, safeAddress);

                toExtraData = toHelper.encodeExtraData(options!.morphoToMarketId!, borrowShares);
                break;
            case Protocols.FLUID:
                const vaultAddress = options.tofluidVaultAddress || FLUID_cbETH_USDC_VAULT;
                toExtraData = ethers.AbiCoder.defaultAbiCoder().encode(
                    ["address", "uint256", "bool"],
                    [vaultAddress, 0, false],
                );
                break;
        }

        let collateralAmount = ethers.parseEther(DEFAULT_SUPPLY_AMOUNT);
        switch (fromProtocol) {
            case Protocols.MOONWELL:
                collateralAmount = await fromHelper.getCollateralAmount(collateralTokenAddress, safeAddress);
                break;
            case Protocols.MORPHO:
                collateralAmount = await fromHelper.getCollateralAmount(options!.morphoFromMarketId!, safeAddress);
                break;
            case Protocols.AAVE_V3:
                collateralAmount = await aaveV3Helper.getCollateralAmount(collateralTokenAddress, safeAddress);
                break;
            case Protocols.COMPOUND:
                const cometAddr = cometAddressMap.get(fromTokenAddress)!;
                collateralAmount = await compoundHelper.getCollateralAmount(
                    cometAddr,
                    collateralTokenAddress,
                    safeAddress,
                );
                break;
        }

        // Build collateralArray (supports multiple collaterals)
        const collateralArray = options.anotherCollateralTokenAddress
            ? [
                  { asset: collateralTokenAddress, amount: collateralAmount },
                  {
                      asset: options.anotherCollateralTokenAddress,
                      amount: ethers.parseEther(DEFAULT_SUPPLY_AMOUNT),
                  },
              ]
            : [{ asset: collateralTokenAddress, amount: collateralAmount }];

        // simulate waiting for user's confirmation
        await time.increaseTo((await time.latest()) + 60);

        // Create Safe transaction for executeDebtSwap
        const executeDebtSwapTxData: MetaTransactionData = {
            to: safeModuleAddress,
            value: "0",
            data: safeModuleContract.interface.encodeFunctionData("executeDebtSwap", [
                flashloanPool,
                fromProtocol,
                toProtocol,
                fromTokenAddress,
                toTokenAddress,
                debtAmount,
                collateralArray,
                safeAddress,
                [fromExtraData, toExtraData],
                paraswapData,
            ]),
            operation: OperationType.Call,
        };

        // If operator is provided, call directly (for testing authorization)
        // Otherwise, call via Safe transaction
        if (options.operator) {
            await moduleContract.executeDebtSwap(
                flashloanPool,
                fromProtocol,
                toProtocol,
                fromTokenAddress,
                toTokenAddress,
                debtAmount,
                collateralArray,
                safeAddress,
                [fromExtraData, toExtraData],
                paraswapData,
                { gasLimit: "2000000" },
            );
        } else {
            const safeTransaction = await safeWallet.createTransaction({
                transactions: [executeDebtSwapTxData],
            });

            await safeWallet.executeTransaction(safeTransaction, {
                gasLimit: "2000000",
            });
        }

        const srcDebtAfter = await fromHelper.getDebtAmount(fromDebtAmountParameter, safeAddress);
        const dstDebtAfter = await toHelper.getDebtAmount(toDebtAmountParameter, safeAddress);

        const srcDecimals = await getDecimals(fromTokenAddress);
        const dstDecimals = await getDecimals(toTokenAddress);

        console.log(
            `Source ${Protocols[fromProtocol]}, ${fromTokenAddress} Debt Amount:`,
            ethers.formatUnits(srcDebtBefore, srcDecimals),
            " -> ",
            ethers.formatUnits(srcDebtAfter, srcDecimals),
        );

        console.log(
            `Destination ${Protocols[toProtocol]}, ${toTokenAddress} Debt Amount:`,
            ethers.formatUnits(dstDebtBefore, dstDecimals),
            " -> ",
            ethers.formatUnits(dstDebtAfter, dstDecimals),
        );

        // Verify debt was switched (unless using randomized amounts)
        if (!options.randomizeDebtAmount) {
            expect(srcDebtAfter).to.be.lt(srcDebtBefore);
            expect(dstDebtAfter).to.be.gt(dstDebtBefore);
        }
    }

    describe("Protocol Enable/Disable", function () {
        it("Should revert when switchFrom is disabled for from protocol", async function () {
            await supplyAndBorrowOnFluid();

            // Get pauser signer (4th signer, index 3)
            const signers = await ethers.getSigners();
            const pauser = signers[3];
            const contractByPauser = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, pauser);

            // Disable switchFrom for Fluid
            const disableTx = await contractByPauser.setProtocolEnabledForSwitchFrom(Protocols.FLUID, false);
            await disableTx.wait();
            console.log("Disabled switchFrom for Fluid");

            // Try to execute debt swap - should fail (call with operator to catch revert reason)
            await expect(
                executeDebtSwap(
                    ETH_USDC_POOL,
                    USDC_ADDRESS,
                    USDC_ADDRESS,
                    Protocols.FLUID,
                    Protocols.AAVE_V3,
                    cbETH_ADDRESS,
                    {
                        operator,
                    },
                ),
            ).to.be.revertedWith("SwitchFrom is disabled for from protocol");
        });

        it("Should revert when switchTo is disabled for to protocol", async function () {
            await supplyAndBorrowOnFluid();

            // Get pauser signer (4th signer, index 3)
            const signers = await ethers.getSigners();
            const pauser = signers[3];
            const contractByPauser = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, pauser);

            // Disable switchTo for Aave
            const disableTx = await contractByPauser.setProtocolEnabledForSwitchTo(Protocols.AAVE_V3, false);
            await disableTx.wait();
            console.log("Disabled switchTo for Aave");

            // Try to execute debt swap - should fail (call with operator to catch revert reason)
            await expect(
                executeDebtSwap(
                    ETH_USDC_POOL,
                    USDC_ADDRESS,
                    USDC_ADDRESS,
                    Protocols.FLUID,
                    Protocols.AAVE_V3,
                    cbETH_ADDRESS,
                    {
                        operator,
                    },
                ),
            ).to.be.revertedWith("SwitchTo is disabled for to protocol");
        });

        it("Should allow debt swap after re-enabling protocols", async function () {
            await supplyAndBorrowOnFluid();

            // Get pauser signer (4th signer, index 3)
            const signers = await ethers.getSigners();
            const pauser = signers[3];
            const contractByPauser = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, pauser);

            // Disable switchFrom for Fluid
            let disableTx = await contractByPauser.setProtocolEnabledForSwitchFrom(Protocols.FLUID, false);
            await disableTx.wait();
            console.log("Disabled switchFrom for Fluid");

            // Verify it's disabled
            const isDisabled = await contractByPauser.protocolEnabledForSwitchFrom(Protocols.FLUID);
            expect(isDisabled).to.be.false;

            // Re-enable switchFrom for Fluid
            const enableTx = await contractByPauser.setProtocolEnabledForSwitchFrom(Protocols.FLUID, true);
            await enableTx.wait();
            console.log("Re-enabled switchFrom for Fluid");

            // Verify it's enabled
            const isEnabled = await contractByPauser.protocolEnabledForSwitchFrom(Protocols.FLUID);
            expect(isEnabled).to.be.true;

            // Now debt swap should work
            await executeDebtSwap(ETH_USDC_POOL, USDC_ADDRESS, USDC_ADDRESS, Protocols.FLUID, Protocols.AAVE_V3);
        });

        it("Should only allow pauser to disable/enable protocols", async function () {
            const [_, wallet2] = await ethers.getSigners();
            const contractByWallet2 = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, wallet2);

            // Try to disable switchFrom as non-pauser - should fail
            await expect(contractByWallet2.setProtocolEnabledForSwitchFrom(Protocols.FLUID, false)).to.be.revertedWith(
                "Caller is not authorized to pause",
            );

            // Try to disable switchTo as non-pauser - should fail
            await expect(contractByWallet2.setProtocolEnabledForSwitchTo(Protocols.FLUID, false)).to.be.revertedWith(
                "Caller is not authorized to pause",
            );
        });

        it("Should emit ProtocolStatusChanged event when enabling/disabling", async function () {
            // Get pauser signer (4th signer, index 3)
            const signers = await ethers.getSigners();
            const pauser = signers[3];
            const contractByPauser = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, pauser);

            // Test switchFrom event
            await expect(contractByPauser.setProtocolEnabledForSwitchFrom(Protocols.FLUID, false))
                .to.emit(contractByPauser, "ProtocolStatusChanged")
                .withArgs(Protocols.FLUID, "switchFrom", false);

            await expect(contractByPauser.setProtocolEnabledForSwitchFrom(Protocols.FLUID, true))
                .to.emit(contractByPauser, "ProtocolStatusChanged")
                .withArgs(Protocols.FLUID, "switchFrom", true);

            // Test switchTo event
            await expect(contractByPauser.setProtocolEnabledForSwitchTo(Protocols.FLUID, false))
                .to.emit(contractByPauser, "ProtocolStatusChanged")
                .withArgs(Protocols.FLUID, "switchTo", false);

            await expect(contractByPauser.setProtocolEnabledForSwitchTo(Protocols.FLUID, true))
                .to.emit(contractByPauser, "ProtocolStatusChanged")
                .withArgs(Protocols.FLUID, "switchTo", true);
        });

        it("Should allow disabling switchFrom while keeping switchTo enabled", async function () {
            // Get pauser signer (4th signer, index 3)
            const signers = await ethers.getSigners();
            const pauser = signers[3];
            const contractByPauser = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, pauser);

            // Disable switchFrom for Fluid, but keep switchTo enabled
            const disableTx = await contractByPauser.setProtocolEnabledForSwitchFrom(Protocols.FLUID, false);
            await disableTx.wait();

            // Verify states
            const switchFromEnabled = await contractByPauser.protocolEnabledForSwitchFrom(Protocols.FLUID);
            const switchToEnabled = await contractByPauser.protocolEnabledForSwitchTo(Protocols.FLUID);

            expect(switchFromEnabled).to.be.false;
            expect(switchToEnabled).to.be.true;

            // Setup position on Aave (since we can't use Fluid as from protocol)
            await supplyAndBorrow(Protocols.AAVE_V3);

            // Should be able to switch TO Fluid (since switchTo is enabled)
            await executeDebtSwap(ETH_USDC_POOL, USDC_ADDRESS, USDC_ADDRESS, Protocols.AAVE_V3, Protocols.FLUID);

            // Re-enable switchFrom for cleanup
            const enableTx = await contractByPauser.setProtocolEnabledForSwitchFrom(Protocols.FLUID, true);
            await enableTx.wait();
        });

        it("Should allow disabling switchTo while keeping switchFrom enabled", async function () {
            // Get pauser signer (4th signer, index 3)
            const signers = await ethers.getSigners();
            const pauser = signers[3];
            const contractByPauser = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, pauser);

            // Disable switchTo for Fluid, but keep switchFrom enabled
            const disableTx = await contractByPauser.setProtocolEnabledForSwitchTo(Protocols.FLUID, false);
            await disableTx.wait();

            // Verify states
            const switchFromEnabled = await contractByPauser.protocolEnabledForSwitchFrom(Protocols.FLUID);
            const switchToEnabled = await contractByPauser.protocolEnabledForSwitchTo(Protocols.FLUID);

            expect(switchFromEnabled).to.be.true;
            expect(switchToEnabled).to.be.false;

            // Setup position on Fluid
            await supplyAndBorrowOnFluid();

            // Should be able to switch FROM Fluid (since switchFrom is enabled)
            await executeDebtSwap(ETH_USDC_POOL, USDC_ADDRESS, USDC_ADDRESS, Protocols.FLUID, Protocols.AAVE_V3);

            // Re-enable switchTo for cleanup
            const enableTx = await contractByPauser.setProtocolEnabledForSwitchTo(Protocols.FLUID, true);
            await enableTx.wait();
        });

        it("Should revert switchIn when either switchFrom or switchTo is disabled", async function () {
            await supplyAndBorrowOnFluid();

            // Get pauser signer (4th signer, index 3)
            const signers = await ethers.getSigners();
            const pauser = signers[3];
            const contractByPauser = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, pauser);

            // Disable switchFrom for Fluid
            const disableTx = await contractByPauser.setProtocolEnabledForSwitchFrom(Protocols.FLUID, false);
            await disableTx.wait();

            // Try switchIn - should fail because switchFrom is disabled (call with operator to catch revert reason)
            await expect(
                executeDebtSwap(
                    ETH_USDC_POOL,
                    USDC_ADDRESS,
                    EURC_ADDRESS,
                    Protocols.FLUID,
                    Protocols.FLUID,
                    cbETH_ADDRESS,
                    {
                        fromFluidVaultAddress: FLUID_cbETH_USDC_VAULT,
                        tofluidVaultAddress: FLUID_cbETH_EURC_VAULT,
                        operator,
                    },
                ),
            ).to.be.revertedWith("SwitchFrom is disabled for from protocol");

            // Re-enable switchFrom and disable switchTo
            const enableFromTx = await contractByPauser.setProtocolEnabledForSwitchFrom(Protocols.FLUID, true);
            await enableFromTx.wait();

            const disableToTx = await contractByPauser.setProtocolEnabledForSwitchTo(Protocols.FLUID, false);
            await disableToTx.wait();

            // Try switchIn again - should fail because switchTo is disabled (call with operator to catch revert reason)
            await expect(
                executeDebtSwap(
                    ETH_USDC_POOL,
                    USDC_ADDRESS,
                    EURC_ADDRESS,
                    Protocols.FLUID,
                    Protocols.FLUID,
                    cbETH_ADDRESS,
                    {
                        fromFluidVaultAddress: FLUID_cbETH_USDC_VAULT,
                        tofluidVaultAddress: FLUID_cbETH_EURC_VAULT,
                        operator,
                    },
                ),
            ).to.be.revertedWith("SwitchTo is disabled for to protocol");

            // Re-enable for cleanup
            const enableToTx = await contractByPauser.setProtocolEnabledForSwitchTo(Protocols.FLUID, true);
            await enableToTx.wait();
        });
    });
});
