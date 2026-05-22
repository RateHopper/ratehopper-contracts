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
 * RateHopperPositions sits on TOP of an already-deployed SafeDebtManager,
 * so its address is passed in (not redeployed) — either via the
 * `safeDebtManager` module parameter or the `RHP_SAFE_DEBT_MANAGER` env var.
 *
 * Environment variables:
 *  - RHP_SAFE_DEBT_MANAGER:  SafeDebtManager address (required)
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
    const safeDebtManager = m.getParameter<string>(
        "safeDebtManager",
        process.env.RHP_SAFE_DEBT_MANAGER ?? "",
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
        safeDebtManager,
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
