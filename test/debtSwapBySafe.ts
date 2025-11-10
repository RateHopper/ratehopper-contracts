import { ethers } from "hardhat";
import dotenv from "dotenv";
dotenv.config();
import Safe, { Eip1193Provider, RequestArguments } from "@safe-global/protocol-kit";
import {
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
import { fundETH, getDecimals, getParaswapData, protocolHelperMap } from "./utils";
import {
    FLUID_cbETH_EURC_VAULT,
    FLUID_cbETH_USDC_VAULT,
    FLUID_WETH_USDC_VAULT,
    FLUID_wstETH_sUSDS_VAULT,
    FLUID_wstETH_USDC_VAULT,
    FluidHelper,
} from "./protocols/fluid";
import { cometAddressMap, CompoundHelper, USDC_COMET_ADDRESS } from "./protocols/compound";
import { MORPHO_ADDRESS, morphoMarket1Id, morphoMarket2Id, MorphoHelper } from "./protocols/morpho";
import FluidVaultAbi from "../externalAbi/fluid/fluidVaultT1.json";
import aaveDebtTokenJson from "../externalAbi/aaveV3/aaveDebtToken.json";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { deploySafeContractFixture } from "./deployUtils";
import { WETH9 } from "@uniswap/sdk-core";

export const eip1193Provider: Eip1193Provider = {
    request: async (args: RequestArguments) => {
        const { method, params } = args;
        return ethers.provider.send(method, Array.isArray(params) ? params : []);
    },
};

export const safeAddress = "0x2f9054Eb6209bb5B94399115117044E4f150B2De";

describe("Safe wallet should debtSwap", function () {
    // Increase timeout for memory-intensive operations
    this.timeout(300000); // 5 minutes

    const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, ethers.provider);
    let operator: HardhatEthersSigner;
    let safeWallet;
    let safeModuleContract;
    let safeModuleAddress;

    this.beforeEach(async () => {
        // Get the operator (third signer)
        const signers = await ethers.getSigners();
        operator = signers[2];

        safeWallet = await Safe.init({
            provider: eip1193Provider,
            signer: process.env.PRIVATE_KEY,
            safeAddress: safeAddress,
        });

        const safeModule = await loadFixture(deploySafeContractFixture);
        safeModuleContract = safeModule;
        safeModuleAddress = await safeModuleContract.getAddress();

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

        const protocolCallData = await helper.getSupplyAndBorrowTxdata(debtTokenAddress, collateralTokenAddress);

        const tokenContract = new ethers.Contract(debtTokenAddress, ERC20_ABI, signer);

        const decimals = await getDecimals(debtTokenAddress);

        const transferTransactionData: MetaTransactionData = {
            to: debtTokenAddress,
            value: "0",
            data: tokenContract.interface.encodeFunctionData("transfer", [
                TEST_ADDRESS,
                ethers.parseUnits("1", decimals),
            ]),
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
    describe("switch In", function () {
        it("Aave from USDC to USDbC", async function () {
            await supplyAndBorrow(Protocols.AAVE_V3);

            await executeDebtSwap(ETH_USDC_POOL, USDC_ADDRESS, USDbC_ADDRESS, Protocols.AAVE_V3, Protocols.AAVE_V3);
        });
        // USDbC is not available on Compound anymore
        it.skip("Compound from USDC to USDbC", async function () {
            await supplyAndBorrow(Protocols.COMPOUND);
            await executeDebtSwap(ETH_USDC_POOL, USDC_ADDRESS, USDbC_ADDRESS, Protocols.COMPOUND, Protocols.COMPOUND);
        });

        it("In Morpho USDC another market", async function () {
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

        it("In Moonwell from USDC to DAI", async function () {
            await supplyAndBorrow(Protocols.MOONWELL);
            await executeDebtSwap(ETH_USDC_POOL, USDC_ADDRESS, DAI_ADDRESS, Protocols.MOONWELL, Protocols.MOONWELL);
        });

        it("In Fluid from USDC to sUSDS with cbBTC collateral", async function () {
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

    it("Set operator address and Call executeDebtSwap by operator", async function () {
        const safeModuleAddress = await safeModuleContract.getAddress();
        const [_, wallet2] = await ethers.getSigners();
        const safeModule = await ethers.getContractAt("SafeDebtManager", safeModuleAddress);

        await safeModule.setoperator(wallet2.address);

        await supplyAndBorrow(Protocols.MOONWELL);
        await executeDebtSwap(
            ETH_USDC_POOL,
            USDC_ADDRESS,
            USDC_ADDRESS,
            Protocols.MOONWELL,
            Protocols.AAVE_V3,
            cbETH_ADDRESS,
            {
                operator: wallet2,
            },
        );
    });

    it("Revert when calling executeDebtSwap by non operator(wallet3)", async function () {
        const safeModuleAddress = await safeModuleContract.getAddress();
        const [_, wallet2, wallet3] = await ethers.getSigners();
        const safeModule = await ethers.getContractAt("SafeDebtManager", safeModuleAddress);

        // await safeModule.setoperator(wallet2.address);

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
                    operator: wallet3,
                },
            ),
        ).to.be.revertedWith("Caller is not authorized");
    });

    it("revert if flashloan pool is not uniswap v3 pool", async function () {
        await supplyAndBorrow(Protocols.MOONWELL);

        await expect(
            executeDebtSwap(
                USDC_ADDRESS, // Using USDC contract address which doesn't have token0() function
                USDC_ADDRESS,
                USDC_ADDRESS,
                Protocols.MOONWELL,
                Protocols.AAVE_V3,
            ),
        ).to.be.revertedWith("Invalid flashloan pool address");
    });

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

                    const safeApproveTransaction = await safeWallet.createTransaction({
                        transactions: [approveTransactionData],
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
                await morphoAuthorizeTxBySafe();

                const borrowShares = await fromHelper.getBorrowShares(options!.morphoFromMarketId!, safeAddress);

                fromExtraData = fromHelper.encodeExtraData(options!.morphoFromMarketId!, borrowShares);
                break;
            case Protocols.FLUID:
                const vaultAddress = options.fromFluidVaultAddress || FLUID_cbETH_USDC_VAULT;
                const nftId = await fromHelper.getNftId(vaultAddress, safeAddress);
                fromExtraData = ethers.AbiCoder.defaultAbiCoder().encode(
                    ["address", "uint256", "bool"],
                    [vaultAddress, nftId, false],
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
                if (shouldAuthorizeMorpho) await morphoAuthorizeTxBySafe();

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
        }

        // simulate waiting for user's confirmation
        await time.increaseTo((await time.latest()) + 60);

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
            paraswapData,
            {
                gasLimit: "2000000",
            },
        );

        const srcDebtAfter = await fromHelper.getDebtAmount(fromDebtAmountParameter, safeAddress);
        const dstDebtAfter = await toHelper.getDebtAmount(toDebtAmountParameter, safeAddress);

        const srcDecimals = await getDecimals(fromTokenAddress);
        const dstDecimals = await getDecimals(toTokenAddress);

        console.log(
            `Source ${fromProtocol}, ${fromTokenAddress} Debt Amount:`,
            ethers.formatUnits(srcDebtBefore, srcDecimals),
            " -> ",
            ethers.formatUnits(srcDebtAfter, srcDecimals),
        );

        console.log(
            `Destination ${toProtocol}, ${toTokenAddress} Debt Amount:`,
            ethers.formatUnits(dstDebtBefore, dstDecimals),
            " -> ",
            ethers.formatUnits(dstDebtAfter, dstDecimals),
        );
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
        } = options;

        // Step 0: Fund the operator with ETH for gas
        const fundTx = await signer.sendTransaction({
            to: operator.address,
            value: ethers.parseEther("0.01"),
        });
        await fundTx.wait();
        console.log("Operator funded with ETH");

        // Step 1: Create a position (supply collateral and borrow)
        await setupPosition();

        // Step 2: Get current debt amount
        const debtBefore = await getDebtAmount();
        console.log("Debt before exit:", ethers.formatUnits(debtBefore, debtDecimals));
        expect(debtBefore).to.be.gt(0);

        // Step 3: Send debt tokens to Safe to cover the repayment (including any accrued interest)
        const debtContract = new ethers.Contract(debtAsset, ERC20_ABI, signer);
        const repayAmount = debtBefore + ethers.parseUnits("10", debtDecimals); // Add buffer for interest
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

        // Step 6: Set operator in SafeDebtManager
        const signers = await ethers.getSigners();
        const moduleContractByOwner = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, signers[0]);
        const setOperatorTx = await moduleContractByOwner.setoperator(operator.address);
        await setOperatorTx.wait();
        console.log("Operator set to:", operator.address);

        // Step 7: Get extra data for protocol-specific parameters
        const extraData = await getExtraData();

        // Step 8: Call exit function using operator
        const moduleContract = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, operator);

        // Use override amount if provided, otherwise use actual debt amount with 1% buffer
        const debtAmountToUse = debtAmountOverride !== undefined ? debtAmountOverride : (debtBefore * 101n) / 100n;

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

        const receipt = await exitTx.wait();
        console.log(`Exit transaction completed with withdrawCollateral=${withdrawCollateral}`);

        // Verify DebtPositionExited event was emitted
        const exitEvent = receipt?.logs.find((log: any) => {
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

        // Step 9: Verify debt is repaid
        await validateDebtRepaid();

        // Step 10: Verify collateral withdrawal behavior based on withdrawCollateral parameter
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
                    return ethers.parseEther(DEFAULT_SUPPLY_AMOUNT);
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
                    return ethers.parseEther(DEFAULT_SUPPLY_AMOUNT);
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

            // Step 1: Create a position (supply collateral and borrow)
            await supplyAndBorrowOnFluid();

            // Step 2: Get current debt amount
            const debtBefore = await fluidHelper.getDebtAmount(vaultAddress, safeAddress);
            console.log("Debt before exit:", ethers.formatUnits(debtBefore, 6));
            expect(debtBefore).to.be.gt(0);

            // Step 3: Send debt tokens to Safe to cover the repayment (including any accrued interest)
            const debtContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, signer);
            const repayAmount = debtBefore + ethers.parseUnits("10", 6); // Add buffer for interest
            const transferTx = await debtContract.transfer(safeAddress, repayAmount);
            await transferTx.wait();
            console.log("Debt tokens transferred to Safe");

            // Step 4: Get collateral amount
            const collateralAmount = ethers.parseEther(DEFAULT_SUPPLY_AMOUNT);
            console.log("Collateral amount:", ethers.formatUnits(collateralAmount, 18));

            // Step 5: Get collateral balance before exit
            const collateralContract = new ethers.Contract(cbETH_ADDRESS, ERC20_ABI, signer);
            const collateralBalanceBefore = await collateralContract.balanceOf(safeAddress);
            console.log("Collateral balance before exit:", ethers.formatUnits(collateralBalanceBefore, 18));

            // Step 6: Get extra data for Fluid
            const nftId = await fluidHelper.getNftId(vaultAddress, safeAddress);
            const extraData = ethers.AbiCoder.defaultAbiCoder().encode(
                ["address", "uint256", "bool"],
                [vaultAddress, nftId, true], // isFullRepay = true
            );

            // Step 7: Create Safe transaction to call exit
            const moduleContract = await ethers.getContractAt("SafeDebtManager", safeModuleAddress);

            const exitCallData: MetaTransactionData = {
                to: safeModuleAddress,
                value: "0",
                data: moduleContract.interface.encodeFunctionData("exit", [
                    Protocols.FLUID,
                    USDC_ADDRESS,
                    debtBefore,
                    [{ asset: cbETH_ADDRESS, amount: collateralAmount }],
                    safeAddress,
                    extraData,
                    true, // withdrawCollateral
                ]),
                operation: OperationType.Call,
            };

            const safeTransaction = await safeWallet.createTransaction({
                transactions: [exitCallData],
            });

            await safeWallet.executeTransaction(safeTransaction);
            console.log("Exit transaction completed via Safe");

            // Step 8: Verify debt is repaid
            const debtAfter = await fluidHelper.getDebtAmount(vaultAddress, safeAddress);
            console.log("Debt after exit:", ethers.formatUnits(debtAfter, 6));
            expect(debtAfter).to.equal(0);

            // Step 9: Verify collateral is withdrawn (balance should increase)
            const collateralBalanceAfter = await collateralContract.balanceOf(safeAddress);
            console.log("Collateral balance after exit:", ethers.formatUnits(collateralBalanceAfter, 18));
            expect(collateralBalanceAfter).to.be.gt(collateralBalanceBefore);

            // The withdrawn collateral should approximately equal the collateral amount
            const withdrawnAmount = collateralBalanceAfter - collateralBalanceBefore;
            console.log("Withdrawn collateral:", ethers.formatUnits(withdrawnAmount, 18));
            const tolerance = ethers.parseEther("0.001");
            expect(withdrawnAmount).to.be.closeTo(collateralAmount, tolerance);
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
                    return ethers.parseEther(DEFAULT_SUPPLY_AMOUNT);
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
                    return ethers.parseEther(DEFAULT_SUPPLY_AMOUNT);
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

            // Try to execute debt swap - should fail
            await expect(
                executeDebtSwap(ETH_USDC_POOL, USDC_ADDRESS, USDC_ADDRESS, Protocols.FLUID, Protocols.AAVE_V3),
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

            // Try to execute debt swap - should fail
            await expect(
                executeDebtSwap(ETH_USDC_POOL, USDC_ADDRESS, USDC_ADDRESS, Protocols.FLUID, Protocols.AAVE_V3),
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

            // Try switchIn - should fail because switchFrom is disabled
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
                    },
                ),
            ).to.be.revertedWith("SwitchFrom is disabled for from protocol");

            // Re-enable switchFrom and disable switchTo
            const enableFromTx = await contractByPauser.setProtocolEnabledForSwitchFrom(Protocols.FLUID, true);
            await enableFromTx.wait();

            const disableToTx = await contractByPauser.setProtocolEnabledForSwitchTo(Protocols.FLUID, false);
            await disableToTx.wait();

            // Try switchIn again - should fail because switchTo is disabled
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
                    },
                ),
            ).to.be.revertedWith("SwitchTo is disabled for to protocol");

            // Re-enable for cleanup
            const enableToTx = await contractByPauser.setProtocolEnabledForSwitchTo(Protocols.FLUID, true);
            await enableToTx.wait();
        });
    });
});
