import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import {
    UNISWAP_V3_FACTORY_ADDRESS,
    UNISWAP_V3_NPM_ADDRESS,
    UNISWAP_V3_SWAP_ROUTER_ADDRESS,
    USDC_ADDRESS,
    WETH_ADDRESS,
} from "../../contractAddresses";

/**
 * Standalone deployment module for RateHopperPositions.
 *
 * RateHopperPositions reads `safeOperator` from an already-deployed
 * ProtocolRegistry, so its address is passed in (not redeployed) — either
 * via the `registry` module parameter or the `RHP_REGISTRY` env var.
 *
 * Environment variables:
 *  - RHP_REGISTRY:           ProtocolRegistry address (required)
 *  - RHP_TREASURY:           Treasury address that collects fees (required)
 *  - RHP_INITIAL_OWNER:      Owner of the contract (required)
 *  - RHP_FEE_COLLECT_BPS:    Fee on harvested LP fees in bps (default 250 = 2.5%)
 *  - RHP_MAX_FEE_BPS:        Hard upper bound on feeCollectBps (default 2000 = 20%)
 *  - DEPLOYER_PRIVATE_KEY:   Deployer key (set in hardhat.config.ts)
 *
 * Usage:
 *   npx hardhat ignition deploy ignition/modules/DeployRateHopperPositions.ts \
 *     --network base --verify
 */
export default buildModule("DeployRateHopperPositions", (m) => {
    const registry = m.getParameter<string>(
        "registry",
        process.env.RHP_REGISTRY ?? "",
    );
    const treasury = m.getParameter<string>("treasury", process.env.RHP_TREASURY ?? "");
    const initialOwner = m.getParameter<string>(
        "initialOwner",
        process.env.RHP_INITIAL_OWNER ?? "",
    );
    const feeCollectBps = m.getParameter<number>(
        "feeCollectBps",
        Number(process.env.RHP_FEE_COLLECT_BPS ?? 250),
    );
    const maxFeeBps = m.getParameter<number>(
        "maxFeeBps",
        Number(process.env.RHP_MAX_FEE_BPS ?? 2000),
    );

    const rateHopperPositions = m.contract("RateHopperPositions", [
        UNISWAP_V3_NPM_ADDRESS,
        registry,
        USDC_ADDRESS,
        WETH_ADDRESS,
        UNISWAP_V3_SWAP_ROUTER_ADDRESS,
        UNISWAP_V3_FACTORY_ADDRESS,
        treasury,
        feeCollectBps,
        maxFeeBps,
        initialOwner,
    ]);

    return { rateHopperPositions };
});
