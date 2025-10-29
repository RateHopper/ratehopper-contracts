import hre from "hardhat";
import { WETH_ADDRESS } from "../test/constants";

async function main() {
    const contractAddress = "0xa34FE914Cf16005cEeBDAfa3Ce3026698fA44Bb7";

    const constructorArguments = [
        WETH_ADDRESS, // WETH address on Base network
    ];

    console.log("Verifying ProtocolRegistry contract at:", contractAddress);
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
