import * as ethersLib from "ethers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { cbETH_ADDRESS, DEFAULT_SUPPLY_AMOUNT, TEST_ADDRESS } from "../constants.js";
import ERC20Json from "@openzeppelin/contracts/build/contracts/ERC20.json" with { type: "json" };
const ERC20_ABI = ERC20Json.abi;
import { approve, defaultProvider, getDecimals } from "../utils.js";
import * as SafeTypes from "@safe-global/types-kit";
type MetaTransactionData = SafeTypes.MetaTransactionData;
const OperationType = SafeTypes.OperationType;
import { mContractAddressMap, mcbETH, mUSDC, mDAI } from "../../contractAddresses.js";

import MErc20DelegatorAbi from "../../externalAbi/moonwell/MErc20Delegator.json" with { type: "json" };
import ComptrollerAbi from "../../externalAbi/moonwell/comptroller.json" with { type: "json" };
import ViewAbi from "../../externalAbi/moonwell/moonwellViewsV3.json" with { type: "json" };

export const COMPTROLLER_ADDRESS = "0xfbb21d0380bee3312b33c4353c8936a0f13ef26c";
const view_address = "0x821ff3a967b39bcbe8a018a9b1563eaf878bad39";

// Re-export for backwards compatibility
export { mContractAddressMap, mcbETH, mUSDC, mDAI };

export class MoonwellHelper {
    constructor(private signer: HardhatEthersSigner | any) {}

    async getCollateralAmount(tokenAddress: string, userAddress?: string): Promise<bigint> {
        const mContractAddress = mContractAddressMap.get(tokenAddress)!;
        const viewContract = new ethersLib.Contract(view_address, ViewAbi, this.signer);
        const collaterals = await viewContract.getUserBalances(userAddress || TEST_ADDRESS);
        console.log("mContractAddress:", mContractAddress);

        const collateralEntry = collaterals.find(
            (collateral) => collateral[1].toLowerCase() === mContractAddress.toLowerCase(),
        );

        const mToken = new ethersLib.Contract(mContractAddress, MErc20DelegatorAbi, this.signer);
        const exchangeRate = await mToken.exchangeRateStored();
        const decimals = await getDecimals(tokenAddress);
        const rate = ethersLib.formatUnits(exchangeRate, decimals);

        const collateralAmount = collateralEntry ? collateralEntry[0] * BigInt(Number(rate).toFixed()) : 0;

        console.log("collateralAmount:", ethersLib.formatUnits(collateralAmount, decimals));
        return BigInt(collateralAmount);
    }

    async getDebtAmount(tokenAddress: string, userAddress?: string): Promise<bigint> {
        const mContractAddress = mContractAddressMap.get(tokenAddress);

        if (!mContractAddress) {
            throw new Error(
                `Moonwell mToken address not found for token: ${tokenAddress}. Available tokens: ${Array.from(mContractAddressMap.keys()).join(", ")}`,
            );
        }

        const mToken = new ethersLib.Contract(mContractAddress, MErc20DelegatorAbi, this.signer);
        const debtAmount = await mToken.borrowBalanceStored(userAddress || TEST_ADDRESS);

        console.log("moonwell debtAmount:", debtAmount);
        return BigInt(debtAmount);
    }

    async supply(mContractAddress: string) {
        const amount = ethersLib.parseUnits(DEFAULT_SUPPLY_AMOUNT.toString(), 18);
        const mToken = new ethersLib.Contract(mContractAddress, MErc20DelegatorAbi, this.signer);

        const tx = await mToken.mint(amount);
        await tx.wait();
        console.log("supply on moonwell:", amount);
    }

    async enableCollateral(mContractAddress: string) {
        const comptroller = new ethersLib.Contract(COMPTROLLER_ADDRESS, ComptrollerAbi, this.signer);
        const tx = await comptroller.enterMarkets([mContractAddress]);
        await tx.wait();
        console.log("enabled collateral on moonwell:", mContractAddress);
    }

    async borrow(mContractAddress: string) {
        const amount = ethersLib.parseUnits("1", 6);
        const mToken = new ethersLib.Contract(mContractAddress, MErc20DelegatorAbi, this.signer);
        const tx = await mToken.borrow(amount);
        await tx.wait();
        console.log("borrow on moonwell:", amount);
    }

    async repay(mContractAddress: string, amount: string) {
        const repayAmount = ethersLib.parseUnits(amount, 6);
        const mToken = new ethersLib.Contract(mContractAddress, MErc20DelegatorAbi, this.signer);
        const tx = await mToken.repayBorrow(repayAmount);
        await tx.wait();
        console.log("repaid debt on moonwell:", repayAmount);
    }

    async withdrawCollateral(mContractAddress: string, amount: string) {
        const withdrawAmount = ethersLib.parseUnits(amount, 18);
        const mToken = new ethersLib.Contract(mContractAddress, MErc20DelegatorAbi, this.signer);
        const tx = await mToken.redeemUnderlying(withdrawAmount);
        await tx.wait();
        console.log("withdrawn collateral from moonwell:", withdrawAmount);
    }

    async getSupplyAndBorrowTxdata(
        debtTokenAddress: string,
        collateralAddress = cbETH_ADDRESS,
        customBorrowAmount?: bigint,
    ): Promise<MetaTransactionData[]> {
        const collateralMTokenAddress = mContractAddressMap.get(collateralAddress)!;
        const collateralMToken = new ethersLib.Contract(collateralMTokenAddress, MErc20DelegatorAbi, defaultProvider);

        const collateralContract = new ethersLib.Contract(collateralAddress, ERC20_ABI, defaultProvider);
        const approveTransactionData: MetaTransactionData = {
            to: collateralAddress,
            value: "0",
            data: collateralContract.interface.encodeFunctionData("approve", [
                collateralMTokenAddress,
                ethersLib.parseEther("1"),
            ]),
            operation: OperationType.Call,
        };

        const supplyTransactionData: MetaTransactionData = {
            to: collateralMTokenAddress,
            value: "0",
            data: collateralMToken.interface.encodeFunctionData("mint", [ethersLib.parseEther(DEFAULT_SUPPLY_AMOUNT)]),
            operation: OperationType.Call,
        };

        const comptroller = new ethersLib.Contract(COMPTROLLER_ADDRESS, ComptrollerAbi, defaultProvider);

        const enableTransactionData: MetaTransactionData = {
            to: COMPTROLLER_ADDRESS,
            value: "0",
            data: comptroller.interface.encodeFunctionData("enterMarkets", [[collateralMTokenAddress]]),
            operation: OperationType.Call,
        };

        const mContractAddress = mContractAddressMap.get(debtTokenAddress)!;

        const mToken = new ethersLib.Contract(mContractAddress, MErc20DelegatorAbi, defaultProvider);

        const decimals = await getDecimals(debtTokenAddress);

        const borrowTransactionData: MetaTransactionData = {
            to: mContractAddress,
            value: "0",
            data: mToken.interface.encodeFunctionData("borrow", [ethersLib.parseUnits("1", decimals)]),
            operation: OperationType.Call,
        };

        return [approveTransactionData, supplyTransactionData, enableTransactionData, borrowTransactionData];
    }
}
