import Safe from "@safe-global/protocol-kit";
import { MetaTransactionData, OperationType } from "@safe-global/types-kit";
import dotenv from "dotenv";
dotenv.config();
import { ethers } from "ethers";
import { abi as ERC20_ABI } from "@openzeppelin/contracts/build/contracts/ERC20.json";

const safeAddress = "0x169EeC0c73a76a520e4cFd8Bb982c5237C3f4977";
const safeModuleAddress = "0x85C434815d00352BBab9a90b884D1c299aEf9969";

// Aave: aBascbETH Token
const aTokenAddress = "0xcf3D55c10DB69f28fD1A75Bd73f3D8A2d9c595ad";

async function main() {
    const safeWallet = await Safe.init({
        provider: "https://base.llamarpc.com",
        signer: process.env.SAFE_OWNER_PRIVATE_KEY!,
        safeAddress,
    });

    const signer = new ethers.Wallet(process.env.SAFE_OWNER_PRIVATE_KEY!);

    const token = new ethers.Contract(aTokenAddress, ERC20_ABI, signer);

    const approveTransactionData: MetaTransactionData = {
        to: aTokenAddress,
        value: "0",
        data: token.interface.encodeFunctionData("approve", [safeModuleAddress, ethers.parseEther("1")]),
        operation: OperationType.Call,
    };

    const safeApproveTransaction = await safeWallet.createTransaction({
        transactions: [approveTransactionData],
    });

    const safeTxHash = await safeWallet.executeTransaction(safeApproveTransaction);

    console.log("Safe transaction hash:", safeTxHash);
}

main().catch((error) => {
    console.error("Error executing Safe:", error);
});
