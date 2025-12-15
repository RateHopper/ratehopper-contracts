import * as ethersLib from "ethers";
import { getEthers, hre } from "./testSetup.js";
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
} from "./constants.js";
import { MORPHO_ADDRESS } from "./protocols/morpho.js";
import { COMPTROLLER_ADDRESS } from "./protocols/moonwell.js";
import { deployProtocolRegistry } from "./deployProtocolRegistry.js";
import ERC20Json from "@openzeppelin/contracts/build/contracts/ERC20.json" with { type: "json" };
const ERC20_ABI = ERC20Json.abi;

/**
 * Warm up forked contracts by reading from them.
 * This ensures they're captured in the loadFixture snapshot.
 * In Hardhat 3's EDR, forked state may not persist through snapshots
 * unless the contracts are "touched" during the fixture execution.
 */
async function warmUpForkedContracts() {
    const ethers = getEthers();
    const provider = ethers.provider;

    // List of forked contract addresses that tests depend on
    const contractsToWarmUp = [
        USDC_ADDRESS,
        USDbC_ADDRESS,
        cbETH_ADDRESS,
        cbBTC_ADDRESS,
        DAI_ADDRESS,
        WETH_ADDRESS,
        EURC_ADDRESS,
        USDS_ADDRESS,
        sUSDS_ADDRESS,
        wstETH_ADDRESS,
        MAI_ADDRESS,
        AAVE_V3_POOL_ADDRESS,
        AAVE_V3_DATA_PROVIDER_ADDRESS,
        MORPHO_ADDRESS,
        COMPTROLLER_ADDRESS,
    ];

    // Add Safe wallet address if available (used in Safe tests)
    const safeAddress = process.env.TESTING_SAFE_WALLET_ADDRESS;
    if (safeAddress) {
        contractsToWarmUp.push(safeAddress);
    }

    // Safe-related contract addresses on Base mainnet
    // These are needed for Safe SDK to work properly
    const safeContracts = [
        "0x69f4D1788e39c87893C980c06EdF4b7f686e2938", // SafeProxyFactory
        "0xfb1bffC9d739B8D520DaF37dF666da4C687191EA", // SafeL2 singleton
        "0xd53cd0aB83D845Ac265BE939c57F53AD838012c9", // CompatibilityFallbackHandler
        "0x8EcD4ec46D4D2a6B64fE960B3D64e8B94B2234eb", // MultiSendCallOnly
        "0xA1dabEF33b3B82c7814B6D82A79e50F4AC44102B", // MultiSend
    ];

    for (const address of safeContracts) {
        contractsToWarmUp.push(address);
    }

    // Read code from each address to ensure it's cached in the snapshot
    for (const address of contractsToWarmUp) {
        try {
            await provider.getCode(address);
            // Also try to call a view function on ERC20 tokens to warm up storage
            if (
                [
                    USDC_ADDRESS,
                    USDbC_ADDRESS,
                    cbETH_ADDRESS,
                    cbBTC_ADDRESS,
                    DAI_ADDRESS,
                    WETH_ADDRESS,
                    EURC_ADDRESS,
                    USDS_ADDRESS,
                    wstETH_ADDRESS,
                ].includes(address)
            ) {
                const token = new ethersLib.Contract(address, ERC20_ABI, provider);
                await token.totalSupply();
            }
        } catch {
            // Ignore errors - some addresses may not be contracts
        }
    }
}

export async function deployMaliciousUniswapV3Pool(targetHandler: string) {
    const ethers = getEthers();
    const MaliciousUniswapV3Pool = await ethers.getContractFactory("MaliciousUniswapV3Pool");
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
    const ethers = getEthers();

    // Warm up forked contracts to ensure they're captured in the snapshot
    await warmUpForkedContracts();

    const protocolRegistry = await deployProtocolRegistry();
    const registryAddress = await protocolRegistry.getAddress();

    const gasOptions = await getGasOptions();

    const AaveV3Handler = await ethers.getContractFactory("AaveV3Handler");
    const aaveV3Handler = await AaveV3Handler.deploy(
        AAVE_V3_POOL_ADDRESS,
        AAVE_V3_DATA_PROVIDER_ADDRESS,
        UNISWAP_V3_FACTORY_ADDRESS,
        registryAddress,
        gasOptions,
    );
    await aaveV3Handler.waitForDeployment();
    console.log("AaveV3Handler deployed to:", await aaveV3Handler.getAddress());

    const CompoundHandler = await ethers.getContractFactory("CompoundHandler");
    const compoundHandler = await CompoundHandler.deploy(registryAddress, UNISWAP_V3_FACTORY_ADDRESS, gasOptions);
    await compoundHandler.waitForDeployment();
    console.log("CompoundHandler deployed to:", await compoundHandler.getAddress());

    const MoonwellHandler = await ethers.getContractFactory("MoonwellHandler");
    const moonwellHandler = await MoonwellHandler.deploy(
        COMPTROLLER_ADDRESS,
        UNISWAP_V3_FACTORY_ADDRESS,
        registryAddress,
        gasOptions,
    );
    await moonwellHandler.waitForDeployment();
    console.log("MoonwellHandler deployed to:", await moonwellHandler.getAddress());

    const FluidHandler = await ethers.getContractFactory("FluidSafeHandler");
    const fluidHandler = await FluidHandler.deploy(UNISWAP_V3_FACTORY_ADDRESS, registryAddress, gasOptions);
    await fluidHandler.waitForDeployment();
    console.log("FluidHandler deployed to:", await fluidHandler.getAddress());

    const MorphoHandler = await ethers.getContractFactory("MorphoHandler");
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

// Cache for deployed contracts (avoids loadFixture snapshot issues with forked state)
let _cachedLeveragedPosition: any = null;
let _cachedSafeModule: any = null;
let _cachedProtocolRegistry: any = null;

/**
 * Reset cached contracts (call this to force redeployment)
 */
export function resetDeploymentCache() {
    _cachedLeveragedPosition = null;
    _cachedSafeModule = null;
    _cachedProtocolRegistry = null;
}

// We define a fixture to reuse the same setup in every test.
// We use loadFixture to run this setup once, snapshot that state,
// and reset Hardhat Network to that snapshot in every test.
export async function deployLeveragedPositionContractFixture() {
    const ethers = getEthers();

    // Warm up forked contracts to ensure they're captured in the snapshot
    await warmUpForkedContracts();

    // Contracts are deployed using the first signer/account by default
    const { aaveV3Handler, compoundHandler, moonwellHandler, fluidHandler, morphoHandler, protocolRegistry } =
        await deployHandlers();

    const signers = await ethers.getSigners();
    const pauser = signers[3]; // Use fourth signer as pauser

    const LeveragedPosition = await ethers.getContractFactory("LeveragedPosition");
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
    const ethers = getEthers();

    // Warm up forked contracts to ensure they're captured in the snapshot
    await warmUpForkedContracts();

    const [owner, _, __, pauser] = await ethers.getSigners();

    const { aaveV3Handler, compoundHandler, moonwellHandler, fluidHandler, morphoHandler, protocolRegistry } =
        await deployHandlers();

    const SafeModule = await ethers.getContractFactory("SafeDebtManager");
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
    const ethers = getEthers();
    const feeData = await ethers.provider.getFeeData();
    // Fallbacks in case values are undefined
    const maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? ethersLib.parseUnits("1", "gwei");
    const baseFeePerGas = feeData.maxFeePerGas ?? feeData.gasPrice ?? ethersLib.parseUnits("1", "gwei");
    // Add a buffer (e.g. +20%) to avoid being too close to the base fee
    const maxFeePerGas = (baseFeePerGas * 12n) / 10n + maxPriorityFeePerGas;
    return {
        maxFeePerGas,
        maxPriorityFeePerGas,
    };
}
