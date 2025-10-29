import hre from "hardhat";
import { UNISWAP_V3_FACTORY_ADRESS } from "../test/constants";

async function main() {
    const contractAddress = "0x7c6f6c700728f19eba77879851b18893a39dd47a";

    const constructorArguments = [
        UNISWAP_V3_FACTORY_ADRESS,
        "0xc2b45C4FCaEAE99e609Dd2aAB1684ffBbb95fDEa", // ProtocolRegistry address
    ];

    console.log("Verifying FluidSafeHandler contract at:", contractAddress);
    console.log("Constructor arguments:", JSON.stringify(constructorArguments, null, 2));

    try {
        await hre.run("verify:verify", {
            address: contractAddress,
            constructorArguments: constructorArguments,
        });
        console.log("Contract verified successfully!");
    } catch (error: any) {
        if (error.message.includes("Already Verified")) {
            console.log("Contract is already verified!");
        } else {
            console.error("Verification error:", error.message);
            throw error;
        }
    }
}

main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
