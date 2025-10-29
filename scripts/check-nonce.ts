import { ethers } from "hardhat";

async function main() {
    const [deployer] = await ethers.getSigners();
    const address = await deployer.getAddress();

    const nonce = await ethers.provider.getTransactionCount(address, "latest");
    const pendingNonce = await ethers.provider.getTransactionCount(address, "pending");

    console.log(`Deployer address: ${address}`);
    console.log(`Latest nonce: ${nonce}`);
    console.log(`Pending nonce: ${pendingNonce}`);
    console.log(`Pending transactions: ${pendingNonce - nonce}`);
}

main().catch(console.error);
