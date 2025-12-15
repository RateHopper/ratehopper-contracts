import * as ethersLib from "ethers";
import { MaxUint256 } from "ethers";
import dotenv from "dotenv";
dotenv.config();
import SafeModule from "@safe-global/protocol-kit";
const Safe = SafeModule.default || SafeModule;
import {
    cbETH_ADDRESS,
    DEFAULT_SUPPLY_AMOUNT,
    Protocols,
    USDC_ADDRESS,
    WETH_ADDRESS,
    cbETH_ETH_POOL,
} from "./constants.js";
import ERC20Json from "@openzeppelin/contracts/build/contracts/ERC20.json" with { type: "json" };
const ERC20_ABI = ERC20Json.abi;
import * as SafeTypes from "@safe-global/types-kit";
type MetaTransactionData = SafeTypes.MetaTransactionData;
const OperationType = SafeTypes.OperationType;
import { eip1193Provider, fundETH, fundSignerWithETH, getDecimals, getParaswapData } from "./utils.js";
import { FLUID_cbETH_USDC_VAULT, FluidHelper, fluidVaultMap } from "./protocols/fluid.js";
import FluidVaultAbi from "../externalAbi/fluid/fluidVaultT1.json" with { type: "json" };
import { expect } from "chai";
import { getGasOptions, deployLeveragedPositionContractFixture } from "./deployUtils.js";
import { connectNetwork, getEthers, loadFixture } from "./testSetup.js";
import { safeAddress } from "./debtSwapBySafe.js";

describe("SafeExecTransactionWrapper", function () {
    // Increase timeout for memory-intensive operations
    this.timeout(300000); // 5 minutes

    let signer: ethersLib.Wallet;
    let safeWallet: any;
    let wrapperContract: any;
    let wrapperAddress: string;

    before(async function () {
        await connectNetwork();
    });

    this.beforeEach(async () => {
        const ethers = getEthers();
        signer = new ethersLib.Wallet(process.env.TESTING_SAFE_OWNER_KEY!, ethers.provider);

        // Fund the signer wallet (TESTING_SAFE_OWNER_KEY) with ETH for gas fees
        await fundSignerWithETH(signer.address);

        safeWallet = await Safe.init({
            provider: eip1193Provider,
            signer: process.env.TESTING_SAFE_OWNER_KEY,
            safeAddress: safeAddress,
        });

        // Deploy SafeExecTransactionWrapper
        const SafeExecTransactionWrapper = await ethers.getContractFactory("SafeExecTransactionWrapper");
        const gasOptions = await getGasOptions();
        wrapperContract = await SafeExecTransactionWrapper.deploy(gasOptions);
        await wrapperContract.waitForDeployment();
        wrapperAddress = await wrapperContract.getAddress();
        console.log("SafeExecTransactionWrapper deployed to:", wrapperAddress);

        await fundETH(safeAddress);
    });

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
                value: ethersLib.parseEther("0.001"),
            });
            await tx.wait();
        } else {
            const tokenContract = new ethersLib.Contract(tokenAddress, ERC20_ABI, signer);
            const tx = await tokenContract.transfer(safeAddress, ethersLib.parseEther("0.001"));
            await tx.wait();
        }
    }

    async function supplyAndBorrowOnFluidViaWrapper(
        vaultAddress = FLUID_cbETH_USDC_VAULT,
        collateralTokenAddress = cbETH_ADDRESS,
        supplyAmount = ethersLib.parseEther(DEFAULT_SUPPLY_AMOUNT),
    ) {
        await sendCollateralToSafe(collateralTokenAddress, Protocols.FLUID);
        const collateralTokenContract = new ethersLib.Contract(collateralTokenAddress, ERC20_ABI, signer);

        const fluidVault = new ethersLib.Contract(vaultAddress, FluidVaultAbi, signer);

        const transactions: MetaTransactionData[] = [];

        // Skip approval for WETH (sending ETH directly)
        if (collateralTokenAddress !== WETH_ADDRESS) {
            const approveTransactionData: MetaTransactionData = {
                to: collateralTokenAddress,
                value: "0",
                data: collateralTokenContract.interface.encodeFunctionData("approve", [
                    vaultAddress,
                    ethersLib.parseEther("1"),
                ]),
                operation: OperationType.Call,
            };
            transactions.push(approveTransactionData);
        }

        // Use Fluid's operate to supply AND borrow in a single call
        // operate(nftId, newCol, newDebt, to)
        // nftId = 0 creates new position
        // newCol = positive for deposit
        // newDebt = positive for borrow
        const supplyAndBorrowTransactionData: MetaTransactionData = {
            to: vaultAddress,
            value: collateralTokenAddress === WETH_ADDRESS ? supplyAmount.toString() : "0",
            data: fluidVault.interface.encodeFunctionData("operate", [
                0, // nftId = 0 creates new position
                supplyAmount, // Supply collateral
                ethersLib.parseUnits("1", 6), // Borrow 1 USDC
                safeAddress,
            ]),
            operation: OperationType.Call,
        };
        transactions.push(supplyAndBorrowTransactionData);

        // Create Safe transaction with all operations batched together
        const safeTx = await safeWallet.createTransaction({
            transactions: transactions,
        });

        const safeTxHash = await safeWallet.getTransactionHash(safeTx);
        const signature = await safeWallet.signHash(safeTxHash);

        console.log("Executing supply + borrow via wrapper (single call)...");

        // Get the transaction data from the Safe transaction
        const txData = safeTx.data;

        // Execute all operations via wrapper in one call
        const metadata = ethersLib.AbiCoder.defaultAbiCoder().encode(
            [
                "uint8",
                "uint8",
                "address",
                "address",
                "address",
                "uint8",
                "address",
                "uint256",
                "uint256",
                "address",
                "bytes",
            ],
            [
                0, // operation: 0 = open agent
                0, // strategyType
                safeAddress, // user
                collateralTokenAddress, // collateralAsset
                USDC_ADDRESS, // debtAsset
                3, // borrowProtocol
                vaultAddress, // borrowMarketId
                supplyAmount, // collateralAmount
                ethersLib.parseUnits("1", 6), // debtAmount
                ethersLib.ZeroAddress, // additionalInteractionContract
                "0x", // customData (empty bytes)
            ],
        );
        const wrapperTx = await wrapperContract.execTransaction(
            safeAddress,
            txData.to,
            txData.value,
            txData.data,
            txData.operation,
            0, // safeTxGas
            0, // baseGas
            0, // gasPrice
            ethersLib.ZeroAddress, // gasToken
            ethersLib.ZeroAddress, // refundReceiver
            signature.data,
            metadata,
            {
                gasLimit: "10000000",
            },
        );
        const receipt = await wrapperTx.wait();
        console.log("Supply + borrow executed via wrapper in single call, gas used:", receipt?.gasUsed.toString());
    }

    it("Should supply and borrow on Fluid via execTransaction wrapper", async function () {
        const vaultAddress = FLUID_cbETH_USDC_VAULT;
        const fluidHelper = new FluidHelper(signer);

        // Get initial balances
        const usdcContract = new ethersLib.Contract(USDC_ADDRESS, ERC20_ABI, signer);
        const usdcBalanceBefore = await usdcContract.balanceOf(safeAddress);
        console.log("USDC balance before:", ethersLib.formatUnits(usdcBalanceBefore, 6));

        // Execute supply and borrow via wrapper
        await supplyAndBorrowOnFluidViaWrapper();

        // Verify debt was created
        const debtAmount = await fluidHelper.getDebtAmount(vaultAddress, safeAddress);
        console.log("Debt amount after:", ethersLib.formatUnits(debtAmount, 6));
        expect(debtAmount).to.be.gt(0);

        // Verify collateral was supplied
        const collateralAmount = await fluidHelper.getCollateralAmount(cbETH_ADDRESS, safeAddress);
        console.log("Collateral amount after:", ethersLib.formatUnits(collateralAmount, 18));
        expect(collateralAmount).to.be.gt(0);

        // Verify NFT was created
        const nftId = await fluidHelper.getNftId(vaultAddress, safeAddress);
        console.log("NFT ID:", nftId.toString());
        expect(nftId).to.be.gt(0);

        // Verify USDC was borrowed and some transferred out
        const usdcBalanceAfter = await usdcContract.balanceOf(safeAddress);
        console.log("USDC balance after:", ethersLib.formatUnits(usdcBalanceAfter, 6));
        // Should have borrowed but also transferred 1 USDC out
        expect(usdcBalanceAfter).to.be.gt(usdcBalanceBefore);
    });

    it("Should revert when trying to borrow without collateral via wrapper", async function () {
        const vaultAddress = FLUID_cbETH_USDC_VAULT;
        const fluidVault = new ethersLib.Contract(vaultAddress, FluidVaultAbi, signer);

        console.log("Attempting to borrow without supplying collateral via wrapper...");

        // Try to borrow without supplying collateral (newCol = 0, newDebt = 1 USDC)
        const borrowWithoutCollateralData: MetaTransactionData = {
            to: vaultAddress,
            value: "0",
            data: fluidVault.interface.encodeFunctionData("operate", [
                0, // nftId = 0 creates new position
                0, // NO collateral supplied
                ethersLib.parseUnits("1", 6), // Try to borrow 1 USDC
                safeAddress,
            ]),
            operation: OperationType.Call,
        };

        // Create Safe transaction
        const safeTx = await safeWallet.createTransaction({
            transactions: [borrowWithoutCollateralData],
        });

        const safeTxHash = await safeWallet.getTransactionHash(safeTx);
        const signature = await safeWallet.signHash(safeTxHash);

        const txData = safeTx.data;

        // Execute via wrapper - should revert (Safe will revert with GS013 for failed transaction)
        const metadata = ethersLib.AbiCoder.defaultAbiCoder().encode(
            [
                "uint8",
                "uint8",
                "address",
                "address",
                "address",
                "uint8",
                "address",
                "uint256",
                "uint256",
                "address",
                "bytes",
            ],
            [
                0, // operation: 0 = open agent
                0, // strategyType
                safeAddress, // user
                cbETH_ADDRESS, // collateralAsset
                USDC_ADDRESS, // debtAsset
                3, // borrowProtocol
                vaultAddress, // borrowMarketId
                0, // collateralAmount (0 - no collateral)
                ethersLib.parseUnits("1", 6), // debtAmount
                ethersLib.ZeroAddress, // additionalInteractionContract
                "0x", // customData (empty bytes)
            ],
        );
        await expect(
            wrapperContract.execTransaction(
                safeAddress,
                txData.to,
                txData.value,
                txData.data,
                txData.operation,
                0, // safeTxGas
                0, // baseGas
                0, // gasPrice
                ethersLib.ZeroAddress, // gasToken
                ethersLib.ZeroAddress, // refundReceiver
                signature.data,
                metadata,
                {
                    gasLimit: "10000000",
                },
            ),
        ).to.be.revertedWith("GS013");

        console.log("Transaction correctly reverted with GS013 when trying to borrow without collateral");
        // The transaction reverted as expected, preventing invalid state
    });
});
