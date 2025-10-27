import { time, loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
const { expect } = require("chai");
import { ethers } from "hardhat";
import "dotenv/config";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { LeveragedPosition } from "../typechain-types";
import { abi as ERC20_ABI } from "@openzeppelin/contracts/build/contracts/ERC20.json";
import { approve, getDecimals, getParaswapData, protocolHelperMap } from "./utils";
import Safe, { Eip1193Provider, RequestArguments } from "@safe-global/protocol-kit";
import {
    USDC_ADDRESS,
    USDbC_ADDRESS,
    cbETH_ADDRESS,
    TEST_ADDRESS,
    Protocols,
    WETH_ADDRESS,
    DEFAULT_SUPPLY_AMOUNT,
    cbETH_ETH_POOL,
    cbBTC_ADDRESS,
    cbBTC_USDC_POOL,
    USDC_hyUSD_POOL,
    ETH_USDC_POOL,
    ETH_USDbC_POOL,
} from "./constants";
import { MaxUint256 } from "ethers";
import { deployLeveragedPositionContractFixture } from "./deployUtils";
import { mcbETH, mContractAddressMap, MoonwellHelper } from "./protocols/moonwell";
import { eip1193Provider, safeAddress } from "./debtSwapBySafe";
import { MetaTransactionData, OperationType } from "@safe-global/types-kit";
import {
    FLUID_cbBTC_sUSDS_VAULT,
    FLUID_cbBTC_USDC_VAULT,
    FLUID_cbETH_USDC_VAULT,
    fluidVaultMap,
} from "./protocols/fluid";

describe("Create leveraged position by Safe", function () {
    this.timeout(3000000); // 50 minutes

    let myContract: LeveragedPosition;
    let impersonatedSigner: HardhatEthersSigner;

    let deployedContractAddress: string;

    const defaultTargetSupplyAmount = "0.002";
    const cbBTCPrincipleAmount = 0.00006;

    let safeWallet;

    this.beforeEach(async () => {
        impersonatedSigner = await ethers.getImpersonatedSigner(TEST_ADDRESS);

        const leveragedPosition = await loadFixture(deployLeveragedPositionContractFixture);
        deployedContractAddress = await leveragedPosition.getAddress();

        myContract = await ethers.getContractAt("LeveragedPosition", deployedContractAddress, impersonatedSigner);

        safeWallet = await Safe.init({
            provider: eip1193Provider,
            signer: process.env.PRIVATE_KEY,
            safeAddress: safeAddress,
        });
    });

    async function enableSafeModule() {
        const enableModuleTx = await safeWallet.createEnableModuleTx(
            deployedContractAddress,
            // options // Optional
        );
        const safeTxHash = await safeWallet.executeTransaction(enableModuleTx);
        console.log("Safe enable module transaction");
        console.log("Modules:", await safeWallet.getModules());
    }

    async function createLeveragedPosition(
        flashloanPool: string,
        protocol: Protocols,
        collateralAddress = cbETH_ADDRESS,
        debtAddress = USDC_ADDRESS,
        principleAmount = Number(DEFAULT_SUPPLY_AMOUNT),
        targetAmount = Number(defaultTargetSupplyAmount),
    ) {
        await enableSafeModule();

        const Helper = protocolHelperMap.get(protocol)!;
        const protocolHelper = new Helper(impersonatedSigner);

        const collateralContract = new ethers.Contract(collateralAddress, ERC20_ABI, impersonatedSigner);

        const collateralDecimals = await getDecimals(collateralAddress);
        const debtDecimals = await getDecimals(debtAddress);

        let extraData = "0x";

        switch (protocol) {
            case Protocols.FLUID:
                const vaultAddress = fluidVaultMap.get(collateralAddress)!;
                extraData = ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [vaultAddress, 0]);
                break;
        }

        const parsedTargetAmount = ethers.parseUnits(targetAmount.toString(), collateralDecimals);

        const diffAmount = parsedTargetAmount - ethers.parseUnits(principleAmount.toString(), collateralDecimals);

        const paraswapData = await getParaswapData(collateralAddress, debtAddress, deployedContractAddress, diffAmount);

        // send collateral token to safe
        const tx = await collateralContract.transfer(
            safeAddress,
            ethers.parseUnits(principleAmount.toString(), collateralDecimals),
        );
        await tx.wait();

        const approveTransactionData: MetaTransactionData = {
            to: collateralAddress,
            value: "0",
            data: collateralContract.interface.encodeFunctionData("approve", [
                deployedContractAddress,
                MaxUint256, // Use maximum approval to avoid repeated approvals
            ]),
            operation: OperationType.Call,
        };

        const createTransactionData: MetaTransactionData = {
            to: deployedContractAddress,
            value: "0",
            data: myContract.interface.encodeFunctionData("createLeveragedPosition", [
                flashloanPool,
                protocol,
                collateralAddress,
                ethers.parseUnits(principleAmount.toString(), collateralDecimals),
                parsedTargetAmount,
                debtAddress,
                extraData,
                paraswapData,
            ]),
            operation: OperationType.Call,
        };

        let safeTransaction;
        try {
            safeTransaction = await safeWallet.createTransaction({
                transactions: [approveTransactionData, createTransactionData],
            });
        } catch (error) {
            console.error("Error creating transaction:", error);
            throw error;
        }

        const safeTxHash = await safeWallet.executeTransaction(safeTransaction, {
            gasLimit: "10000000", // Total gas limit for the execution transaction
        });
        console.log(safeTxHash);

        const addressForDebtAmount = protocol === Protocols.FLUID ? fluidVaultMap.get(collateralAddress)! : debtAddress;

        const debtAmount = await protocolHelper.getDebtAmount(addressForDebtAmount, safeAddress);

        const collateralAmount = await protocolHelper.getCollateralAmount(collateralAddress, safeAddress);

        expect(debtAmount).to.be.gt(0);
        expect(Number(collateralAmount)).to.be.gt(0);

        const collateralToken = new ethers.Contract(collateralAddress, ERC20_ABI, impersonatedSigner);
        const collateralRemainingBalance = await collateralToken.balanceOf(deployedContractAddress);
        expect(Number(collateralRemainingBalance)).to.be.equal(0);

        const debtToken = new ethers.Contract(debtAddress, ERC20_ABI, impersonatedSigner);
        const debtRemainingBalance = await debtToken.balanceOf(deployedContractAddress);
        expect(Number(debtRemainingBalance)).to.be.equal(0);
    }

    describe("on Moonwell", function () {
        it("with cbETH collateral", async function () {
            await createLeveragedPosition(cbETH_ETH_POOL, Protocols.MOONWELL);
        });

        it("with cbBTC collateral", async function () {
            const cbBTCPrincipleAmount = 0.00006;
            const targetAmount = cbBTCPrincipleAmount * 2;
            await createLeveragedPosition(
                cbBTC_USDC_POOL,
                Protocols.MOONWELL,
                cbBTC_ADDRESS,
                USDC_ADDRESS,
                cbBTCPrincipleAmount,
                targetAmount,
            );
        });

        it("with USDC collateral, cbETH debt", async function () {
            const principleAmount = 0.1;
            const targetAmount = principleAmount * 2;

            await createLeveragedPosition(
                cbBTC_USDC_POOL,
                Protocols.MOONWELL,
                USDC_ADDRESS,
                cbETH_ADDRESS,
                principleAmount,
                targetAmount,
            );
        });

        it("with WETH collateral", async function () {
            await createLeveragedPosition(cbETH_ETH_POOL, Protocols.MOONWELL, WETH_ADDRESS, USDC_ADDRESS);
        });

    });
    describe("on Fluid", function () {
        it("with cbETH collateral", async function () {
            await createLeveragedPosition(cbETH_ETH_POOL, Protocols.FLUID);
        });

        it("with cbBTC collateral", async function () {
            const cbBTCPrincipleAmount = 0.00006;
            const targetAmount = cbBTCPrincipleAmount * 2;
            await createLeveragedPosition(
                cbBTC_USDC_POOL,
                Protocols.FLUID,
                cbBTC_ADDRESS,
                USDC_ADDRESS,
                cbBTCPrincipleAmount,
                targetAmount,
            );
        });

        it("with WETH collateral", async function () {
            await createLeveragedPosition(ETH_USDbC_POOL, Protocols.FLUID, WETH_ADDRESS, USDC_ADDRESS);
        });
    });
});
