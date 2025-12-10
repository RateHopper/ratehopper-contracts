import Safe from "@safe-global/protocol-kit";
import { MetaTransactionData, OperationType } from "@safe-global/types-kit";
import dotenv from "dotenv";
dotenv.config();
import { ethers } from "ethers";
import cometAbi from "../../externalAbi/compound/comet.json";
import { USDbC_COMET_ADDRESS } from "../../contractAddresses";

const safeAddress = "0x169EeC0c73a76a520e4cFd8Bb982c5237C3f4977";
const safeModuleAddress = "0xA75b7691FF816122804e0Ed09a24590243CF7617";

async function main() {
    const safeWallet = await Safe.init({
        provider: "https://base.llamarpc.com",
        signer: process.env.TESTING_SAFE_OWNER_KEY!,
        safeAddress,
    });

    const signer = new ethers.Wallet(process.env.TESTING_SAFE_OWNER_KEY!);

    const comet = new ethers.Contract(USDbC_COMET_ADDRESS, cometAbi, signer);

    const allowTransactionData: MetaTransactionData = {
        to: USDbC_COMET_ADDRESS,
        value: "0",
        data: comet.interface.encodeFunctionData("allow", [safeModuleAddress, true]),
        operation: OperationType.Call,
    };

    const safeTransaction = await safeWallet.createTransaction({
        transactions: [allowTransactionData],
    });

    const safeTxHash = await safeWallet.executeTransaction(safeTransaction);

    console.log("Safe transaction hash:", safeTxHash);
}

main().catch((error) => {
    console.error("Error executing Safe:", error);
});
