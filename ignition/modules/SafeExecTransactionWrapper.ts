import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

/**
 * Module to deploy SafeExecTransactionWrapper contract
 *
 * This wrapper contract ensures that Safe's execTransaction calls revert on failure
 * instead of silently returning false (useful for older Safe versions).
 *
 * Usage:
 * npx hardhat ignition deploy ignition/modules/SafeExecTransactionWrapper.ts --network base --verify
 */
export default buildModule("SafeExecTransactionWrapper", (m) => {
    const safeExecTransactionWrapper = m.contract("SafeExecTransactionWrapper");

    return { safeExecTransactionWrapper };
});
