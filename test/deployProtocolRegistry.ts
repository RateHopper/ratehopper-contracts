import { ethers } from "hardhat";
import { mcbETH, mUSDC, mDAI } from "./protocols/moonwell";
import {
    cbETH_ADDRESS,
    USDC_ADDRESS,
    DAI_ADDRESS,
    WETH_ADDRESS,
    USDbC_ADDRESS,
    cbBTC_ADDRESS,
    USDS_ADDRESS,
    AERO_ADDRESS,
    weETH_ADDRESS,
    EURC_ADDRESS,
    wstETH_ADDRESS,
} from "./constants";
import { USDC_COMET_ADDRESS, USDbC_COMET_ADDRESS, WETH_COMET_ADDRESS } from "./protocols/compound";
import { mAERO, mcbBTC, mEURC, mWeETH, mWETH, mwstETH, USDS_COMET_ADDRESS } from "../contractAddresses";
import { getGasOptions } from "./deployUtils";
import { FLUID_VAULT_RESOLVER } from "./protocols/fluid";

export async function deployProtocolRegistry() {
    const ProtocolRegistry = await ethers.getContractFactory("ProtocolRegistry");
    const gasOptions = await getGasOptions();
    const protocolRegistry = await ProtocolRegistry.deploy(WETH_ADDRESS, gasOptions);

    console.log("ProtocolRegistry deployed to:", await protocolRegistry.getAddress());

    const registry = await ethers.getContractAt("ProtocolRegistry", await protocolRegistry.getAddress());

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

    return registry;
}
