import { ethers } from "hardhat";
import dotenv from "dotenv";
dotenv.config();
import Safe from "@safe-global/protocol-kit";
import { cbETH_ADDRESS, DEFAULT_SUPPLY_AMOUNT, Protocols, USDC_ADDRESS, WETH_ADDRESS } from "./constants";
import { abi as ERC20_ABI } from "@openzeppelin/contracts/build/contracts/ERC20.json";
import { MetaTransactionData, OperationType } from "@safe-global/types-kit";
import { time, loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { eip1193Provider, fundETH, fundSignerWithETH } from "./utils";
import { FLUID_cbETH_USDC_VAULT, FLUID_WETH_USDC_VAULT, FluidHelper } from "./protocols/fluid";
import { CompoundHelper, USDC_COMET_ADDRESS } from "./protocols/compound";
import { morphoMarket1Id, MorphoHelper } from "./protocols/morpho";
import { AaveV3Helper } from "./protocols/aaveV3";
import { MoonwellHelper } from "./protocols/moonwell";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { expect } from "chai";
import { deploySafeContractFixture } from "./deployUtils";
import { safeAddress, createSafeTestHelpers } from "./debtSwapBySafe";

describe("Safe wallet exit function tests", function () {
    this.timeout(300000);

    const signer = new ethers.Wallet(process.env.TESTING_SAFE_OWNER_KEY!, ethers.provider);
    let operator: HardhatEthersSigner;
    let safeWallet: Awaited<ReturnType<typeof Safe.init>>;
    let safeModuleContract: any;
    let safeModuleAddress: string;
    let helpers: ReturnType<typeof createSafeTestHelpers>;

    this.beforeEach(async () => {
        const signers = await ethers.getSigners();
        operator = signers[2];

        await fundSignerWithETH(signer.address);

        safeWallet = await Safe.init({
            provider: eip1193Provider,
            signer: process.env.TESTING_SAFE_OWNER_KEY,
            safeAddress: safeAddress,
        });

        const { safeModule } = await loadFixture(deploySafeContractFixture);
        safeModuleContract = safeModule;
        safeModuleAddress = await safeModuleContract.getAddress();

        helpers = createSafeTestHelpers({ signer, safeWallet, safeModuleAddress });

        await fundETH(safeAddress);
        await enableSafeModule();
    });

    async function enableSafeModule() {
        const enableModuleTx = await safeWallet.createEnableModuleTx(safeModuleAddress);
        await safeWallet.executeTransaction(enableModuleTx);
    }

    this.afterEach(async () => {
        if (global.gc) {
            global.gc();
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    });

    const supplyAndBorrow = (...args: Parameters<ReturnType<typeof createSafeTestHelpers>["supplyAndBorrow"]>) =>
        helpers.supplyAndBorrow(...args);
    const supplyAndBorrowOnFluid = (
        ...args: Parameters<ReturnType<typeof createSafeTestHelpers>["supplyAndBorrowOnFluid"]>
    ) => helpers.supplyAndBorrowOnFluid(...args);
    const morphoAuthorizeTxBySafe = () => helpers.morphoAuthorizeTxBySafe();
    const compoundAllowTxBySafe = (tokenAddress: string) => helpers.compoundAllowTxBySafe(tokenAddress);

    // ─── Shared helpers ───

    async function approveAaveAToken(approvalAmount: bigint) {
        const aaveHelper = new AaveV3Helper(signer);
        const aTokenAddress = await aaveHelper.getATokenAddress(cbETH_ADDRESS);
        const token = new ethers.Contract(aTokenAddress, ERC20_ABI, signer);

        const approveTransactionData: MetaTransactionData = {
            to: aTokenAddress,
            value: "0",
            data: token.interface.encodeFunctionData("approve", [safeModuleAddress, approvalAmount]),
            operation: OperationType.Call,
        };

        const safeApproveTransaction = await safeWallet.createTransaction({
            transactions: [approveTransactionData],
        });
        await safeWallet.executeTransaction(safeApproveTransaction);
    }

    // ─── Protocol config factories ───

    function getFluidExitConfig(opts?: {
        vaultAddress?: string;
        collateralAsset?: string;
        partialRepay?: boolean;
    }) {
        const vault = opts?.vaultAddress ?? FLUID_cbETH_USDC_VAULT;
        const collateral = opts?.collateralAsset ?? cbETH_ADDRESS;
        const fluidHelper = new FluidHelper(signer);

        return {
            protocol: Protocols.FLUID,
            debtAsset: USDC_ADDRESS,
            debtDecimals: 6,
            collateralAsset: collateral,
            collateralDecimals: 18,
            setupPosition: async () => {
                if (vault === FLUID_WETH_USDC_VAULT) {
                    await supplyAndBorrowOnFluid(FLUID_WETH_USDC_VAULT, WETH_ADDRESS);
                } else {
                    await supplyAndBorrowOnFluid();
                }
            },
            getDebtAmount: () => fluidHelper.getDebtAmount(vault, safeAddress),
            getCollateralAmount: () => fluidHelper.getCollateralAmount(collateral, safeAddress),
            getExtraData: async () => {
                const nftId = await fluidHelper.getNftId(vault, safeAddress);
                return ethers.AbiCoder.defaultAbiCoder().encode(
                    ["address", "uint256", "bool"],
                    [vault, nftId, !(opts?.partialRepay)],
                );
            },
            validateDebtRepaid: async () => {
                const debtAfter = await fluidHelper.getDebtAmount(vault, safeAddress);
                expect(debtAfter).to.equal(0);
            },
        };
    }

    function getAaveExitConfig(opts?: { approvalAmount?: bigint }) {
        const aaveHelper = new AaveV3Helper(signer);

        return {
            protocol: Protocols.AAVE_V3,
            debtAsset: USDC_ADDRESS,
            debtDecimals: 6,
            collateralAsset: cbETH_ADDRESS,
            collateralDecimals: 18,
            setupPosition: async () => {
                await supplyAndBorrow(Protocols.AAVE_V3);
                await approveAaveAToken(opts?.approvalAmount ?? ethers.parseEther("1"));
            },
            getDebtAmount: () => aaveHelper.getDebtAmount(USDC_ADDRESS, safeAddress),
            getCollateralAmount: () => aaveHelper.getCollateralAmount(cbETH_ADDRESS, safeAddress),
            getExtraData: async () => "0x",
            validateDebtRepaid: async () => {
                const debtAfter = await aaveHelper.getDebtAmount(USDC_ADDRESS, safeAddress);
                expect(debtAfter).to.equal(0);
            },
        };
    }

    function getMorphoExitConfig(opts?: { partialRepay?: boolean }) {
        const marketId = morphoMarket1Id;
        const morphoHelper = new MorphoHelper(signer);

        return {
            protocol: Protocols.MORPHO,
            debtAsset: USDC_ADDRESS,
            debtDecimals: 6,
            collateralAsset: cbETH_ADDRESS,
            collateralDecimals: 18,
            setupPosition: async () => {
                await supplyAndBorrow(Protocols.MORPHO);
                await morphoAuthorizeTxBySafe();
            },
            getDebtAmount: () => morphoHelper.getDebtAmount(marketId, safeAddress),
            getCollateralAmount: () => morphoHelper.getCollateralAmount(marketId, safeAddress),
            getExtraData: async () => {
                if (opts?.partialRepay) {
                    return morphoHelper.encodeExtraData(marketId, 0n);
                }
                const borrowShares = await morphoHelper.getBorrowShares(marketId, safeAddress);
                return morphoHelper.encodeExtraData(marketId, borrowShares);
            },
            validateDebtRepaid: async () => {
                const debtAfter = await morphoHelper.getDebtAmount(marketId, safeAddress);
                expect(debtAfter).to.equal(0);
            },
        };
    }

    function getCompoundExitConfig() {
        const cometAddress = USDC_COMET_ADDRESS;
        const compoundHelper = new CompoundHelper(signer);

        return {
            protocol: Protocols.COMPOUND,
            debtAsset: USDC_ADDRESS,
            debtDecimals: 6,
            collateralAsset: cbETH_ADDRESS,
            collateralDecimals: 18,
            setupPosition: async () => {
                await supplyAndBorrow(Protocols.COMPOUND);
                await compoundAllowTxBySafe(USDC_ADDRESS);
            },
            getDebtAmount: () => compoundHelper.getDebtAmount(USDC_ADDRESS, safeAddress),
            getCollateralAmount: () => compoundHelper.getCollateralAmount(cometAddress, cbETH_ADDRESS, safeAddress),
            getExtraData: () => Promise.resolve(compoundHelper.encodeExtraData(cometAddress)),
            validateDebtRepaid: async () => {
                const debtAfter = await compoundHelper.getDebtAmount(USDC_ADDRESS, safeAddress);
                expect(debtAfter).to.equal(0);
            },
        };
    }

    function getMoonwellExitConfig() {
        const moonwellHelper = new MoonwellHelper(signer);

        return {
            protocol: Protocols.MOONWELL,
            debtAsset: USDC_ADDRESS,
            debtDecimals: 6,
            collateralAsset: cbETH_ADDRESS,
            collateralDecimals: 18,
            setupPosition: async () => {
                await supplyAndBorrow(Protocols.MOONWELL);
            },
            getDebtAmount: () => moonwellHelper.getDebtAmount(USDC_ADDRESS, safeAddress),
            getCollateralAmount: () => moonwellHelper.getCollateralAmount(cbETH_ADDRESS, safeAddress),
            getExtraData: async () => "0x",
            validateDebtRepaid: async () => {
                const debtAfter = await moonwellHelper.getDebtAmount(USDC_ADDRESS, safeAddress);
                expect(debtAfter).to.equal(0);
            },
        };
    }

    // ─── Main test helper ───

    async function testExitPosition(options: {
        protocol: Protocols;
        debtAsset: string;
        debtDecimals: number;
        collateralAsset: string;
        collateralDecimals: number;
        setupPosition: () => Promise<void>;
        getDebtAmount: () => Promise<bigint>;
        getCollateralAmount: () => Promise<bigint>;
        getExtraData: () => Promise<string>;
        validateDebtRepaid: () => Promise<void>;
        withdrawCollateral?: boolean;
        debtAmountOverride?: bigint;
        collateralAmountOverride?: bigint;
        callViaSafe?: boolean;
        partialDebtRepay?: boolean;
    }) {
        const {
            protocol,
            debtAsset,
            debtDecimals,
            collateralAsset,
            collateralDecimals,
            setupPosition,
            getDebtAmount,
            getCollateralAmount,
            getExtraData,
            validateDebtRepaid,
            withdrawCollateral = true,
            debtAmountOverride,
            collateralAmountOverride,
            callViaSafe = false,
            partialDebtRepay = false,
        } = options;

        await time.increaseTo((await time.latest()) + 3600);

        if (!callViaSafe) {
            await fundSignerWithETH(operator.address, "0.01");
        }

        await setupPosition();

        const debtBefore = await getDebtAmount();
        expect(debtBefore).to.be.gt(0);

        const debtContract = new ethers.Contract(debtAsset, ERC20_ABI, signer);
        if (partialDebtRepay) {
            await debtContract.transfer(safeAddress, debtBefore / 2n + ethers.parseUnits("0.1", debtDecimals));
        } else {
            const transferTx = await debtContract.transfer(
                safeAddress,
                debtBefore + ethers.parseUnits("1", debtDecimals),
            );
            await transferTx.wait();
        }

        const collateralAmount = await getCollateralAmount();
        const collateralContract = new ethers.Contract(collateralAsset, ERC20_ABI, signer);
        const collateralBalanceBefore = await collateralContract.balanceOf(safeAddress);

        const extraData = await getExtraData();

        let debtAmountToUse: bigint;
        if (partialDebtRepay) {
            debtAmountToUse = debtBefore / 2n;
        } else if (debtAmountOverride !== undefined) {
            debtAmountToUse = debtAmountOverride;
        } else {
            debtAmountToUse = (debtBefore * 101n) / 100n;
        }

        const collateralAmountToUse =
            collateralAmountOverride !== undefined
                ? collateralAmountOverride
                : partialDebtRepay
                  ? ethers.MaxUint256
                  : collateralAmount;

        // Execute exit
        let receipt;
        if (callViaSafe) {
            const moduleContract = await ethers.getContractAt("SafeDebtManager", safeModuleAddress);
            const exitCallData: MetaTransactionData = {
                to: safeModuleAddress,
                value: "0",
                data: moduleContract.interface.encodeFunctionData("exit", [
                    protocol,
                    debtAsset,
                    debtAmountToUse,
                    [{ asset: collateralAsset, amount: collateralAmountToUse }],
                    safeAddress,
                    extraData,
                    withdrawCollateral,
                ]),
                operation: OperationType.Call,
            };
            const safeTransaction = await safeWallet.createTransaction({ transactions: [exitCallData] });
            await safeWallet.executeTransaction(safeTransaction);
        } else {
            const moduleContract = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, operator);
            const exitTx = await moduleContract.exit(
                protocol,
                debtAsset,
                debtAmountToUse,
                [{ asset: collateralAsset, amount: collateralAmountToUse }],
                safeAddress,
                extraData,
                withdrawCollateral,
                { gasLimit: "2000000" },
            );
            receipt = await exitTx.wait();
        }

        // Verify event (operator calls only)
        if (!callViaSafe && receipt) {
            const moduleContract = await ethers.getContractAt("SafeDebtManager", safeModuleAddress);
            const exitEvent = receipt.logs.find((log: any) => {
                try {
                    const parsed = moduleContract.interface.parseLog({ topics: [...log.topics], data: log.data });
                    return parsed?.name === "DebtPositionExited";
                } catch {
                    return false;
                }
            });
            expect(exitEvent).to.not.be.undefined;
        }

        // Validation
        if (partialDebtRepay) {
            const debtAfter = await getDebtAmount();
            expect(debtAfter).to.be.gt(0);
            expect(debtAfter).to.be.lt(debtBefore);

            const collateralAfter = await getCollateralAmount();
            expect(BigInt(collateralAfter)).to.be.gt(0n);
            expect(BigInt(collateralAfter)).to.be.lt(BigInt(collateralAmount));

            const collateralBalanceAfter = await collateralContract.balanceOf(safeAddress);
            const withdrawn = collateralBalanceAfter - collateralBalanceBefore;
            expect(withdrawn).to.be.gt(0);

            const totalAfter = BigInt(withdrawn) + BigInt(collateralAfter);
            const tolerance =
                collateralDecimals === 18
                    ? ethers.parseEther("0.001")
                    : ethers.parseUnits("0.001", collateralDecimals);
            expect(totalAfter).to.be.closeTo(collateralAmount, tolerance);
            expect(BigInt(withdrawn)).to.be.gte((BigInt(collateralAmount) * 30n) / 100n);
        } else {
            await validateDebtRepaid();

            const collateralInProtocolAfter = await getCollateralAmount();
            const collateralBalanceAfter = await collateralContract.balanceOf(safeAddress);

            if (withdrawCollateral) {
                expect(collateralBalanceAfter).to.be.gt(collateralBalanceBefore);

                const withdrawnAmount = collateralBalanceAfter - collateralBalanceBefore;
                const tolerance =
                    collateralDecimals === 18
                        ? ethers.parseEther("0.001")
                        : ethers.parseUnits("0.001", collateralDecimals);
                expect(withdrawnAmount).to.be.closeTo(collateralAmount, tolerance);

                const collateralTolerance =
                    collateralDecimals === 18
                        ? ethers.parseEther("0.0001")
                        : ethers.parseUnits("0.0001", collateralDecimals);
                expect(collateralInProtocolAfter).to.be.closeTo(0n, collateralTolerance);
            } else {
                expect(collateralBalanceAfter).to.equal(collateralBalanceBefore);
            }
        }
    }

    // ─── Tests ───

    describe("exit function", function () {
        // ── Full exit tests ──

        it("Should exit a Fluid position successfully with cbETH", async function () {
            await testExitPosition(getFluidExitConfig());
        });

        it("Should exit a Fluid position successfully with WETH", async function () {
            await testExitPosition(
                getFluidExitConfig({ vaultAddress: FLUID_WETH_USDC_VAULT, collateralAsset: WETH_ADDRESS }),
            );
        });

        it("Should exit a Fluid position successfully - Safe owner call via Safe transaction", async function () {
            await testExitPosition({ ...getFluidExitConfig(), callViaSafe: true });
        });

        it("Should exit a Fluid position with withdrawCollateral=false - debt repaid, collateral remains", async function () {
            await testExitPosition({ ...getFluidExitConfig(), withdrawCollateral: false });
        });

        it("Should exit a Morpho position successfully", async function () {
            await testExitPosition(getMorphoExitConfig());
        });

        it("Should exit a Compound position successfully", async function () {
            await testExitPosition(getCompoundExitConfig());
        });

        it("Should exit an Aave position successfully", async function () {
            await testExitPosition(getAaveExitConfig());
        });

        // ── Max collateral (type(uint256).max) with full debt repayment ──

        it("Should exit an Aave position with type(uint256).max collateral amount", async function () {
            await testExitPosition({
                ...getAaveExitConfig({ approvalAmount: ethers.MaxUint256 }),
                collateralAmountOverride: ethers.MaxUint256,
            });
        });

        it("Should exit a Compound position with type(uint256).max collateral amount", async function () {
            await testExitPosition({ ...getCompoundExitConfig(), collateralAmountOverride: ethers.MaxUint256 });
        });

        it("Should exit a Morpho position with type(uint256).max collateral amount", async function () {
            await testExitPosition({ ...getMorphoExitConfig(), collateralAmountOverride: ethers.MaxUint256 });
        });

        it("Should exit a Fluid position with type(uint256).max collateral amount", async function () {
            await testExitPosition({ ...getFluidExitConfig(), collateralAmountOverride: ethers.MaxUint256 });
        });

        it("Should exit a Moonwell position with type(uint256).max collateral amount", async function () {
            await testExitPosition({ ...getMoonwellExitConfig(), collateralAmountOverride: ethers.MaxUint256 });
        });

        // ── Partial debt repayment + max collateral withdrawal ──

        it("Should exit an Aave position with type(uint256).max collateral and partial debt repayment", async function () {
            await testExitPosition({
                ...getAaveExitConfig({ approvalAmount: ethers.MaxUint256 }),
                partialDebtRepay: true,
            });
        });

        it("Should exit a Compound position with type(uint256).max collateral and partial debt repayment", async function () {
            await testExitPosition({ ...getCompoundExitConfig(), partialDebtRepay: true });
        });

        it("Should exit a Morpho position with type(uint256).max collateral and partial debt repayment", async function () {
            await testExitPosition({ ...getMorphoExitConfig({ partialRepay: true }), partialDebtRepay: true });
        });

        it("Should exit a Fluid position with type(uint256).max collateral and partial debt repayment", async function () {
            await testExitPosition({ ...getFluidExitConfig({ partialRepay: true }), partialDebtRepay: true });
        });

        it("Should exit a Moonwell position with type(uint256).max collateral and partial debt repayment", async function () {
            await testExitPosition({ ...getMoonwellExitConfig(), partialDebtRepay: true });
        });

        // ── Max debt amount ──

        it("Should exit a Fluid position using type(uint256).max for debt amount", async function () {
            await testExitPosition({ ...getFluidExitConfig(), debtAmountOverride: ethers.MaxUint256 });
        });

        // ── Revert / edge case tests ──

        it("Should revert when invalid comet address is passed for Compound withdraw", async function () {
            const compoundHelper = new CompoundHelper(signer);

            await time.increaseTo((await time.latest()) + 3600);
            await fundSignerWithETH(operator.address, "0.01");

            await supplyAndBorrow(Protocols.COMPOUND);
            await compoundAllowTxBySafe(USDC_ADDRESS);

            const debtBefore = await compoundHelper.getDebtAmount(USDC_ADDRESS, safeAddress);
            expect(debtBefore).to.be.gt(0);

            const debtContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, signer);
            await debtContract.transfer(safeAddress, debtBefore + ethers.parseUnits("1", 6));

            const collateralAmount = await compoundHelper.getCollateralAmount(
                USDC_COMET_ADDRESS,
                cbETH_ADDRESS,
                safeAddress,
            );

            const moduleContract = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, operator);

            const randomAddress = ethers.Wallet.createRandom().address;
            const invalidExtraData1 = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [randomAddress]);

            await expect(
                moduleContract.exit(
                    Protocols.COMPOUND,
                    USDC_ADDRESS,
                    debtBefore,
                    [{ asset: cbETH_ADDRESS, amount: collateralAmount }],
                    safeAddress,
                    invalidExtraData1,
                    true,
                    { gasLimit: "2000000" },
                ),
            ).to.be.reverted;

            const wrongCometExtraData = ethers.AbiCoder.defaultAbiCoder().encode(
                ["address"],
                ["0x46e6b214b524310239732D51387075E0e70970bf"],
            );

            await expect(
                moduleContract.exit(
                    Protocols.COMPOUND,
                    USDC_ADDRESS,
                    debtBefore,
                    [{ asset: cbETH_ADDRESS, amount: collateralAmount }],
                    safeAddress,
                    wrongCometExtraData,
                    true,
                    { gasLimit: "2000000" },
                ),
            ).to.be.reverted;

            const validExtraData = compoundHelper.encodeExtraData(USDC_COMET_ADDRESS);
            await moduleContract.exit(
                Protocols.COMPOUND,
                USDC_ADDRESS,
                debtBefore,
                [{ asset: cbETH_ADDRESS, amount: collateralAmount }],
                safeAddress,
                validExtraData,
                true,
                { gasLimit: "2000000" },
            );

            const debtAfter = await compoundHelper.getDebtAmount(USDC_ADDRESS, safeAddress);
            expect(debtAfter).to.equal(0);
        });

        it("Should revert exit with type(uint256).max when Safe has insufficient balance", async function () {
            const vaultAddress = FLUID_cbETH_USDC_VAULT;
            const fluidHelper = new FluidHelper(signer);

            await time.increaseTo((await time.latest()) + 3600);
            await fundSignerWithETH(operator.address, "0.01");

            await supplyAndBorrowOnFluid();

            const debtBefore = await fluidHelper.getDebtAmount(vaultAddress, safeAddress);
            expect(debtBefore).to.be.gt(0);

            const debtContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, signer);
            const insufficientAmount = debtBefore / 2n;
            await debtContract.transfer(safeAddress, insufficientAmount);

            const safeBalance = await debtContract.balanceOf(safeAddress);
            expect(safeBalance).to.be.lt(debtBefore);

            const collateralAmount = await fluidHelper.getCollateralAmount(cbETH_ADDRESS, safeAddress);
            const nftId = await fluidHelper.getNftId(vaultAddress, safeAddress);
            const extraData = ethers.AbiCoder.defaultAbiCoder().encode(
                ["address", "uint256", "bool"],
                [vaultAddress, nftId, true],
            );

            const moduleContract = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, operator);

            await expect(
                moduleContract.exit(
                    Protocols.FLUID,
                    USDC_ADDRESS,
                    ethers.MaxUint256,
                    [{ asset: cbETH_ADDRESS, amount: collateralAmount }],
                    safeAddress,
                    extraData,
                    true,
                    { gasLimit: "2000000" },
                ),
            ).to.be.revertedWith("Insufficient balance");
        });

        it("Should withdraw collateral only on Aave with debtAmount=0 after debt is fully repaid", async function () {
            const aaveHelper = new AaveV3Helper(signer);

            await time.increaseTo((await time.latest()) + 3600);
            await fundSignerWithETH(operator.address, "0.01");

            await supplyAndBorrow(Protocols.AAVE_V3);
            await approveAaveAToken(ethers.parseEther("1"));

            const debtBefore = await aaveHelper.getDebtAmount(USDC_ADDRESS, safeAddress);
            expect(debtBefore).to.be.gt(0);

            const debtContract = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, signer);
            await debtContract.transfer(safeAddress, debtBefore + ethers.parseUnits("1", 6));

            const moduleContract = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, operator);
            const collateralAmount = await aaveHelper.getCollateralAmount(cbETH_ADDRESS, safeAddress);

            const exitTx = await moduleContract.exit(
                Protocols.AAVE_V3,
                USDC_ADDRESS,
                ethers.MaxUint256,
                [{ asset: cbETH_ADDRESS, amount: collateralAmount }],
                safeAddress,
                "0x",
                false,
                { gasLimit: "2000000" },
            );
            await exitTx.wait();

            const debtAfter = await aaveHelper.getDebtAmount(USDC_ADDRESS, safeAddress);
            expect(debtAfter).to.equal(0);

            const collateralInProtocol = await aaveHelper.getCollateralAmount(cbETH_ADDRESS, safeAddress);
            expect(collateralInProtocol).to.be.gt(0);

            const collateralContract = new ethers.Contract(cbETH_ADDRESS, ERC20_ABI, signer);
            const collateralBalanceBefore = await collateralContract.balanceOf(safeAddress);

            const withdrawTx = await moduleContract.exit(
                Protocols.AAVE_V3,
                USDC_ADDRESS,
                0n,
                [{ asset: cbETH_ADDRESS, amount: collateralInProtocol }],
                safeAddress,
                "0x",
                true,
                { gasLimit: "2000000" },
            );
            const receipt = await withdrawTx.wait();

            const exitEvent = receipt!.logs.find((log: any) => {
                try {
                    const parsed = moduleContract.interface.parseLog({ topics: [...log.topics], data: log.data });
                    return parsed?.name === "DebtPositionExited";
                } catch {
                    return false;
                }
            });
            expect(exitEvent).to.not.be.undefined;

            const collateralBalanceAfter = await collateralContract.balanceOf(safeAddress);
            expect(collateralBalanceAfter).to.be.gt(collateralBalanceBefore);

            const collateralInProtocolAfter = await aaveHelper.getCollateralAmount(cbETH_ADDRESS, safeAddress);
            expect(collateralInProtocolAfter).to.be.closeTo(0n, ethers.parseEther("0.0001"));
        });

        it("Should revert exit with debtAmount=0 when withdrawCollateral=false", async function () {
            const vaultAddress = FLUID_cbETH_USDC_VAULT;
            const fluidHelper = new FluidHelper(signer);

            await time.increaseTo((await time.latest()) + 3600);
            await fundSignerWithETH(operator.address, "0.01");

            await supplyAndBorrowOnFluid();

            const collateralAmount = await fluidHelper.getCollateralAmount(cbETH_ADDRESS, safeAddress);
            const nftId = await fluidHelper.getNftId(vaultAddress, safeAddress);
            const extraData = ethers.AbiCoder.defaultAbiCoder().encode(
                ["address", "uint256", "bool"],
                [vaultAddress, nftId, true],
            );

            const moduleContract = await ethers.getContractAt("SafeDebtManager", safeModuleAddress, operator);

            await expect(
                moduleContract.exit(
                    Protocols.FLUID,
                    USDC_ADDRESS,
                    0n,
                    [{ asset: cbETH_ADDRESS, amount: collateralAmount }],
                    safeAddress,
                    extraData,
                    false,
                    { gasLimit: "2000000" },
                ),
            ).to.be.revertedWith("Debt amount below minimum threshold");
        });
    });
});
