import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { Contract, MaxUint256 } from "ethers";
import {
    cbBTC_ADDRESS,
    cbETH_ADDRESS,
    DAI_ADDRESS,
    DEFAULT_SUPPLY_AMOUNT,
    TEST_ADDRESS,
    USDC_ADDRESS,
} from "../constants";

import { abi as ERC20_ABI } from "@openzeppelin/contracts/build/contracts/ERC20.json";
import { approve, defaultProvider, formatAmount, getDecimals } from "../utils";
import { MetaTransactionData, OperationType } from "@safe-global/types-kit";

const MErc20DelegatorAbi = require("../../externalAbi/moonwell/MErc20Delegator.json");
const ComptrollerAbi = require("../../externalAbi/moonwell/comptroller.json");
const ViewAbi = require("../../externalAbi/moonwell/moonwellViewsV3.json");
export const COMPTROLLER_ADDRESS = "0xfbb21d0380bee3312b33c4353c8936a0f13ef26c";
const view_address = "0x821ff3a967b39bcbe8a018a9b1563eaf878bad39";

export const mcbETH = "0x3bf93770f2d4a794c3d9ebefbaebae2a8f09a5e5";
export const mUSDC = "0xedc817a28e8b93b03976fbd4a3ddbc9f7d176c22";
export const mDAI = "0x73b06d8d18de422e269645eace15400de7462417";

export const mContractAddressMap = new Map<string, string>([
    [USDC_ADDRESS, mUSDC],
    [DAI_ADDRESS, mDAI],
]);

export class MoonwellHelper {
    constructor(private signer: HardhatEthersSigner | any) {}

    async getCollateralAmount(mContractAddress: string, userAddress?: string): Promise<bigint> {
        const viewContract = new ethers.Contract(view_address, ViewAbi, this.signer);
        const collaterals = await viewContract.getUserBalances(userAddress || TEST_ADDRESS);

        const collateralEntry = collaterals.find((collateral) => collateral[1].toLowerCase() === mContractAddress);

        const mToken = new ethers.Contract(mContractAddress, MErc20DelegatorAbi, this.signer);
        const exchangeRate = await mToken.exchangeRateStored();
        const rate = ethers.formatEther(exchangeRate);

        const collateralAmount = collateralEntry ? collateralEntry[0] * BigInt(Number(rate).toFixed()) : 0;

        console.log("collateralAmount:", ethers.formatUnits(collateralAmount, 18));
        return BigInt(collateralAmount);
    }

    async getDebtAmount(tokenAddress: string, userAddress?: string): Promise<bigint> {
        const mContractAddress = mContractAddressMap.get(tokenAddress)!;
        const mToken = new ethers.Contract(mContractAddress, MErc20DelegatorAbi, this.signer);
        const debtAmount = await mToken.borrowBalanceStored(userAddress || TEST_ADDRESS);

        console.log("moonwell debtAmount:", debtAmount);
        return BigInt(debtAmount);
    }

    async supply(mContractAddress: string) {
        const amount = ethers.parseUnits(DEFAULT_SUPPLY_AMOUNT.toString(), 18);
        const mToken = new ethers.Contract(mContractAddress, MErc20DelegatorAbi, this.signer);

        const tx = await mToken.mint(amount);
        await tx.wait();
        console.log("supply on moonwell:", amount);
    }

    async enableCollateral(mContractAddress: string) {
        const comptroller = new ethers.Contract(COMPTROLLER_ADDRESS, ComptrollerAbi, this.signer);
        const tx = await comptroller.enterMarkets([mContractAddress]);
        await tx.wait();
        console.log("enabled collateral on moonwell:", mContractAddress);
    }

    async borrow(mContractAddress: string) {
        const amount = ethers.parseUnits("1", 6);
        const mToken = new ethers.Contract(mContractAddress, MErc20DelegatorAbi, this.signer);
        const tx = await mToken.borrow(amount);
        await tx.wait();
        console.log("borrow on moonwell:", amount);
    }

    async repay(mContractAddress: string, amount: string) {
        const repayAmount = ethers.parseUnits(amount, 6);
        const mToken = new ethers.Contract(mContractAddress, MErc20DelegatorAbi, this.signer);
        const tx = await mToken.repayBorrow(repayAmount);
        await tx.wait();
        console.log("repaid debt on moonwell:", repayAmount);
    }

    async withdrawCollateral(mContractAddress: string, amount: string) {
        const withdrawAmount = ethers.parseUnits(amount, 18);
        const mToken = new ethers.Contract(mContractAddress, MErc20DelegatorAbi, this.signer);
        const tx = await mToken.redeemUnderlying(withdrawAmount);
        // const tx = await mToken.redeem();
        await tx.wait();
        console.log("withdrawn collateral from moonwell:", withdrawAmount);
    }

    async getSupplyAndBorrowTxdata(debtTokenAddress): Promise<MetaTransactionData[]> {
        const cbETHmToken = new ethers.Contract(mcbETH, MErc20DelegatorAbi, defaultProvider);

        const cbETHContract = new ethers.Contract(cbETH_ADDRESS, ERC20_ABI, defaultProvider);
        const approveTransactionData: MetaTransactionData = {
            to: cbETH_ADDRESS,
            value: "0",
            data: cbETHContract.interface.encodeFunctionData("approve", [mcbETH, ethers.parseEther("1")]),
            operation: OperationType.Call,
        };

        const supplyTransactionData: MetaTransactionData = {
            to: mcbETH,
            value: "0",
            data: cbETHmToken.interface.encodeFunctionData("mint", [ethers.parseEther(DEFAULT_SUPPLY_AMOUNT)]),
            operation: OperationType.Call,
        };

        const comptroller = new ethers.Contract(COMPTROLLER_ADDRESS, ComptrollerAbi, defaultProvider);

        const enableTransactionData: MetaTransactionData = {
            to: COMPTROLLER_ADDRESS,
            value: "0",
            data: comptroller.interface.encodeFunctionData("enterMarkets", [[mcbETH]]),
            operation: OperationType.Call,
        };

        const mContractAddress = mContractAddressMap.get(debtTokenAddress)!;

        const mToken = new ethers.Contract(mContractAddress, MErc20DelegatorAbi, defaultProvider);

        const decimals = await getDecimals(debtTokenAddress);

        const borrowTransactionData: MetaTransactionData = {
            to: mContractAddress,
            value: "0",
            data: mToken.interface.encodeFunctionData("borrow", [ethers.parseUnits("1", decimals)]),
            operation: OperationType.Call,
        };

        return [approveTransactionData, supplyTransactionData, enableTransactionData, borrowTransactionData];
    }
}
