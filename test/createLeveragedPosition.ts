import { time, loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
const { expect } = require("chai");
import { ethers } from "hardhat";

import "dotenv/config";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { LeveragedPosition } from "../typechain-types";
import morphoAbi from "../externalAbi/morpho/morpho.json";
import { abi as ERC20_ABI } from "@openzeppelin/contracts/build/contracts/ERC20.json";
import { approve, getDecimals, getParaswapData, protocolHelperMap } from "./utils";

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
} from "./constants";

import { AaveV3Helper } from "./protocols/aaveV3";
import { cometAddressMap, CompoundHelper } from "./protocols/compound";
import {
    MORPHO_ADDRESS,
    MorphoHelper,
    morphoMarket1Id,
    morphoMarket4Id,
    morphoMarket5Id,
    morphoMarket6Id,
} from "./protocols/morpho";
import { deployLeveragedPositionContractFixture } from "./deployUtils";

describe("Create leveraged position", function () {
    let myContract: LeveragedPosition;
    let impersonatedSigner: HardhatEthersSigner;

    let deployedContractAddress: string;
    let aaveV3Helper: AaveV3Helper;
    let compoundHelper: CompoundHelper;
    let morphoHelper: MorphoHelper;

    const defaultTargetSupplyAmount = "0.002";
    const cbBTCPrincipleAmount = 0.00006;

    this.beforeEach(async () => {
        impersonatedSigner = await ethers.getImpersonatedSigner(TEST_ADDRESS);
        aaveV3Helper = new AaveV3Helper(impersonatedSigner);
        compoundHelper = new CompoundHelper(impersonatedSigner);
        morphoHelper = new MorphoHelper(impersonatedSigner);

        const leveragedPosition = await loadFixture(deployLeveragedPositionContractFixture);
        deployedContractAddress = await leveragedPosition.getAddress();

        myContract = await ethers.getContractAt("LeveragedPosition", deployedContractAddress, impersonatedSigner);
    });

    async function createLeveragedPosition(
        flashloanPool: string,
        protocol: Protocols,
        collateralAddress = cbETH_ADDRESS,
        debtTokenAddress = USDC_ADDRESS,
        principleAmount = Number(DEFAULT_SUPPLY_AMOUNT),
        targetAmount = Number(defaultTargetSupplyAmount),
        morphoMarketId?: string,
    ) {
        const Helper = protocolHelperMap.get(protocol)!;
        const protocolHelper = new Helper(impersonatedSigner);

        await approve(collateralAddress, deployedContractAddress, impersonatedSigner);

        const debtAsset = debtTokenAddress || USDC_ADDRESS;

        const collateralDecimals = await getDecimals(collateralAddress);
        const debtDecimals = await getDecimals(debtAsset);

        switch (protocol) {
            case Protocols.AAVE_V3:
                await aaveV3Helper.approveDelegation(debtAsset, deployedContractAddress);
                break;
            case Protocols.COMPOUND:
                await compoundHelper.allow(debtAsset, deployedContractAddress);
                break;
            case Protocols.MORPHO:
                const morphoContract = new ethers.Contract(MORPHO_ADDRESS, morphoAbi, impersonatedSigner);
                await morphoContract.setAuthorization(deployedContractAddress, true);
                break;
        }

        let extraData = "0x";

        switch (protocol) {
            case Protocols.COMPOUND:
                extraData = compoundHelper.encodeExtraData(cometAddressMap.get(debtAsset)!);
                break;
            case Protocols.MORPHO:
                extraData = morphoHelper.encodeExtraData(morphoMarketId!, BigInt(0));
                break;
        }

        const parsedTargetAmount = ethers.parseUnits(targetAmount.toString(), collateralDecimals);

        const diffAmount = parsedTargetAmount - ethers.parseUnits(principleAmount.toString(), collateralDecimals);

        const paraswapData = await getParaswapData(collateralAddress, debtAsset, deployedContractAddress, diffAmount);

        await myContract.createLeveragedPosition(
            flashloanPool,
            protocol,
            collateralAddress,
            ethers.parseUnits(principleAmount.toString(), collateralDecimals),
            parsedTargetAmount,
            debtAsset,
            extraData,
            paraswapData,
        );

        const debtAmountParameter = protocol === Protocols.MORPHO ? morphoMarketId! : debtAsset;
        const debtAmount = await protocolHelper.getDebtAmount(debtAmountParameter);
        console.log("debtAmount: ", ethers.formatUnits(debtAmount, debtDecimals));

        let collateralAmount: bigint;
        switch (protocol) {
            case Protocols.AAVE_V3:
                collateralAmount = await aaveV3Helper.getCollateralAmount(collateralAddress);
                break;
            case Protocols.COMPOUND:
                collateralAmount = await compoundHelper.getCollateralAmount(
                    cometAddressMap.get(debtAsset)!,
                    collateralAddress,
                );
                break;
            case Protocols.MORPHO:
                collateralAmount = await morphoHelper.getCollateralAmount(morphoMarketId!);
                break;
            default:
                throw new Error("Unsupported protocol");
        }
        console.log("collateralAmount: ", ethers.formatUnits(collateralAmount, collateralDecimals));

        expect(debtAmount).to.be.gt(0);

        // Allow for small rounding differences (up to 0.01% of target amount)
        const tolerance = parsedTargetAmount / 10000n; // 0.01% tolerance
        expect(collateralAmount).to.be.closeTo(parsedTargetAmount, tolerance);

        const collateralToken = new ethers.Contract(collateralAddress, ERC20_ABI, impersonatedSigner);
        const collateralRemainingBalance = await collateralToken.balanceOf(deployedContractAddress);
        expect(Number(collateralRemainingBalance)).to.be.equal(0);

        const debtToken = new ethers.Contract(debtAsset, ERC20_ABI, impersonatedSigner);
        const debtRemainingBalance = await debtToken.balanceOf(deployedContractAddress);
        expect(Number(debtRemainingBalance)).to.be.equal(0);
    }

    describe("on Aave", function () {
        it("with cbETH collateral", async function () {
            await createLeveragedPosition(cbETH_ETH_POOL, Protocols.AAVE_V3);
        });

        it("with cbETH collateral and USDbC debt", async function () {
            await createLeveragedPosition(cbETH_ETH_POOL, Protocols.AAVE_V3, cbETH_ADDRESS, USDbC_ADDRESS);
        });

        it("with cbBTC collateral", async function () {
            const targetAmount = cbBTCPrincipleAmount * 2;

            await createLeveragedPosition(
                cbBTC_USDC_POOL,
                Protocols.AAVE_V3,
                cbBTC_ADDRESS,
                USDC_ADDRESS,
                cbBTCPrincipleAmount,
                targetAmount,
            );
        });

        it("with cbBTC collateral more leverage", async function () {
            const targetAmount = 0.00015;

            await createLeveragedPosition(
                cbBTC_USDC_POOL,
                Protocols.AAVE_V3,
                cbBTC_ADDRESS,
                USDC_ADDRESS,
                cbBTCPrincipleAmount,
                targetAmount,
            );
        });
    });

    describe("on Compoud", function () {
        it("with cbETH collateral", async function () {
            await createLeveragedPosition(cbETH_ETH_POOL, Protocols.COMPOUND);
        });

        // USDbC is no longer available in Compound
        it.skip("with cbETH collateral and USDbC debt", async function () {
            await createLeveragedPosition(cbETH_ETH_POOL, Protocols.COMPOUND, cbETH_ADDRESS, USDbC_ADDRESS);
        });

        it("with cbBTC collateral", async function () {
            const targetAmount = cbBTCPrincipleAmount * 2;
            await createLeveragedPosition(
                cbBTC_USDC_POOL,
                Protocols.COMPOUND,
                cbBTC_ADDRESS,
                USDC_ADDRESS,
                cbBTCPrincipleAmount,
                targetAmount,
            );
        });
    });

    describe("on Morpho", function () {
        it("with cbETH collateral", async function () {
            await createLeveragedPosition(
                cbETH_ETH_POOL,
                Protocols.MORPHO,
                undefined,
                undefined,
                undefined,
                undefined,
                morphoMarket1Id,
            );
        });

        it("with cbETH collateral and protocol fee", async function () {
            // Set protocol fee
            const signers = await ethers.getSigners();
            const contractByOwner = await ethers.getContractAt(
                "LeveragedPosition",
                deployedContractAddress,
                signers[0],
            );
            await contractByOwner.setProtocolFee(50); // 0.5%
            await contractByOwner.setFeeBeneficiary(TEST_ADDRESS);

            // Get USDC contract for balance checks
            const usdcContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, impersonatedSigner);

            // Record fee beneficiary's USDC balance before
            const beneficiaryUsdcBalanceBefore = await usdcContract.balanceOf(TEST_ADDRESS);

            await createLeveragedPosition(
                cbETH_ETH_POOL,
                Protocols.MORPHO,
                undefined,
                undefined,
                undefined,
                undefined,
                morphoMarket1Id,
            );

            // Check fee beneficiary's USDC balance after
            const beneficiaryUsdcBalanceAfter = await usdcContract.balanceOf(TEST_ADDRESS);

            const feeReceived = beneficiaryUsdcBalanceAfter - beneficiaryUsdcBalanceBefore;

            console.log("Protocol fee received (USDC):", ethers.formatUnits(feeReceived, 6));

            // The fee should be greater than 0
            expect(feeReceived).to.be.gt(0);
        });

        it("with cbBTC collateral", async function () {
            const targetAmount = cbBTCPrincipleAmount * 2;
            await createLeveragedPosition(
                cbBTC_USDC_POOL,
                Protocols.MORPHO,
                cbBTC_ADDRESS,
                USDC_ADDRESS,
                cbBTCPrincipleAmount,
                targetAmount,
                morphoMarket4Id,
            );
        });

        it("with USDC collateral and WETH debt", async function () {
            await createLeveragedPosition(
                USDC_hyUSD_POOL,
                Protocols.MORPHO,
                USDC_ADDRESS,
                WETH_ADDRESS,
                1,
                2,
                morphoMarket6Id,
            );
        });

        it("with USDC collateral and WETH debt with protocol fee - tests different decimals", async function () {
            // Set protocol fee to 1%
            const signers = await ethers.getSigners();
            const contractByOwner = await ethers.getContractAt(
                "LeveragedPosition",
                deployedContractAddress,
                signers[0],
            );
            await contractByOwner.setProtocolFee(100); // 1%
            await contractByOwner.setFeeBeneficiary(TEST_ADDRESS);

            // Get WETH contract for balance checks
            const wethContract = new ethers.Contract(WETH_ADDRESS, ERC20_ABI, impersonatedSigner);

            // Record fee beneficiary's WETH balance before
            const beneficiaryWethBalanceBefore = await wethContract.balanceOf(TEST_ADDRESS);

            // Create leveraged position with USDC collateral (6 decimals) and WETH debt (18 decimals)
            await createLeveragedPosition(
                USDC_hyUSD_POOL,
                Protocols.MORPHO,
                USDC_ADDRESS,
                WETH_ADDRESS,
                1,
                2,
                morphoMarket6Id,
            );

            // Check fee beneficiary's WETH balance after
            const beneficiaryWethBalanceAfter = await wethContract.balanceOf(TEST_ADDRESS);
            const feeReceived = beneficiaryWethBalanceAfter - beneficiaryWethBalanceBefore;

            console.log("Protocol fee received (WETH):", ethers.formatUnits(feeReceived, 18));

            // The fee should be properly calculated in WETH terms (18 decimals)
            expect(feeReceived).to.be.gt(0);

            // Verify fee is reasonable (not too small due to decimal mismatch)
            expect(feeReceived).to.be.gt(ethers.parseUnits("0.000002", 18)); // At least 0.000002 WETH
        });
    });

    describe("Setter Functions", function () {
        let nonOwnerSigner: HardhatEthersSigner;
        let ownerSigner: HardhatEthersSigner;

        beforeEach(async function () {
            // Get a different address for non-owner tests
            const [owner, nonOwner] = await ethers.getSigners();
            ownerSigner = owner;
            nonOwnerSigner = nonOwner;

            // Connect contract with owner for setting tests
            myContract = await ethers.getContractAt("LeveragedPosition", deployedContractAddress, ownerSigner);
        });

        describe("setProtocolFee", function () {
            it("should set valid protocol fee (≤ 100)", async function () {
                const newFee = 50; // 0.5%
                await myContract.setProtocolFee(newFee);

                const currentFee = await myContract.protocolFee();
                expect(currentFee).to.equal(newFee);
            });

            it("should set protocol fee to maximum allowed value (100)", async function () {
                const maxFee = 100; // 1%
                await myContract.setProtocolFee(maxFee);

                const currentFee = await myContract.protocolFee();
                expect(currentFee).to.equal(maxFee);
            });

            it("should set protocol fee to minimum value (0)", async function () {
                const minFee = 0;
                await myContract.setProtocolFee(minFee);

                const currentFee = await myContract.protocolFee();
                expect(currentFee).to.equal(minFee);
            });

            it("should revert when fee is greater than 100", async function () {
                const invalidFee = 101;
                await expect(myContract.setProtocolFee(invalidFee)).to.be.revertedWith(
                    "_fee cannot be greater than 1%",
                );
            });

            it("should revert when called by non-owner", async function () {
                const contractAsNonOwner = await ethers.getContractAt(
                    "LeveragedPosition",
                    deployedContractAddress,
                    nonOwnerSigner,
                );
                const newFee = 50;

                await expect(contractAsNonOwner.setProtocolFee(newFee)).to.be.revertedWithCustomError(
                    myContract,
                    "OwnableUnauthorizedAccount",
                );
            });
        });

        describe("setFeeBeneficiary", function () {
            it("should set valid fee beneficiary address", async function () {
                const newBeneficiary = nonOwnerSigner.address;
                await myContract.setFeeBeneficiary(newBeneficiary);

                const currentBeneficiary = await myContract.feeBeneficiary();
                expect(currentBeneficiary).to.equal(newBeneficiary);
            });

            it("should revert when beneficiary is zero address", async function () {
                const zeroAddress = ethers.ZeroAddress;
                await expect(myContract.setFeeBeneficiary(zeroAddress)).to.be.revertedWith(
                    "_feeBeneficiary cannot be zero address",
                );
            });

            it("should revert when called by non-owner", async function () {
                const contractAsNonOwner = await ethers.getContractAt(
                    "LeveragedPosition",
                    deployedContractAddress,
                    nonOwnerSigner,
                );
                const newBeneficiary = ownerSigner.address;

                await expect(contractAsNonOwner.setFeeBeneficiary(newBeneficiary)).to.be.revertedWithCustomError(
                    myContract,
                    "OwnableUnauthorizedAccount",
                );
            });

            it("should allow owner to change beneficiary multiple times", async function () {
                const firstBeneficiary = nonOwnerSigner.address;
                const secondBeneficiary = ownerSigner.address;

                // Set first beneficiary
                await myContract.setFeeBeneficiary(firstBeneficiary);
                let currentBeneficiary = await myContract.feeBeneficiary();
                expect(currentBeneficiary).to.equal(firstBeneficiary);

                // Change to second beneficiary
                await myContract.setFeeBeneficiary(secondBeneficiary);
                currentBeneficiary = await myContract.feeBeneficiary();
                expect(currentBeneficiary).to.equal(secondBeneficiary);
            });
        });
    });

    it("revert if flashloan pool is not uniswap v3 pool", async function () {
        await expect(
            createLeveragedPosition(USDC_ADDRESS, Protocols.MORPHO, USDC_ADDRESS, WETH_ADDRESS, 1, 2, morphoMarket6Id),
        ).to.be.revertedWith("Invalid flashloan pool address");
    });
});
