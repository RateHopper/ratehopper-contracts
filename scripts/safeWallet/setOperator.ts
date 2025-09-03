import dotenv from "dotenv";
import { ethers } from "ethers";
dotenv.config();

async function main() {
    const ourContractAddress = "0x3dB540120B824c0a0dfDb4CD7aDdcDa016ee63E6";
    const provider = new ethers.JsonRpcProvider("https://base.llamarpc.com");
    const signer = new ethers.Wallet(process.env.PRIVATE_KEY!, provider);

    const safeModuleAbi = ["function setoperator(address _operator)"];
    const safeModuleContract = new ethers.Contract(ourContractAddress, safeModuleAbi, signer);

    const operatorAddress = "0xE549DE35b4D370B76c0A777653aD85Aef6eb8Fa4";

    console.log(`Setting operator to ${operatorAddress}...`);
    const tx = await safeModuleContract.setoperator(operatorAddress);
    await tx.wait();
    console.log(`operator set successfully in tx: ${tx.hash}`);
}

main().catch((error) => {
    console.error("Error executing Safe:", error);
});
