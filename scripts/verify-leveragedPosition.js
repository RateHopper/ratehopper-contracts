const hre = require("hardhat");

async function main() {
    const contractAddress = "0xba25a6bf94ceb977ca1b4823158369463e514802";
    const UNISWAP_V3_FACTORY_ADRESS = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";

    // Define the constructor arguments
    const protocols = [0, 1, 2, 3, 4];
    const handlers = [
        "0x7f1be446C938c9046206eCbf803405A0B7741D3f", // AaveV3Handler
        "0x62AC021A02A631824B5665C6A8657B9c6e0587e6", // CompoundHandler
        "0xb03B40507829d4Ec4b5681d566eA64CE0264Bf48", // MorphoHandler
        "0x4DAF0278E9c8933685d10d159b80F13a841C8a50", // FluidHandler
        "0xaF141AB1eD50144Ff527cF0Ee5595e7D27dAb935", // MoonwellHandler
    ];

    console.log("Verifying LeveragedPosition contract...");

    try {
        await hre.run("verify:verify", {
            address: contractAddress,
            constructorArguments: [UNISWAP_V3_FACTORY_ADRESS, protocols, handlers],
        });
        console.log("Verification successful!");
    } catch (error) {
        console.error("Verification failed:", error);
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
