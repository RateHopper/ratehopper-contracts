import { sepolia, base, hardhat } from "viem/chains";
import { createPublicClient, http } from "viem";
import { ethers } from "ethers";
import dotenv from "dotenv";
dotenv.config();
import Safe, {
    PredictedSafeProps,
    SafeAccountConfig,
    SafeDeploymentConfig,
} from "@safe-global/protocol-kit";
import { TEST_ADDRESS } from "../test/constants";

async function main() {
    const safeAccountConfig: SafeAccountConfig = {
        owners: [TEST_ADDRESS],
        threshold: 1,
        // More optional properties
    };

    const predictedSafe: PredictedSafeProps = {
        safeAccountConfig,
        // More optional properties
    };

    const protocolKit = await Safe.init({
        // provider: "https://ethereum-sepolia-rpc.publicnode.com",
        // provider: sepolia.rpcUrls.default.http[0],
        // provider: base.rpcUrls.default.http[0],
        provider: hardhat.rpcUrls.default.http[0],
        signer: process.env.PRIVATE_KEY,
        predictedSafe,
    });

    const safeAddress = await protocolKit.getAddress();
    console.log("Safe address:", safeAddress);

    const deploymentTransaction = await protocolKit.createSafeDeploymentTransaction();

    const client = await protocolKit.getSafeProvider().getExternalSigner();

    const transactionHash = await client!.sendTransaction({
        to: deploymentTransaction.to,
        value: BigInt(deploymentTransaction.value),
        data: deploymentTransaction.data as `0x${string}`,
        // chain: sepolia,
        chain: base,
    });

    console.log("Transaction hash:", transactionHash);

    // const transactionReceipt = await client!.waitForTransactionReceipt({
    //     hash: transactionHash,
    // });
}

main().catch((error) => {
    console.error("Error executing Safe:", error);
});
