import Safe from "@safe-global/protocol-kit";
import { MetaTransactionData, OperationType } from "@safe-global/types-kit";
import dotenv from "dotenv";
dotenv.config();
import { ethers } from "ethers";
import aaveV3PoolJson from "../../externalAbi/aaveV3/aaveV3Pool.json";

const cbETH_ADDRESS = "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22";
const AAVE_V3_POOL_ADDRESS = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";

const safeAddress = "0x169EeC0c73a76a520e4cFd8Bb982c5237C3f4977";

async function main() {
    const safeWallet = await Safe.init({
        provider: "https://base.llamarpc.com",
        signer: process.env.TESTING_SAFE_OWNER_KEY!,
        safeAddress,
    });

    const signer = new ethers.Wallet(process.env.TESTING_SAFE_OWNER_KEY!);

    const aavePool = new ethers.Contract(AAVE_V3_POOL_ADDRESS, aaveV3PoolJson, signer);

    const supplyTransactionData: MetaTransactionData = {
        to: AAVE_V3_POOL_ADDRESS,
        value: "0",
        data: aavePool.interface.encodeFunctionData("supply", [
            cbETH_ADDRESS,
            ethers.parseEther("0.0001"),
            safeAddress,
            0,
        ]),
        operation: OperationType.Call,
    };

    // usdc
    const debtTokenAddress = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

    const borrowTransactionData: MetaTransactionData = {
        to: AAVE_V3_POOL_ADDRESS,
        value: "0",
        data: aavePool.interface.encodeFunctionData("borrow", [
            debtTokenAddress,
            ethers.parseUnits("0.1", 6),
            2,
            0,
            safeAddress,
        ]),
        operation: OperationType.Call,
    };

    const safeTransaction = await safeWallet.createTransaction({
        transactions: [supplyTransactionData, borrowTransactionData],
    });

    const safeTxHash = await safeWallet.executeTransaction(safeTransaction);

    console.log("Safe transaction hash:", safeTxHash);
}

main().catch((error) => {
    console.error("Error executing Safe:", error);
});
