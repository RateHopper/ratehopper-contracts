import { DebtProtocols } from "./constants";
import { AaveV3Helper } from "./protocolsDebt/aaveV3";
import { CompoundHelper } from "./protocolsDebt/compound";
import { FluidHelper } from "./protocolsDebt/fluid";
import { MoonwellHelper } from "./protocolsDebt/moonwell";
import { MorphoHelper } from "./protocolsDebt/morpho";

// Kept separate from utils.ts because protocol helpers import utility functions.
// Defining this map in utils.ts creates a circular import and can leave a helper undefined.
export const protocolHelperMap = new Map<DebtProtocols, any>([
    [DebtProtocols.AAVE_V3, AaveV3Helper],
    [DebtProtocols.COMPOUND, CompoundHelper],
    [DebtProtocols.MORPHO, MorphoHelper],
    [DebtProtocols.FLUID, FluidHelper],
    [DebtProtocols.MOONWELL, MoonwellHelper],
]);
