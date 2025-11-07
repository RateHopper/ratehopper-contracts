import { ethers } from "hardhat";
import dotenv from "dotenv";
dotenv.config();
import Safe, { Eip1193Provider, RequestArguments } from "@safe-global/protocol-kit";
import {
    cbETH_ADDRESS,
    DEFAULT_SUPPLY_AMOUNT,
    Protocols,
    USDC_ADDRESS,
    WETH_ADDRESS,
    cbETH_ETH_POOL,
} from "./constants";
import { abi as ERC20_ABI } from "@openzeppelin/contracts/build/contracts/ERC20.json";
import { MetaTransactionData, OperationType } from "@safe-global/types-kit";
import { fundETH, getDecimals, getParaswapData } from "./utils";
import { FLUID_cbETH_USDC_VAULT, FluidHelper, fluidVaultMap } from "./protocols/fluid";
import FluidVaultAbi from "../externalAbi/fluid/fluidVaultT1.json";
import { expect } from "chai";
import { getGasOptions, deployLeveragedPositionContractFixture } from "./deployUtils";
import { MaxUint256 } from "ethers";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";

export const eip1193Provider: Eip1193Provider = {
    request: async (args: RequestArguments) => {
        const { method, params } = args;
        return ethers.provider.send(method, Array.isArray(params) ? params : []);
    },
};

export const safeAddress = "0x2f9054Eb6209bb5B94399115117044E4f150B2De";

describe("SafeExecTransactionWrapper", function () {
    // Increase timeout for memory-intensive operations
    this.timeout(300000); // 5 minutes

    const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, ethers.provider);
    let safeWallet: Safe;
    let wrapperContract: any;
    let wrapperAddress: string;

    this.beforeEach(async () => {
        safeWallet = await Safe.init({
            provider: eip1193Provider,
            signer: process.env.PRIVATE_KEY,
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
                value: ethers.parseEther("0.001"),
            });
            await tx.wait();
        } else {
            const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
            const tx = await tokenContract.transfer(safeAddress, ethers.parseEther("0.001"));
            await tx.wait();
        }
    }

    async function supplyAndBorrowOnFluidViaWrapper(
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
                ethers.parseUnits("1", 6), // Borrow 1 USDC
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
        const wrapperTx = await wrapperContract.execTransaction(
            safeAddress,
            txData.to,
            txData.value,
            txData.data,
            txData.operation,
            0, // safeTxGas
            0, // baseGas
            0, // gasPrice
            ethers.ZeroAddress, // gasToken
            ethers.ZeroAddress, // refundReceiver
            signature.data,
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
        const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, signer);
        const usdcBalanceBefore = await usdcContract.balanceOf(safeAddress);
        console.log("USDC balance before:", ethers.formatUnits(usdcBalanceBefore, 6));

        // Execute supply and borrow via wrapper
        await supplyAndBorrowOnFluidViaWrapper();

        // Verify debt was created
        const debtAmount = await fluidHelper.getDebtAmount(vaultAddress, safeAddress);
        console.log("Debt amount after:", ethers.formatUnits(debtAmount, 6));
        expect(debtAmount).to.be.gt(0);

        // Verify collateral was supplied
        const collateralAmount = await fluidHelper.getCollateralAmount(cbETH_ADDRESS, safeAddress);
        console.log("Collateral amount after:", ethers.formatUnits(collateralAmount, 18));
        expect(collateralAmount).to.be.gt(0);

        // Verify NFT was created
        const nftId = await fluidHelper.getNftId(vaultAddress, safeAddress);
        console.log("NFT ID:", nftId.toString());
        expect(nftId).to.be.gt(0);

        // Verify USDC was borrowed and some transferred out
        const usdcBalanceAfter = await usdcContract.balanceOf(safeAddress);
        console.log("USDC balance after:", ethers.formatUnits(usdcBalanceAfter, 6));
        // Should have borrowed but also transferred 1 USDC out
        expect(usdcBalanceAfter).to.be.gt(usdcBalanceBefore);
    });

    it("Should revert when trying to borrow without collateral via wrapper", async function () {
        const vaultAddress = FLUID_cbETH_USDC_VAULT;
        const fluidVault = new ethers.Contract(vaultAddress, FluidVaultAbi, signer);

        console.log("Attempting to borrow without supplying collateral via wrapper...");

        // Try to borrow without supplying collateral (newCol = 0, newDebt = 1 USDC)
        const borrowWithoutCollateralData: MetaTransactionData = {
            to: vaultAddress,
            value: "0",
            data: fluidVault.interface.encodeFunctionData("operate", [
                0, // nftId = 0 creates new position
                0, // NO collateral supplied
                ethers.parseUnits("1", 6), // Try to borrow 1 USDC
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
                ethers.ZeroAddress, // gasToken
                ethers.ZeroAddress, // refundReceiver
                signature.data,
                {
                    gasLimit: "10000000",
                },
            ),
        ).to.be.revertedWith("GS013");

        console.log("Transaction correctly reverted with GS013 when trying to borrow without collateral");
        // The transaction reverted as expected, preventing invalid state
    });
});
