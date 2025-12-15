import * as ethersLib from "ethers";
import { getEthers } from "./testSetup.js";
import { mcbETH, mUSDC, mDAI } from "./protocols/moonwell.js";
import {
    cbETH_ADDRESS,
    USDC_ADDRESS,
    DAI_ADDRESS,
    WETH_ADDRESS,
    cbBTC_ADDRESS,
    USDS_ADDRESS,
    AERO_ADDRESS,
    weETH_ADDRESS,
    EURC_ADDRESS,
    wstETH_ADDRESS,
    PARASWAP_V6_CONTRACT_ADDRESS,
    UNISWAP_V3_FACTORY_ADDRESS,
} from "./constants.js";
import { USDC_COMET_ADDRESS, WETH_COMET_ADDRESS } from "./protocols/compound.js";
import { mAERO, mcbBTC, mEURC, mWeETH, mWETH, mwstETH, USDS_COMET_ADDRESS } from "../contractAddresses.js";
import { getGasOptions } from "./deployUtils.js";
import { FLUID_VAULT_RESOLVER } from "./protocols/fluid.js";

export async function deployProtocolRegistry() {
    const ethers = getEthers();
    const signers = await ethers.getSigners();
    const deployer = signers[0];
    const operator = signers[2];
    const gasOptions = await getGasOptions();

    // Deploy TimelockController first
    // In Hardhat 3, we use the wrapper contract from Imports.sol
    const TimelockController = await ethers.getContractFactory("TimelockControllerForTest");
    const timelock = await TimelockController.deploy(
        0, // 0 delay for testing
        [deployer.address], // proposers
        [deployer.address], // executors
        ethersLib.ZeroAddress, // no admin
    );
    await timelock.waitForDeployment();
    console.log("TimelockController deployed to:", await timelock.getAddress());

    // Deploy ProtocolRegistry with timelock address and initial values
    const ProtocolRegistry = await ethers.getContractFactory("ProtocolRegistry");
    const protocolRegistry = await ProtocolRegistry.deploy(
        WETH_ADDRESS,
        UNISWAP_V3_FACTORY_ADDRESS,
        deployer.address, // initial admin
        await timelock.getAddress(), // timelock
        operator.address, // initial operator (signers[2])
        PARASWAP_V6_CONTRACT_ADDRESS, // initial paraswap
        gasOptions,
    );

    console.log("ProtocolRegistry deployed to:", await protocolRegistry.getAddress());

    const registry = await ethers.getContractAt("ProtocolRegistry", await protocolRegistry.getAddress());

    // Note: CRITICAL_ROLE is automatically granted to timelock in constructor
    // Initial operator and paraswap are set in constructor
    console.log("CRITICAL_ROLE granted to TimelockController");
    console.log("Initial operator set to:", operator.address);
    console.log("Initial Paraswap V6 set to:", PARASWAP_V6_CONTRACT_ADDRESS);

    // Set Moonwell token mappings using batch function
    await registry.batchSetTokenMContracts(
        [
            cbETH_ADDRESS,
            cbBTC_ADDRESS,
            USDC_ADDRESS,
            DAI_ADDRESS,
            WETH_ADDRESS,
            AERO_ADDRESS,
            weETH_ADDRESS,
            EURC_ADDRESS,
            wstETH_ADDRESS,
        ],
        [mcbETH, mcbBTC, mUSDC, mDAI, mWETH, mAERO, mWeETH, mEURC, mwstETH],
    );

    console.log("Moonwell token mappings set in ProtocolRegistry");

    // Add Compound mappings using batch function
    await registry.batchSetTokenCContracts(
        [USDC_ADDRESS, WETH_ADDRESS, USDS_ADDRESS],
        [USDC_COMET_ADDRESS, WETH_COMET_ADDRESS, USDS_COMET_ADDRESS],
    );
    console.log("Compound token mappings set in ProtocolRegistry");

    // Set Fluid vault resolver
    await registry.setFluidVaultResolver(FLUID_VAULT_RESOLVER);
    console.log("Fluid vault resolver set in ProtocolRegistry");

    // Note: Paraswap V6 and operator are already set in constructor
    // No need to call through timelock for initial setup

    return registry;
}
