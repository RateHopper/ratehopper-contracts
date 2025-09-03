import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { Contract, MaxUint256 } from "ethers";
import {
    AERO_ADDRESS,
    cbBTC_ADDRESS,
    cbETH_ADDRESS,
    DAI_ADDRESS,
    DEFAULT_SUPPLY_AMOUNT,
    EURC_ADDRESS,
    LBTC_ADDRESS,
    rETH_ADDRESS,
    tBTC_ADDRESS,
    TEST_ADDRESS,
    USDC_ADDRESS,
    USDS_ADDRESS,
    VIRTUAL_ADDRESS,
    weETH_ADDRESS,
    WELL_ADDRESS,
    WETH_ADDRESS,
    wrsETH_ADDRESS,
    wstETH_ADDRESS,
} from "../constants";

import { abi as ERC20_ABI } from "@openzeppelin/contracts/build/contracts/ERC20.json";
import { approve, defaultProvider, formatAmount, getDecimals } from "../utils";
import { MetaTransactionData, OperationType } from "@safe-global/types-kit";

const MErc20DelegatorAbi = require("../../externalAbi/moonwell/MErc20Delegator.json");
const ComptrollerAbi = require("../../externalAbi/moonwell/comptroller.json");
const ViewAbi = require("../../externalAbi/moonwell/moonwellViewsV3.json");
export const COMPTROLLER_ADDRESS = "0xfbb21d0380bee3312b33c4353c8936a0f13ef26c";
const view_address = "0x821ff3a967b39bcbe8a018a9b1563eaf878bad39";

// https://docs.moonwell.fi/moonwell/protocol-information/contracts#token-contract-addresses
export const mDAI = "0x73b06d8d18de422e269645eace15400de7462417";
export const mUSDC = "0xedc817a28e8b93b03976fbd4a3ddbc9f7d176c22";
export const mUSDbC = "0x703843C3379b52F9FF486c9f5892218d2a065cC8";
export const mWETH = "0x628ff693426583D9a7FB391E54366292F509D457";
export const mcbETH = "0x3bf93770f2d4a794c3d9ebefbaebae2a8f09a5e5";
export const mwstETH = "0x627Fe393Bc6EdDA28e99AE648fD6fF362514304b";
export const mrETH = "0xcb1dacd30638ae38f2b94ea64f066045b7d45f44";
export const mWeETH = "0xb8051464C8c92209C92F3a4CD9C73746C4c3CFb3";
export const mAERO = "0x73902f619CEB9B31FD8EFecf435CbDf89E369Ba6";
export const mcbBTC = "0xf877acafa28c19b96727966690b2f44d35ad5976";
export const mEURC = "0xb682c840B5F4FC58B20769E691A6fa1305A501a2";
export const mwrsETH = "0xfC41B49d064Ac646015b459C522820DB9472F4B5";
export const mWELL = "0xdC7810B47eAAb250De623F0eE07764afa5F71ED1";
export const mUSDS = "0xb6419c6C2e60c4025D6D06eE4F913ce89425a357";
export const mtBTC = "0x9A858ebfF1bEb0D3495BB0e2897c1528eD84A218";
export const mLBTC = "0x10fF57877b79e9bd949B3815220eC87B9fc5D2ee";
export const mVIRTUAL = "0xdE8Df9d942D78edE3Ca06e60712582F79CFfFC64";

export const mContractAddressMap = new Map<string, string>([
    [USDC_ADDRESS, mUSDC],
    [DAI_ADDRESS, mDAI],
    [cbETH_ADDRESS, mcbETH],
    [cbBTC_ADDRESS, mcbBTC],
    [wstETH_ADDRESS, mwstETH],
    [rETH_ADDRESS, mrETH],
    [weETH_ADDRESS, mWeETH],
    [AERO_ADDRESS, mAERO],
    [EURC_ADDRESS, mEURC],
    [wrsETH_ADDRESS, mwrsETH],
    [WELL_ADDRESS, mWELL],
    [USDS_ADDRESS, mUSDS],
    [tBTC_ADDRESS, mtBTC],
    [LBTC_ADDRESS, mLBTC],
    [VIRTUAL_ADDRESS, mVIRTUAL],
    [WETH_ADDRESS, mWETH],
]);

export class MoonwellHelper {
    constructor(private signer: HardhatEthersSigner | any) {}

    async getCollateralAmount(tokenAddress: string, userAddress?: string): Promise<bigint> {
        const mContractAddress = mContractAddressMap.get(tokenAddress)!;
        const viewContract = new ethers.Contract(view_address, ViewAbi, this.signer);
        // TODO: something is wrong when collateral is WETH, can't fetch collateral amount correctly
        const collaterals = await viewContract.getUserBalances(userAddress || TEST_ADDRESS);
        console.log("mContractAddress:", mContractAddress);

        const collateralEntry = collaterals.find((collateral) => collateral[1].toLowerCase() === mContractAddress);

        const mToken = new ethers.Contract(mContractAddress, MErc20DelegatorAbi, this.signer);
        const exchangeRate = await mToken.exchangeRateStored();
        const decimals = await getDecimals(tokenAddress);
        const rate = ethers.formatUnits(exchangeRate, decimals);

        const collateralAmount = collateralEntry ? collateralEntry[0] * BigInt(Number(rate).toFixed()) : 0;

        console.log("collateralAmount:", ethers.formatUnits(collateralAmount, decimals));
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

    async getSupplyAndBorrowTxdata(
        debtTokenAddress = USDC_ADDRESS,
        collateralTokenAddress = cbETH_ADDRESS,
    ): Promise<MetaTransactionData[]> {
        const mContractAddress = mContractAddressMap.get(collateralTokenAddress)!;
        const mToken = new ethers.Contract(mContractAddress, MErc20DelegatorAbi, defaultProvider);

        const collateralContract = new ethers.Contract(collateralTokenAddress, ERC20_ABI, defaultProvider);
        const approveTransactionData: MetaTransactionData = {
            to: collateralTokenAddress,
            value: "0",
            data: collateralContract.interface.encodeFunctionData("approve", [
                mContractAddress,
                ethers.parseEther("1"),
            ]),
            operation: OperationType.Call,
        };

        const supplyTransactionData: MetaTransactionData = {
            to: mContractAddress,
            value: "0",
            data: mToken.interface.encodeFunctionData("mint", [ethers.parseEther(DEFAULT_SUPPLY_AMOUNT)]),
            operation: OperationType.Call,
        };

        const comptroller = new ethers.Contract(COMPTROLLER_ADDRESS, ComptrollerAbi, defaultProvider);

        const enableTransactionData: MetaTransactionData = {
            to: COMPTROLLER_ADDRESS,
            value: "0",
            data: comptroller.interface.encodeFunctionData("enterMarkets", [[mContractAddress]]),
            operation: OperationType.Call,
        };

        const decimals = await getDecimals(debtTokenAddress);
        const debtMContractAddress = mContractAddressMap.get(debtTokenAddress)!;

        const borrowTransactionData: MetaTransactionData = {
            to: debtMContractAddress,
            value: "0",
            data: mToken.interface.encodeFunctionData("borrow", [ethers.parseUnits("1", decimals)]),
            operation: OperationType.Call,
        };

        return [approveTransactionData, supplyTransactionData, enableTransactionData, borrowTransactionData];
    }
}
