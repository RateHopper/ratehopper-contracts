import hre from "hardhat";
import { ethers } from "hardhat";
import {
    AAVE_V3_DATA_PROVIDER_ADDRESS,
    AAVE_V3_POOL_ADDRESS,
    cbBTC_ADDRESS,
    cbETH_ADDRESS,
    DAI_ADDRESS,
    EURC_ADDRESS,
    MAI_ADDRESS,
    PARASWAP_V6_CONTRACT_ADDRESS,
    Protocols,
    sUSDS_ADDRESS,
    UNISWAP_V3_FACTORY_ADDRESS,
    USDbC_ADDRESS,
    USDC_ADDRESS,
    USDS_ADDRESS,
    WETH_ADDRESS,
    wstETH_ADDRESS,
} from "./constants";
import { MORPHO_ADDRESS } from "./protocols/morpho";
import { COMPTROLLER_ADDRESS } from "./protocols/moonwell";
import { deployProtocolRegistry } from "./deployProtocolRegistry";

async function deployMaliciousContract() {
    const [_, maliciousAddress] = await ethers.getSigners();
    const MaliciousContract = await hre.ethers.getContractFactory("MaliciousContract");
    const maliciousContract = await MaliciousContract.deploy(maliciousAddress.address);
    await maliciousContract.waitForDeployment();
    console.log("MaliciousContract deployed to:", await maliciousContract.getAddress());
    return maliciousContract;
}

export async function deployMaliciousUniswapV3Pool(targetHandler: string) {
    const MaliciousUniswapV3Pool = await hre.ethers.getContractFactory("MaliciousUniswapV3Pool");
    const gasOptions = await getGasOptions();
    const maliciousPool = await MaliciousUniswapV3Pool.deploy(
        USDC_ADDRESS, // token0
        DAI_ADDRESS, // token1
        3000, // fee (0.3%)
        targetHandler, // target handler address
        gasOptions,
    );
    await maliciousPool.waitForDeployment();
    console.log("MaliciousUniswapV3Pool deployed to:", await maliciousPool.getAddress());
    return maliciousPool;
}

export async function deployHandlers() {
    const protocolRegistry = await deployProtocolRegistry();
    const registryAddress = await protocolRegistry.getAddress();

    const gasOptions = await getGasOptions();

    const AaveV3Handler = await hre.ethers.getContractFactory("AaveV3Handler");
    const aaveV3Handler = await AaveV3Handler.deploy(
        AAVE_V3_POOL_ADDRESS,
        AAVE_V3_DATA_PROVIDER_ADDRESS,
        UNISWAP_V3_FACTORY_ADDRESS,
        registryAddress,
        gasOptions,
    );
    await aaveV3Handler.waitForDeployment();
    console.log("AaveV3Handler deployed to:", await aaveV3Handler.getAddress());

    const CompoundHandler = await hre.ethers.getContractFactory("CompoundHandler");
    const compoundHandler = await CompoundHandler.deploy(registryAddress, UNISWAP_V3_FACTORY_ADDRESS, gasOptions);
    await compoundHandler.waitForDeployment();
    console.log("CompoundHandler deployed to:", await compoundHandler.getAddress());

    const MoonwellHandler = await hre.ethers.getContractFactory("MoonwellHandler");
    const moonwellHandler = await MoonwellHandler.deploy(
        COMPTROLLER_ADDRESS,
        UNISWAP_V3_FACTORY_ADDRESS,
        registryAddress,
        gasOptions,
    );
    await moonwellHandler.waitForDeployment();
    console.log("MoonwellHandler deployed to:", await moonwellHandler.getAddress());

    const FluidHandler = await hre.ethers.getContractFactory("FluidSafeHandler");
    const fluidHandler = await FluidHandler.deploy(UNISWAP_V3_FACTORY_ADDRESS, registryAddress, gasOptions);
    await fluidHandler.waitForDeployment();
    console.log("FluidHandler deployed to:", await fluidHandler.getAddress());

    const MorphoHandler = await hre.ethers.getContractFactory("MorphoHandler");
    const morphoHandler = await MorphoHandler.deploy(
        MORPHO_ADDRESS,
        UNISWAP_V3_FACTORY_ADDRESS,
        registryAddress,
        gasOptions,
    );
    await morphoHandler.waitForDeployment();
    console.log("MorphoHandler deployed to:", await morphoHandler.getAddress());

    const whitelistTokens = [
        USDC_ADDRESS,
        DAI_ADDRESS,
        USDbC_ADDRESS,
        MAI_ADDRESS,
        WETH_ADDRESS,
        cbBTC_ADDRESS,
        cbETH_ADDRESS,
        USDS_ADDRESS,
        EURC_ADDRESS,
        sUSDS_ADDRESS,
        wstETH_ADDRESS,
    ];

    const registryWhitelistTx = await protocolRegistry.addToWhitelistBatch(whitelistTokens);
    await registryWhitelistTx.wait();

    return {
        aaveV3Handler,
        compoundHandler,
        moonwellHandler,
        fluidHandler,
        morphoHandler,
        protocolRegistry,
    };
}

// We define a fixture to reuse the same setup in every test.
// We use loadFixture to run this setup once, snapshot that state,
// and reset Hardhat Network to that snapshot in every test.
export async function deployDebtSwapContractWithMaliciousHandlerFixture() {
    const maliciousContract = await deployMaliciousContract();
    const { protocolRegistry } = await deployHandlers();
    const DebtSwap = await hre.ethers.getContractFactory("DebtSwap");
    const debtSwapMalicious = await DebtSwap.deploy(
        UNISWAP_V3_FACTORY_ADDRESS,
        await protocolRegistry.getAddress(),
        [Protocols.AAVE_V3],
        [await maliciousContract.getAddress()],
        await getGasOptions(),
    );
    console.log("DebtSwapMalicious deployed to:", await debtSwapMalicious.getAddress());

    return debtSwapMalicious;
}

// We define a fixture to reuse the same setup in every test.
// We use loadFixture to run this setup once, snapshot that state,
// and reset Hardhat Network to that snapshot in every test.
export async function deployDebtSwapContractFixture() {
    const { aaveV3Handler, compoundHandler, moonwellHandler, fluidHandler, morphoHandler, protocolRegistry } =
        await deployHandlers();
    const DebtSwap = await hre.ethers.getContractFactory("DebtSwap");
    const debtSwap = await DebtSwap.deploy(
        UNISWAP_V3_FACTORY_ADDRESS,
        await protocolRegistry.getAddress(),
        [Protocols.AAVE_V3, Protocols.COMPOUND, Protocols.MORPHO],
        [await aaveV3Handler.getAddress(), await compoundHandler.getAddress(), await morphoHandler.getAddress()],
        await getGasOptions(),
    );
    await debtSwap.waitForDeployment();
    console.log("DebtSwap deployed to:", await debtSwap.getAddress());

    return debtSwap;
}

export async function deployLeveragedPositionContractFixture() {
    // Contracts are deployed using the first signer/account by default
    const { aaveV3Handler, compoundHandler, moonwellHandler, fluidHandler, morphoHandler, protocolRegistry } =
        await deployHandlers();

    const signers = await ethers.getSigners();
    const pauser = signers[3]; // Use fourth signer as pauser

    const LeveragedPosition = await hre.ethers.getContractFactory("LeveragedPosition");
    const leveragedPosition = await LeveragedPosition.deploy(
        await protocolRegistry.getAddress(),
        [Protocols.AAVE_V3, Protocols.COMPOUND, Protocols.MORPHO, Protocols.MOONWELL, Protocols.FLUID],
        [
            await aaveV3Handler.getAddress(),
            await compoundHandler.getAddress(),
            await morphoHandler.getAddress(),
            await moonwellHandler.getAddress(),
            await fluidHandler.getAddress(),
        ],
        pauser.address, // Add pauser address
        await getGasOptions(),
    );

    console.log("LeveragedPosition deployed to:", await leveragedPosition.getAddress());

    console.log("Pauser set to:", pauser.address);

    return leveragedPosition;
}

export async function deploySafeContractFixture() {
    const [owner, _, __, pauser] = await ethers.getSigners();

    const { aaveV3Handler, compoundHandler, moonwellHandler, fluidHandler, morphoHandler, protocolRegistry } =
        await deployHandlers();

    const SafeModule = await hre.ethers.getContractFactory("SafeDebtManager");
    const safeModule = await SafeModule.deploy(
        await protocolRegistry.getAddress(),
        [Protocols.AAVE_V3, Protocols.COMPOUND, Protocols.MORPHO, Protocols.MOONWELL, Protocols.FLUID],
        [
            await aaveV3Handler.getAddress(),
            await compoundHandler.getAddress(),
            await morphoHandler.getAddress(),
            await moonwellHandler.getAddress(),
            await fluidHandler.getAddress(),
        ],
        pauser.address,
        await getGasOptions(),
    );

    console.log("SafeModule deployed to:", await safeModule.getAddress());

    return { safeModule, protocolRegistry };
}

export async function getGasOptions() {
    const feeData = await ethers.provider.getFeeData();
    // Fallbacks in case values are undefined
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? ethers.parseUnits("1", "gwei");
    const baseFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice ?? ethers.parseUnits("1", "gwei");
    // Add a buffer (e.g. +20%) to avoid being too close to the base fee
    const maxFeePerGas = (baseFeePerGas * 12n) / 10n + maxPriorityFeePerGas;
    return {
        maxFeePerGas,
        maxPriorityFeePerGas,
    };
}
