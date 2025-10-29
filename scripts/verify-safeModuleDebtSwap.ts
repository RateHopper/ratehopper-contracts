const hre = require("hardhat");

async function main() {
    const contractAddress = "0x495154A68379031c5b19715cDBBF1844d4c635b5";

    // Define the constructor arguments
    const UNISWAP_V3_FACTORY_ADRESS = "0x33128a8fC17869897dcE68Ed026d694621f6FDfD";
    const protocols = [0, 1, 2, 3, 4];
    const handlers = [
        "0x7f1be446C938c9046206eCbf803405A0B7741D3f", // AaveV3Handler
        "0x2397AE142c2BFd7C3dEc242CE98f87Da172983a7", // CompoundHandler
        "0xb03B40507829d4Ec4b5681d566eA64CE0264Bf48", // MorphoHandler
        "0x7c6F6c700728F19Eba77879851b18893A39DD47a", // FluidHandler
        "0x02c4C4F99Cfa610bB6E06d8B879Be89b00C9F1dB", // MoonwellHandler
    ];
    const pauserAddress = "0x9E073c36F63BF1c611026fdA1fF6007A81932231";

    console.log("Verifying SafeModuleDebtSwap contract...");

    try {
        await hre.run("verify:verify", {
            address: contractAddress,
            constructorArguments: [UNISWAP_V3_FACTORY_ADRESS, protocols, handlers, pauserAddress],
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
