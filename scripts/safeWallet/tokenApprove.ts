import Safe from "@safe-global/protocol-kit";
import { MetaTransactionData, OperationType } from "@safe-global/types-kit";
import dotenv from "dotenv";
dotenv.config();
import { abi as ERC20_ABI } from "@openzeppelin/contracts/build/contracts/ERC20.json";
import { ethers } from "ethers";

const cbETH_ADDRESS = "0x2Ae3F1Ec7F1F5012CFEab0185bfc7aa3cf0DEc22";
const AAVE_V3_POOL_ADDRESS = "0xA238Dd80C259a72e81d7e4664a9801593F98d1c5";

async function main() {
    const safeWallet = await Safe.init({
        provider: "https://base.llamarpc.com",
        signer: process.env.TESTING_SAFE_OWNER_KEY!,
        safeAddress: "0x169EeC0c73a76a520e4cFd8Bb982c5237C3f4977",
    });

    const signer = new ethers.Wallet(process.env.TESTING_SAFE_OWNER_KEY!);

    const cbETHContract = new ethers.Contract(cbETH_ADDRESS, ERC20_ABI, signer);

    const approveTransactionData: MetaTransactionData = {
        to: cbETH_ADDRESS,
        value: "0",
        data: cbETHContract.interface.encodeFunctionData("approve", [AAVE_V3_POOL_ADDRESS, ethers.parseEther("1")]),
        operation: OperationType.Call,
    };

    const safeTransaction = await safeWallet.createTransaction({
        transactions: [approveTransactionData],
    });

    const safeTxHash = await safeWallet.executeTransaction(safeTransaction);

    console.log("Safe transaction hash:", safeTxHash);
}

main().catch((error) => {
    console.error("Error executing Safe:", error);
});
