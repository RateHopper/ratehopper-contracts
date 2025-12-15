import * as ethersLib from "ethers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { Contract, MaxUint256 } from "ethers";
import cometAbi from "../../externalAbi/compound/comet.json" with { type: "json" };
import { approve, defaultProvider, formatAmount } from "../utils.js";
import {
    AERO_ADDRESS,
    cbBTC_ADDRESS,
    cbETH_ADDRESS,
    DEFAULT_SUPPLY_AMOUNT,
    TEST_ADDRESS,
    USDbC_ADDRESS,
    USDC_ADDRESS,
    USDS_ADDRESS,
    WETH_ADDRESS,
} from "../constants.js";
import ERC20Json from "@openzeppelin/contracts/build/contracts/ERC20.json" with { type: "json" };
const ERC20_ABI = ERC20Json.abi;
import * as SafeTypes from "@safe-global/types-kit";
type MetaTransactionData = SafeTypes.MetaTransactionData;
const OperationType = SafeTypes.OperationType;

export const USDC_COMET_ADDRESS = "0xb125E6687d4313864e53df431d5425969c15Eb2F";
export const USDbC_COMET_ADDRESS = "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf";
export const WETH_COMET_ADDRESS = "0x46e6b214b524310239732D51387075E0e70970bf";
export const AERO_COMET_ADDRESS = "0x784efeB622244d2348d4F2522f8860B96fbEcE89";
export const USDS_COMET_ADDRESS = "0x2c776041CCFe903071AF44aa147368a9c8EEA518";

export const cometAddressMap = new Map<string, string>([
    [USDC_ADDRESS, USDC_COMET_ADDRESS],
    [USDbC_ADDRESS, USDbC_COMET_ADDRESS],
    [WETH_ADDRESS, WETH_COMET_ADDRESS],
    [AERO_ADDRESS, AERO_COMET_ADDRESS],
    [USDS_ADDRESS, USDS_COMET_ADDRESS],
]);

export class CompoundHelper {
    constructor(private signer: HardhatEthersSigner | any) {}

    async getDebtAmount(tokenAddress: string, userAddress?: string): Promise<bigint> {
        const comet = new ethersLib.Contract(cometAddressMap.get(tokenAddress)!, cometAbi, this.signer);
        const debtAmount = await comet.borrowBalanceOf(userAddress || TEST_ADDRESS);
        console.log("compound debtAmount:", debtAmount);
        return debtAmount;
    }

    async getCollateralAmount(
        cometAddress: string,
        collateralTokenAddress: string,
        userAddress?: string,
    ): Promise<bigint> {
        const comet = new ethersLib.Contract(cometAddress, cometAbi, this.signer);
        const response = await comet.userCollateral(userAddress || TEST_ADDRESS, collateralTokenAddress);
        return response.balance;
    }

    async supply(cometAddress: string, collateralTokenAddress: string, amount = DEFAULT_SUPPLY_AMOUNT, decimals = 18) {
        await approve(collateralTokenAddress, cometAddress, this.signer);
        const supplyAmount = ethersLib.parseUnits(amount, decimals);
        const comet = new ethersLib.Contract(cometAddress, cometAbi, this.signer);

        const tx = await comet.supply(collateralTokenAddress, supplyAmount);
        await tx.wait();
        const suppliedAmount = await this.getCollateralAmount(cometAddress, collateralTokenAddress);
        console.log(`Supplied ${ethersLib.formatEther(suppliedAmount)} ${collateralTokenAddress}`);
    }

    async borrow(tokenAddress: string, amount = "1", decimals = 6) {
        const comet = new ethersLib.Contract(cometAddressMap.get(tokenAddress)!, cometAbi, this.signer);

        const borrowAmount = ethersLib.parseUnits(amount, decimals);
        const tx = await comet.withdraw(tokenAddress, borrowAmount);
        await tx.wait();
        const borrowedAmount = await this.getDebtAmount(tokenAddress);
        console.log(`Borrowed ${formatAmount(borrowedAmount)} ${tokenAddress}`);
    }

    async allow(tokenAddress: string, targetAddress: string) {
        const comet = new ethersLib.Contract(cometAddressMap.get(tokenAddress)!, cometAbi, this.signer);
        const tx = await comet.allow(targetAddress, true);
        await tx.wait();
        console.log(`allow ${tokenAddress} to ${targetAddress}`);
    }

    encodeExtraData(cometAddress: string) {
        return ethersLib.AbiCoder.defaultAbiCoder().encode(["address"], [cometAddress]);
    }

    async getSupplyAndBorrowTxdata(
        debtTokenAddress,
        collateralTokenAddress = cbETH_ADDRESS,
        customBorrowAmount?: bigint,
    ): Promise<MetaTransactionData[]> {
        const cbETHContract = new ethersLib.Contract(cbETH_ADDRESS, ERC20_ABI, defaultProvider);
        const approveTransactionData: MetaTransactionData = {
            to: cbETH_ADDRESS,
            value: "0",
            data: cbETHContract.interface.encodeFunctionData("approve", [USDC_COMET_ADDRESS, ethersLib.parseEther("1")]),
            operation: OperationType.Call,
        };

        const cometContract = new ethersLib.Contract(USDC_COMET_ADDRESS, cometAbi, defaultProvider);

        const supplyTransactionData: MetaTransactionData = {
            to: USDC_COMET_ADDRESS,
            value: "0",
            data: cometContract.interface.encodeFunctionData("supply", [
                cbETH_ADDRESS,
                ethersLib.parseEther(DEFAULT_SUPPLY_AMOUNT),
            ]),
            operation: OperationType.Call,
        };

        const borrowTransactionData: MetaTransactionData = {
            to: USDC_COMET_ADDRESS,
            value: "0",
            data: cometContract.interface.encodeFunctionData("withdraw", [USDC_ADDRESS, ethersLib.parseUnits("1", 6)]),
            operation: OperationType.Call,
        };

        return [approveTransactionData, supplyTransactionData, borrowTransactionData];
    }
}
