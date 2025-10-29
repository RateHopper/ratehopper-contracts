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
    ETH_USDC_POOL,
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
    morphoMarket7Id,
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

        // Check debt token balance in contract before creating position
        const debtToken = new ethers.Contract(debtAsset, ERC20_ABI, impersonatedSigner);
        const debtBalanceBefore = await debtToken.balanceOf(deployedContractAddress);
        console.log("Debt token balance in contract before creating position: ", ethers.formatUnits(debtBalanceBefore, debtDecimals));

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

        const debtRemainingBalance = await debtToken.balanceOf(deployedContractAddress);
        expect(Number(debtRemainingBalance)).to.be.equal(0);
    }

    async function closeLeveragedPosition(
        flashloanPool: string,
        protocol: Protocols,
        collateralAddress = cbETH_ADDRESS,
        debtTokenAddress = USDC_ADDRESS,
        morphoMarketId?: string,
        partialClosePercentage: number = 100, // 100 = full close, 50 = half close, etc.
    ) {
        const Helper = protocolHelperMap.get(protocol)!;
        const protocolHelper = new Helper(impersonatedSigner);

        const debtAsset = debtTokenAddress || USDC_ADDRESS;

        const collateralDecimals = await getDecimals(collateralAddress);
        const debtDecimals = await getDecimals(debtAsset);

        // Get current debt amount before closing
        const debtAmountParameter = protocol === Protocols.MORPHO ? morphoMarketId! : debtAsset;
        const debtAmountFull = await protocolHelper.getDebtAmount(debtAmountParameter);
        console.log("Debt amount before closing: ", ethers.formatUnits(debtAmountFull, debtDecimals));

        // Get current collateral amount before closing
        let collateralAmountFull: bigint;
        switch (protocol) {
            case Protocols.AAVE_V3:
                collateralAmountFull = await aaveV3Helper.getCollateralAmount(collateralAddress);

                // Approve aToken to the contract for withdrawal
                const aTokenAddress = await aaveV3Helper.getATokenAddress(collateralAddress);
                await approve(aTokenAddress, deployedContractAddress, impersonatedSigner);
                break;
            case Protocols.COMPOUND:
                collateralAmountFull = await compoundHelper.getCollateralAmount(
                    cometAddressMap.get(debtAsset)!,
                    collateralAddress,
                );
                break;
            case Protocols.MORPHO:
                collateralAmountFull = await morphoHelper.getCollateralAmount(morphoMarketId!);
                break;
            default:
                throw new Error("Unsupported protocol");
        }
        console.log("Collateral amount before closing: ", ethers.formatUnits(collateralAmountFull, collateralDecimals));

        // Calculate amounts based on partial close percentage
        const debtAmountBefore = (debtAmountFull * BigInt(partialClosePercentage)) / 100n;
        const collateralAmountBefore = (collateralAmountFull * BigInt(partialClosePercentage)) / 100n;

        if (partialClosePercentage < 100) {
            console.log(`Partial close (${partialClosePercentage}%):`);
            console.log("  Debt to repay:", ethers.formatUnits(debtAmountBefore, debtDecimals));
            console.log("  Collateral to withdraw:", ethers.formatUnits(collateralAmountBefore, collateralDecimals));
        }

        let extraData = "0x";
        switch (protocol) {
            case Protocols.COMPOUND:
                extraData = compoundHelper.encodeExtraData(cometAddressMap.get(debtAsset)!);
                break;
            case Protocols.MORPHO:
                // Fetch borrowShares for full repayment
                const borrowShares = await morphoHelper.getBorrowShares(morphoMarketId!);
                console.log("Morpho borrowShares for repayment:", borrowShares.toString());
                extraData = morphoHelper.encodeExtraData(morphoMarketId!, borrowShares);
                break;
        }

        // Get paraswap data to swap collateral to debt asset
        const paraswapData = await getParaswapData(debtAsset, collateralAddress, deployedContractAddress, debtAmountBefore);

        // Get user's collateral token balance before closing
        const collateralToken = new ethers.Contract(collateralAddress, ERC20_ABI, impersonatedSigner);
        const userCollateralBalanceBefore = await collateralToken.balanceOf(impersonatedSigner.address);

        // Log all parameters before calling closeLeveragedPosition
        console.log("=== closeLeveragedPosition Parameters ===");
        console.log("flashloanPool:", flashloanPool);
        console.log("protocol:", protocol);
        console.log("collateralAddress:", collateralAddress);
        console.log("collateralAmountBefore:", ethers.formatUnits(collateralAmountBefore, collateralDecimals));
        console.log("debtAsset:", debtAsset);
        console.log("extraData:", extraData);
        console.log("paraswapData.srcAmount:", paraswapData.srcAmount.toString());
        console.log("paraswapData.swapData length:", paraswapData.swapData.length);
        console.log("=========================================");

        // Add 1% buffer to debt amount to account for interest accrual
        const debtAmountToPass = (debtAmountBefore * 101n) / 100n;

        console.log("Original debt amount:", ethers.formatUnits(debtAmountBefore, debtDecimals));
        console.log("Debt amount with 1% buffer:", ethers.formatUnits(debtAmountToPass, debtDecimals));

        await myContract.closeLeveragedPosition(
            flashloanPool,
            protocol,
            collateralAddress,
            collateralAmountBefore,
            debtAsset,
            debtAmountToPass,
            extraData,
            paraswapData,
        );

        // Verify debt and collateral amounts after closing
        const debtAmountAfter = await protocolHelper.getDebtAmount(debtAmountParameter);
        console.log("Debt amount after closing: ", ethers.formatUnits(debtAmountAfter, debtDecimals));

        let collateralAmountAfter: bigint;
        switch (protocol) {
            case Protocols.AAVE_V3:
                collateralAmountAfter = await aaveV3Helper.getCollateralAmount(collateralAddress);
                break;
            case Protocols.COMPOUND:
                collateralAmountAfter = await compoundHelper.getCollateralAmount(
                    cometAddressMap.get(debtAsset)!,
                    collateralAddress,
                );
                break;
            case Protocols.MORPHO:
                collateralAmountAfter = await morphoHelper.getCollateralAmount(morphoMarketId!);
                break;
            default:
                throw new Error("Unsupported protocol");
        }
        console.log("Collateral amount after closing: ", ethers.formatUnits(collateralAmountAfter, collateralDecimals));

        if (partialClosePercentage === 100) {
            // For full close, expect debt to be 0
            expect(debtAmountAfter).to.equal(0);

            // For full close, allow for dust amount in collateral
            const dustTolerance = ethers.parseUnits("0.00001", collateralDecimals);
            expect(collateralAmountAfter).to.be.lte(dustTolerance);
        } else {
            // For partial close, verify remaining amounts
            const remainingPercentage = 100 - partialClosePercentage;
            const expectedRemainingDebt = (debtAmountFull * BigInt(remainingPercentage)) / 100n;
            const expectedRemainingCollateral = (collateralAmountFull * BigInt(remainingPercentage)) / 100n;

            // Allow 5% tolerance for interest accrual and swap slippage
            const debtTolerance = expectedRemainingDebt / 20n; // 5%
            const collateralTolerance = expectedRemainingCollateral / 20n; // 5%

            console.log("Expected remaining debt:", ethers.formatUnits(expectedRemainingDebt, debtDecimals));
            console.log("Expected remaining collateral:", ethers.formatUnits(expectedRemainingCollateral, collateralDecimals));

            expect(debtAmountAfter).to.be.closeTo(expectedRemainingDebt, debtTolerance);
            expect(collateralAmountAfter).to.be.closeTo(expectedRemainingCollateral, collateralTolerance);
        }

        // Verify user received collateral back
        const userCollateralBalanceAfter = await collateralToken.balanceOf(impersonatedSigner.address);
        const collateralReturned = userCollateralBalanceAfter - userCollateralBalanceBefore;
        console.log("Collateral returned to user: ", ethers.formatUnits(collateralReturned, collateralDecimals));
        expect(collateralReturned).to.be.gt(0);

        // Verify no tokens left in contract
        const collateralRemainingBalance = await collateralToken.balanceOf(deployedContractAddress);
        expect(Number(collateralRemainingBalance)).to.be.equal(0);

        const debtToken = new ethers.Contract(debtAsset, ERC20_ABI, impersonatedSigner);
        const debtRemainingBalance = await debtToken.balanceOf(deployedContractAddress);
        console.log("Debt remaining balance in contract: ", ethers.formatUnits(debtRemainingBalance, debtDecimals));
        expect(Number(debtRemainingBalance)).to.be.equal(0);
    }

    describe("on Aave", function () {
        it("create and close position with cbETH collateral", async function () {
            await createLeveragedPosition(cbETH_ETH_POOL, Protocols.AAVE_V3);

            await time.increaseTo((await time.latest()) + 3600); // 1 hour

            await closeLeveragedPosition(USDC_hyUSD_POOL, Protocols.AAVE_V3);
        });

        it("create and close position with WETH collateral", async function () {
            await createLeveragedPosition(ETH_USDC_POOL, Protocols.AAVE_V3, WETH_ADDRESS, USDC_ADDRESS);

            await time.increaseTo((await time.latest()) + 3600); // 1 hour

            await closeLeveragedPosition(USDC_hyUSD_POOL, Protocols.AAVE_V3, WETH_ADDRESS, USDC_ADDRESS);
        });

        it("partial close position with cbETH collateral", async function () {
            await createLeveragedPosition(cbETH_ETH_POOL, Protocols.AAVE_V3);

            await time.increaseTo((await time.latest()) + 3600); // 1 hour

            // Partially close 50% of the position
            await closeLeveragedPosition(USDC_hyUSD_POOL, Protocols.AAVE_V3, cbETH_ADDRESS, USDC_ADDRESS, undefined, 50);
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
        it("create and close position with cbETH collateral", async function () {
            await createLeveragedPosition(cbETH_ETH_POOL, Protocols.COMPOUND);

            await time.increaseTo((await time.latest()) + 3600); // 1 hour

            await closeLeveragedPosition(USDC_hyUSD_POOL, Protocols.COMPOUND);
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
        
        it("close position with WETH collateral", async function () {
            await createLeveragedPosition(ETH_USDC_POOL, Protocols.COMPOUND, WETH_ADDRESS, USDC_ADDRESS);

            await time.increaseTo((await time.latest()) + 3600); // 1 hour

            await closeLeveragedPosition(USDC_hyUSD_POOL, Protocols.COMPOUND, WETH_ADDRESS, USDC_ADDRESS);
        });
    });

    describe("on Morpho", function () {
        it("create and close position with cbETH collateral", async function () {
            await createLeveragedPosition(
                cbETH_ETH_POOL,
                Protocols.MORPHO,
                undefined,
                undefined,
                undefined,
                undefined,
                morphoMarket1Id,
            );

            await time.increaseTo((await time.latest()) + 3600); // 1 hour

            await closeLeveragedPosition(
                USDC_hyUSD_POOL,
                Protocols.MORPHO,
                cbETH_ADDRESS,
                USDC_ADDRESS,
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


        it("close position with WETH collateral", async function () {
            await createLeveragedPosition(
                ETH_USDC_POOL,
                Protocols.MORPHO,
                WETH_ADDRESS,
                USDC_ADDRESS,
                undefined,
                undefined,
                morphoMarket7Id,
            );

            await time.increaseTo((await time.latest()) + 3600); // 1 hour

            await closeLeveragedPosition(
                USDC_hyUSD_POOL,
                Protocols.MORPHO,
                WETH_ADDRESS,
                USDC_ADDRESS,
                morphoMarket7Id,
            );
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

    it.skip("trace failed transaction 0x94adbbc69208165e95a5a997bb7661196df597d68b9a5e72f84fa23fc9ea093b", async function () {
        // This test traces the exact failed transaction from basescan
        const txSender = "0x482F5a12cBa3b277eB9FFdBA774aFd250a7FCC4f";
        const safeWalletAddress = "0xE9AE8836C9f6F419dcb86E00A0453A074FaBfFa2";
        const contractAddress = "0xba25a6bf94ceb977ca1b4823158369463e514802";

        // Fund the sender with ETH for gas (only works on forked network)
        await ethers.provider.send("hardhat_setBalance", [
            txSender,
            "0x56BC75E2D63100000", // 100 ETH in hex
        ]);

        // Impersonate the transaction sender
        const sender = await ethers.getImpersonatedSigner(txSender);

        console.log("Testing failed transaction...");
        console.log("Sender:", txSender);
        console.log("Safe Wallet:", safeWalletAddress);
        console.log("LeveragedPosition Contract:", contractAddress);

        // Raw transaction data from basescan
        const data = "0x6a761202000000000000000000000000a1dabef33b3b82c7814b6d82a79e50f4ac44102b00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000140000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000002dc6c000000000000000000000000000000000000000000000000000000000000186a000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000008c000000000000000000000000000000000000000000000000000000000000007448d80ff0a000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000006e400420000000000000000000000000000000000000600000000000000000000000000000000000000000000000000038d7ea4c680000000000000000000000000000000000000000000000000000000000000000004d0e30db000420000000000000000000000000000000000000600000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000044095ea7b3000000000000000000000000ba25a6bf94ceb977ca1b4823158369463e51480200000000000000000000000000000000000000000000000000038d7ea4c680000059dca05b6c26dbd64b5381374aaac5cd05644c2800000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000044c04a8a10000000000000000000000000ba25a6bf94ceb977ca1b4823158369463e514802ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff00ba25a6bf94ceb977ca1b4823158369463e51480200000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000504da0329f4000000000000000000000000b4cb800910b228ed3d0834cf79d697127bbb00e50000000000000000000000000000000000000000000000000000000000000000000000000000000000000000420000000000000000000000000000000000000600000000000000000000000000000000000000000000000000038d7ea4c6800000000000000000000000000000000000000000000000000000082bd67afbc000000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda029130000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000012000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000483322000000000000000000000000000000000000000000000000000000000000004000000000000000000000000000000000000000000000000000000000000003647f4576750000000000000000000000000e5891850bb3f03090f03010000806f080040100000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda029130000000000000000000000004200000000000000000000000000000000000006000000000000000000000000000000000000000000000000000000000048332300000000000000000000000000000000000000000000000000044383819d77800000000000000000000000000000000000000000000000000000000000477c224bf0cddb8a7e4eed814ff69bc61d75590000000000000000000000000236d7c90000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000001600000000000000000000000000000000000000000000000000000000000000180000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000001c0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000001e00000016000000000000000000000008c000000000000006c000000000000271076578ecf9a141296ec657847fb45b0585bcda3a601400064012500440000000b0000000000000000000000000000000000000000000000000000000094e86ef800000000000000000000000054a8423c1b1bdae9a1accf7d8cf0c7e7106e31c3000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913000000000000000000000000420000000000000000000000000000000000000600000000000000000000000000000000000000000000000000044383819d7780ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff0000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000010000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000041000000000000000000000000482f5a12cba3b277eb9ffdba774afd250a7fcc4f00000000000000000000000000000000000000000000000000000000000000000100000000000000000000000000000000000000000000000000000000000000";

        // Send the exact transaction to the Safe wallet
        await expect(
            sender.sendTransaction({
                to: safeWalletAddress,
                data: data,
            })
        ).to.be.reverted;

        console.log("Transaction reverted as expected");
    });
});
