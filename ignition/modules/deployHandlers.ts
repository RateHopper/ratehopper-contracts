import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import { UNISWAP_V3_FACTORY_ADRESS } from "./constants";

// Define constants
const AAVE_V3_POOL_ADDRESS = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";
const AAVE_V3_DATA_PROVIDER_ADDRESS = "0xd82a47fdebB5bf5329b09441C3DaB4b5df2153Ad";
const MORPHO_ADDRESS = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
const COMPTROLLER_ADDRESS = "0xfbb21d0380bee3312b33c4353c8936a0f13ef26c";

// Handler modules that accept registry address as parameter
export const AaveV3Module = buildModule("AaveV3Handler", (m) => {
    const registryAddress = m.getParameter("registryAddress");

    const aaveV3Handler = m.contract("AaveV3Handler", [
        AAVE_V3_POOL_ADDRESS,
        AAVE_V3_DATA_PROVIDER_ADDRESS,
        UNISWAP_V3_FACTORY_ADRESS,
        registryAddress,
    ]);

    return { aaveV3Handler };
});

export const CompoundModule = buildModule("CompoundHandler", (m) => {
    const registryAddress = m.getParameter("registryAddress");

    const compoundHandler = m.contract("CompoundHandler", [
        registryAddress,
        UNISWAP_V3_FACTORY_ADRESS
    ]);

    return { compoundHandler };
});

export const MorphoModule = buildModule("MorphoHandler", (m) => {
    const registryAddress = m.getParameter("registryAddress");

    const morphoHandler = m.contract("MorphoHandler", [
        MORPHO_ADDRESS,
        UNISWAP_V3_FACTORY_ADRESS,
        registryAddress
    ]);

    return { morphoHandler };
});

export const FluidSafeModule = buildModule("FluidSafeHandler", (m) => {
    const registryAddress = m.getParameter("registryAddress");

    const fluidSafeHandler = m.contract("FluidSafeHandler", [
        UNISWAP_V3_FACTORY_ADRESS,
        registryAddress
    ]);

    return { fluidSafeHandler };
});

export const MoonwellModule = buildModule("MoonwellHandler", (m) => {
    const registryAddress = m.getParameter("registryAddress");

    const moonwellHandler = m.contract("MoonwellHandler", [
        COMPTROLLER_ADDRESS,
        UNISWAP_V3_FACTORY_ADRESS,
        registryAddress
    ]);

    return { moonwellHandler };
});

// Comprehensive module to deploy all handlers
export const AllHandlersModule = buildModule("AllHandlers", (m) => {
    const registryAddress = m.getParameter("registryAddress");

    const aaveV3Handler = m.contract("AaveV3Handler", [
        AAVE_V3_POOL_ADDRESS,
        AAVE_V3_DATA_PROVIDER_ADDRESS,
        UNISWAP_V3_FACTORY_ADRESS,
        registryAddress,
    ]);

    const compoundHandler = m.contract("CompoundHandler", [
        registryAddress,
        UNISWAP_V3_FACTORY_ADRESS
    ]);

    const morphoHandler = m.contract("MorphoHandler", [
        MORPHO_ADDRESS,
        UNISWAP_V3_FACTORY_ADRESS,
        registryAddress
    ]);

    const fluidSafeHandler = m.contract("FluidSafeHandler", [
        UNISWAP_V3_FACTORY_ADRESS,
        registryAddress
    ]);

    const moonwellHandler = m.contract("MoonwellHandler", [
        COMPTROLLER_ADDRESS,
        UNISWAP_V3_FACTORY_ADRESS,
        registryAddress
    ]);

    return {
        aaveV3Handler,
        compoundHandler,
        morphoHandler,
        fluidSafeHandler,
        moonwellHandler
    };
});

export const SafeDebtManagerModule = buildModule("SafeDebtManager", (m) => {
    const protocols = m.getParameter("protocols");
    const handlers = m.getParameter("handlers");
    const pauserAddress = m.getParameter("pauserAddress");
    const paraswapAddress = m.getParameter("paraswapAddress");
    const operatorAddress = m.getParameter("operatorAddress");

    const safeDebtManager = m.contract("SafeDebtManager", [
        UNISWAP_V3_FACTORY_ADRESS,
        protocols,
        handlers,
        pauserAddress,
    ]);

    // Set Paraswap addresses
    m.call(safeDebtManager, "setParaswapAddresses", [paraswapAddress, paraswapAddress]);

    // Set operator
    m.call(safeDebtManager, "setoperator", [operatorAddress]);

    return { safeDebtManager };
});