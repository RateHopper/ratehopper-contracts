import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { Contract, MaxUint256 } from "ethers";
import { AAVE_V3_POOL_ADDRESS, cbETH_ADDRESS, DEFAULT_SUPPLY_AMOUNT, TEST_ADDRESS } from "../constants";
const aaveV3ProtocolDataProvider = "0xd82a47fdebB5bf5329b09441C3DaB4b5df2153Ad";
const aaveProtocolDataProviderAbi = require("../../externalAbi/aaveV3/aaveProtocolDataProvider.json");
import { abi as ERC20_ABI } from "@openzeppelin/contracts/build/contracts/ERC20.json";
import { approve, defaultProvider, formatAmount } from "../utils";
import aaveDebtTokenJson from "../../externalAbi/aaveV3/aaveDebtToken.json";
import aaveV3PoolJson from "../../externalAbi/aaveV3/aaveV3Pool.json";
import { MetaTransactionData, OperationType } from "@safe-global/types-kit";
import { safeAddress } from "../debtSwapBySafe";

export class AaveV3Helper {
    private protocolDataProvider;
    private pool;

    constructor(private signer: HardhatEthersSigner | any) {
        this.protocolDataProvider = new ethers.Contract(
            aaveV3ProtocolDataProvider,
            aaveProtocolDataProviderAbi,
            signer,
        );
        this.pool = new ethers.Contract(AAVE_V3_POOL_ADDRESS, aaveV3PoolJson, signer);
    }

    async getDebtTokenAddress(assetAddress: string): Promise<string> {
        const response = await this.protocolDataProvider.getReserveTokensAddresses(assetAddress);
        return response.variableDebtTokenAddress;
    }

    async getCollateralAmount(assetAddress: string, userAddress?: string): Promise<bigint> {
        const result = await this.protocolDataProvider.getUserReserveData(assetAddress, userAddress || this.signer);
        return result.currentATokenBalance;
    }

    async getDebtAmount(assetAddress: string, userAddress?: string): Promise<bigint> {
        const result = await this.protocolDataProvider.getUserReserveData(assetAddress, userAddress || this.signer);
        return result.currentVariableDebt;
    }

    async getATokenAddress(assetAddress: string): Promise<string> {
        const result = await this.pool.getReserveData(assetAddress);
        console.log("aTokenAddress:", result.aTokenAddress);
        return result.aTokenAddress;
    }

    async approveDelegation(tokenAddress: string, deployedContractAddress: string) {
        const debtTokenAddress = await this.getDebtTokenAddress(tokenAddress);
        const aaveDebtToken = new ethers.Contract(debtTokenAddress, aaveDebtTokenJson, this.signer);
        const approveDelegationTx = await aaveDebtToken.approveDelegation(deployedContractAddress, MaxUint256);
        await approveDelegationTx.wait();
        console.log("approveDelegation:", debtTokenAddress);
    }

    async supply(tokenAddress: string) {
        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, this.signer);

        await approve(tokenAddress, AAVE_V3_POOL_ADDRESS, this.signer);
        const amount = ethers.parseEther(DEFAULT_SUPPLY_AMOUNT);

        const supplyTx = await this.pool.supply(tokenAddress, amount, TEST_ADDRESS, 0);
        await supplyTx.wait();

        const walletBalance = await tokenContract.balanceOf(TEST_ADDRESS);
        console.log(`${tokenAddress} Wallet Balance:`, ethers.formatEther(walletBalance));
    }

    async borrow(tokenAddress: string, borrowAmount?: bigint) {
        const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, this.signer);
        const decimals = await tokenContract.decimals();
        const decimalsNumber = typeof decimals === "bigint" ? Number(decimals) : decimals;
        const amount = borrowAmount || ethers.parseUnits("1", decimalsNumber);

        const borrowTx = await this.pool.borrow(tokenAddress, amount, 2, 0, TEST_ADDRESS);
        await borrowTx.wait();

        const walletBalance = await tokenContract.balanceOf(TEST_ADDRESS);
        console.log(`borrowed ${amount}, ${tokenAddress} Wallet Balance:`, formatAmount(walletBalance));
    }

    async getSupplyAndBorrowTxdata(
        debtTokenAddress,
        collateralTokenAddress = cbETH_ADDRESS,
        customBorrowAmount?: bigint,
    ): Promise<MetaTransactionData[]> {
        const aavePool = new ethers.Contract(AAVE_V3_POOL_ADDRESS, aaveV3PoolJson, defaultProvider);

        const collateralContract = new ethers.Contract(collateralTokenAddress, ERC20_ABI, defaultProvider);
        let borrowAmount: bigint;
        if (customBorrowAmount) {
            borrowAmount = customBorrowAmount;
        } else {
            const debtTokenContract = new ethers.Contract(debtTokenAddress, ERC20_ABI, defaultProvider);
            const debtTokenDecimals = await debtTokenContract.decimals();
            const debtTokenDecimalsNumber =
                typeof debtTokenDecimals === "bigint" ? Number(debtTokenDecimals) : debtTokenDecimals;
            borrowAmount = ethers.parseUnits("1", debtTokenDecimalsNumber);
        }
        const approveTransactionData: MetaTransactionData = {
            to: collateralTokenAddress,
            value: "0",
            data: collateralContract.interface.encodeFunctionData("approve", [
                AAVE_V3_POOL_ADDRESS,
                ethers.parseEther("1"),
            ]),
            operation: OperationType.Call,
        };

        const supplyTransactionData: MetaTransactionData = {
            to: AAVE_V3_POOL_ADDRESS,
            value: "0",
            data: aavePool.interface.encodeFunctionData("supply", [
                collateralTokenAddress,
                ethers.parseEther(DEFAULT_SUPPLY_AMOUNT),
                safeAddress,
                0,
            ]),
            operation: OperationType.Call,
        };

        const borrowTransactionData: MetaTransactionData = {
            to: AAVE_V3_POOL_ADDRESS,
            value: "0",
            data: aavePool.interface.encodeFunctionData("borrow", [debtTokenAddress, borrowAmount, 2, 0, safeAddress]),
            operation: OperationType.Call,
        };
        return [approveTransactionData, supplyTransactionData, borrowTransactionData];
    }
}
