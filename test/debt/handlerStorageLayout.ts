import { expect } from "chai";
import { artifacts } from "hardhat";

const DELEGATECALL_HANDLERS = [
    "contracts/debt/handlers/AaveV3DebtHandler.sol:AaveV3DebtHandler",
    "contracts/debt/handlers/CompoundDebtHandler.sol:CompoundDebtHandler",
    "contracts/debt/handlers/FluidSafeDebtHandler.sol:FluidSafeDebtHandler",
    "contracts/debt/handlers/MoonwellDebtHandler.sol:MoonwellDebtHandler",
    "contracts/debt/handlers/MorphoDebtHandler.sol:MorphoDebtHandler",
    "contracts/yield/handlers/UniV3YieldHandler.sol:UniV3YieldHandler",
    "contracts/yield/handlers/AerodromeYieldHandler.sol:AerodromeYieldHandler",
    "contracts/yield/handlers/UniV4YieldHandler.sol:UniV4YieldHandler",
];

describe("Delegatecall handler storage layout", function () {
    for (const fqn of DELEGATECALL_HANDLERS) {
        it(`${fqn.split(":")[1]} declares no storage variables`, async function () {
            const buildInfo = await artifacts.getBuildInfo(fqn);
            expect(buildInfo, `build info missing for ${fqn}`).to.not.be.undefined;

            const [sourceName, contractName] = fqn.split(":");
            const layout = (buildInfo!.output.contracts[sourceName][contractName] as any).storageLayout;
            expect(layout, `storageLayout not emitted for ${fqn}`).to.not.be.undefined;
            expect(layout.storage.map((s: any) => `${s.label}@slot${s.slot}`)).to.deep.equal([]);
        });
    }
});
