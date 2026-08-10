import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";
import {
    PERMIT2_ADDRESS,
    UNISWAP_V4_POSITION_MANAGER_ADDRESS,
    UNISWAP_V4_STATE_VIEW_ADDRESS,
    UNIVERSAL_ROUTER_ADDRESS,
    USDC_ADDRESS,
} from "../../contractAddresses";
import { envString, makeRequireAddress } from "./deployHelpers";

const requireAddress = makeRequireAddress("DeployUniV4Handler");

/**
 * Deployment module for the Uniswap V4 yield handler (protocol id 2).
 *
 * Deliberately a NEW module: editing 2_DeployYieldManager.ts would invalidate
 * its recorded deployment. The handler is stateless — registering it on the
 * LIVE SafeYieldManager is a separate ops runbook (order matters; open/close
 * default to DISABLED for a new id):
 *   1. timelock (2-day delay): setYieldHandler(2, handler)
 *   2. admin:  setMinPoolLiquidity(2, ...), setMinPositionLiquidity(2, ...)
 *   3. admin:  setPoolParamAllowed(2, encodeUniV4PoolParam(...), true) per
 *              vetted pool — hooked pools ONLY after the hook is audited
 *              (the allow-list is the sole gate; the handler itself accepts
 *              any allow-listed PoolKey, hooked or native)
 *   4. pauser: setProtocolEnabledForOpen(2, true), setProtocolEnabledForClose(2, true)
 *
 * Environment variables (SYM_* module override, then unprefixed, then default):
 *  - SYM_UNIV4_POSITION_MANAGER / UNIV4_POSITION_MANAGER: V4 PositionManager.
 *  - SYM_UNIVERSAL_ROUTER / UNIVERSAL_ROUTER:             UniversalRouter.
 *  - SYM_PERMIT2 / PERMIT2:                               Permit2 (Base uses
 *                                                         0x...B43aC78BA3).
 *  - SYM_UNIV4_STATE_VIEW / UNIV4_STATE_VIEW:             StateView lens.
 *
 * Usage:
 *   npx hardhat ignition deploy ignition/modules/3_DeployUniV4Handler.ts \
 *     --network base --verify
 */
export default buildModule("DeployUniV4Handler", (m) => {
    const positionManagerAddr =
        envString("SYM_UNIV4_POSITION_MANAGER", "UNIV4_POSITION_MANAGER") || UNISWAP_V4_POSITION_MANAGER_ADDRESS;
    const universalRouterAddr = envString("SYM_UNIVERSAL_ROUTER", "UNIVERSAL_ROUTER") || UNIVERSAL_ROUTER_ADDRESS;
    const permit2Addr = envString("SYM_PERMIT2", "PERMIT2") || PERMIT2_ADDRESS;
    const stateViewAddr = envString("SYM_UNIV4_STATE_VIEW", "UNIV4_STATE_VIEW") || UNISWAP_V4_STATE_VIEW_ADDRESS;

    requireAddress("positionManager (SYM_UNIV4_POSITION_MANAGER)", positionManagerAddr);
    requireAddress("universalRouter (SYM_UNIVERSAL_ROUTER)", universalRouterAddr);
    requireAddress("permit2 (SYM_PERMIT2)", permit2Addr);
    requireAddress("stateView (SYM_UNIV4_STATE_VIEW)", stateViewAddr);

    const positionManager = m.getParameter<string>("positionManager", positionManagerAddr);
    const universalRouter = m.getParameter<string>("universalRouter", universalRouterAddr);
    const permit2 = m.getParameter<string>("permit2", permit2Addr);
    const stateView = m.getParameter<string>("stateView", stateViewAddr);

    const uniV4YieldHandler = m.contract("UniV4YieldHandler", [
        positionManager,
        universalRouter,
        permit2,
        stateView,
        USDC_ADDRESS,
    ]);

    return { uniV4YieldHandler };
});
