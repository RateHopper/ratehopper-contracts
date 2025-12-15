import * as ethersLib from "ethers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { Contract, MaxUint256 } from "ethers";
import {
    AAVE_V3_DATA_PROVIDER_ADDRESS,
    AAVE_V3_POOL_ADDRESS,
    cbETH_ADDRESS,
    DEFAULT_SUPPLY_AMOUNT,
    TEST_ADDRESS,
} from "../constants.js";
import aaveProtocolDataProviderAbi from "../../externalAbi/aaveV3/aaveProtocolDataProvider.json" with { type: "json" };
import ERC20Json from "@openzeppelin/contracts/build/contracts/ERC20.json" with { type: "json" };
const ERC20_ABI = ERC20Json.abi;
import { approve, defaultProvider, formatAmount } from "../utils.js";
import aaveDebtTokenJson from "../../externalAbi/aaveV3/aaveDebtToken.json" with { type: "json" };
import aaveV3PoolJson from "../../externalAbi/aaveV3/aaveV3Pool.json" with { type: "json" };
import * as SafeTypes from "@safe-global/types-kit";
type MetaTransactionData = SafeTypes.MetaTransactionData;
const OperationType = SafeTypes.OperationType;
import { safeAddress } from "../debtSwapBySafe.js";

export class AaveV3Helper {
    private protocolDataProvider;
    private pool;

    constructor(private signer: HardhatEthersSigner | any) {
        this.protocolDataProvider = new ethersLib.Contract(
            AAVE_V3_DATA_PROVIDER_ADDRESS,
            aaveProtocolDataProviderAbi,
            signer,
        );
        this.pool = new ethersLib.Contract(AAVE_V3_POOL_ADDRESS, aaveV3PoolJson, signer);
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
        const aaveDebtToken = new ethersLib.Contract(debtTokenAddress, aaveDebtTokenJson, this.signer);
        const approveDelegationTx = await aaveDebtToken.approveDelegation(deployedContractAddress, MaxUint256);
        await approveDelegationTx.wait();
        console.log("approveDelegation:", debtTokenAddress);
    }

    async supply(tokenAddress: string) {
        const tokenContract = new ethersLib.Contract(tokenAddress, ERC20_ABI, this.signer);

        await approve(tokenAddress, AAVE_V3_POOL_ADDRESS, this.signer);
        const amount = ethersLib.parseEther(DEFAULT_SUPPLY_AMOUNT);

        const supplyTx = await this.pool.supply(tokenAddress, amount, TEST_ADDRESS, 0);
        await supplyTx.wait();

        const walletBalance = await tokenContract.balanceOf(TEST_ADDRESS);
        console.log(`${tokenAddress} Wallet Balance:`, ethersLib.formatEther(walletBalance));
    }

    async borrow(tokenAddress: string, borrowAmount?: bigint) {
        const tokenContract = new ethersLib.Contract(tokenAddress, ERC20_ABI, this.signer);
        const decimals = await tokenContract.decimals();
        const decimalsNumber = typeof decimals === "bigint" ? Number(decimals) : decimals;
        const amount = borrowAmount || ethersLib.parseUnits("1", decimalsNumber);

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
        const aavePool = new ethersLib.Contract(AAVE_V3_POOL_ADDRESS, aaveV3PoolJson, defaultProvider);

        const collateralContract = new ethersLib.Contract(collateralTokenAddress, ERC20_ABI, defaultProvider);
        let borrowAmount: bigint;
        if (customBorrowAmount) {
            borrowAmount = customBorrowAmount;
        } else {
            const debtTokenContract = new ethersLib.Contract(debtTokenAddress, ERC20_ABI, defaultProvider);
            const debtTokenDecimals = await debtTokenContract.decimals();
            const debtTokenDecimalsNumber =
                typeof debtTokenDecimals === "bigint" ? Number(debtTokenDecimals) : debtTokenDecimals;
            borrowAmount = ethersLib.parseUnits("1", debtTokenDecimalsNumber);
        }
        const approveTransactionData: MetaTransactionData = {
            to: collateralTokenAddress,
            value: "0",
            data: collateralContract.interface.encodeFunctionData("approve", [
                AAVE_V3_POOL_ADDRESS,
                ethersLib.parseEther("1"),
            ]),
            operation: OperationType.Call,
        };

        const supplyTransactionData: MetaTransactionData = {
            to: AAVE_V3_POOL_ADDRESS,
            value: "0",
            data: aavePool.interface.encodeFunctionData("supply", [
                collateralTokenAddress,
                ethersLib.parseEther(DEFAULT_SUPPLY_AMOUNT),
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
