import Safe from "@safe-global/protocol-kit";
import dotenv from "dotenv";
dotenv.config();

async function main() {
    const ourContractAddress = "0x85C434815d00352BBab9a90b884D1c299aEf9969";
    const safeWallet = await Safe.init({
        provider: "https://base.llamarpc.com",
        signer: process.env.TESTING_SAFE_OWNER_KEY!,
        safeAddress: "0x169EeC0c73a76a520e4cFd8Bb982c5237C3f4977",
    });

    const enableModuleTx = await safeWallet.createEnableModuleTx(ourContractAddress);
    const safeTxHash = await safeWallet.executeTransaction(enableModuleTx);
    console.log("Safe enable module transaction:", safeTxHash);

    console.log("Modules:", await safeWallet.getModules());
}

main().catch((error) => {
    console.error("Error executing Safe:", error);
});
