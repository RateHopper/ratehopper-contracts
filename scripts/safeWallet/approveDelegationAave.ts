import Safe from "@safe-global/protocol-kit";
import { MetaTransactionData, OperationType } from "@safe-global/types-kit";
import dotenv from "dotenv";
dotenv.config();
import { ethers, MaxUint256 } from "ethers";
import aaveProtocolDataProviderAbi from "../../externalAbi/aaveV3/aaveProtocolDataProvider.json";
import aaveDebtTokenAbi from "../../externalAbi/aaveV3/aaveDebtToken.json";

const safeAddress = "0x169EeC0c73a76a520e4cFd8Bb982c5237C3f4977";
const safeModuleAddress = "0xe551d6cd14b3b193818513267f41119a04092575";

const tokenAddress = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";

async function main() {
    const safeWallet = await Safe.init({
        provider: "https://base.llamarpc.com",
        signer: process.env.SAFE_OWNER_PRIVATE_KEY!,
        safeAddress,
    });

    // Create provider and connect signer to it
    const provider = new ethers.JsonRpcProvider("https://base.llamarpc.com");
    const signer = new ethers.Wallet(process.env.SAFE_OWNER_PRIVATE_KEY!, provider);

    const aaveV3ProtocolDataProvider = "0xd82a47fdebB5bf5329b09441C3DaB4b5df2153Ad";
    const protocolDataProvider = new ethers.Contract(aaveV3ProtocolDataProvider, aaveProtocolDataProviderAbi, signer);
    const response = await protocolDataProvider.getReserveTokensAddresses(tokenAddress);
    const debtTokenAddress = response.variableDebtTokenAddress;

    const debtTokenContract = new ethers.Contract(debtTokenAddress, aaveDebtTokenAbi, signer);

    const approveTransactionData: MetaTransactionData = {
        to: debtTokenAddress,
        value: "0",
        data: debtTokenContract.interface.encodeFunctionData("approveDelegation", [safeModuleAddress, MaxUint256]),
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
