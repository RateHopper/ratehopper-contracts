import { ethers, MaxUint256 } from "ethers";
import { constructSimpleSDK, SwapSide } from "@paraswap/sdk";
import axios from "axios";

import dotenv from "dotenv";
import { USDbC_ADDRESS, USDC_ADDRESS } from "../test/constants";
dotenv.config();

async function main() {
    const provider = new ethers.JsonRpcProvider("https://base.llamarpc.com");
    const signer = new ethers.Wallet(process.env.TESTING_SAFE_OWNER_KEY!, provider);
    const senderAddress = signer.address;

    const providerOptionsEtherV6 = {
        ethersV6ProviderOrSigner: signer,
        EthersV6Contract: ethers.Contract,
        account: senderAddress,
    };

    const paraSwap = constructSimpleSDK({ chainId: 8453, axios }, providerOptionsEtherV6);

    const amount = ethers.parseUnits("0.1", 6).toString();

    // const priceRoute = await paraSwap.swap.getRate({
    //     srcToken: USDC_ADDRESS,
    //     destToken: USDbC_ADDRESS,
    //     amount: srcAmount,
    //     userAddress: senderAddress,
    //     side: SwapSide.BUY,
    // });
    // console.log("Price Route:", priceRoute);

    const quote = await paraSwap.quote.getQuote({
        srcToken: USDC_ADDRESS,
        destToken: USDbC_ADDRESS,
        amount,
        userAddress: senderAddress,
        srcDecimals: 6,
        destDecimals: 6,
        mode: "market",
        side: SwapSide.BUY,
    });

    const txHash = await paraSwap.swap.approveToken(quote.market.srcAmount, USDC_ADDRESS);

    await provider.waitForTransaction(txHash);
    console.log("txHash:", txHash);

    const txParams = await paraSwap.swap.buildTx({
        srcToken: USDC_ADDRESS,
        srcDecimals: 6,
        destToken: USDbC_ADDRESS,
        destDecimals: 6,
        srcAmount: quote.market.srcAmount,
        destAmount: quote.market.destAmount,
        priceRoute: quote.market,
        userAddress: senderAddress,
    });

    console.log("Tx Params:", txParams);

    const transaction = {
        ...txParams,
        gasLimit: 5000000,
    };

    const tx = await signer.sendTransaction(transaction);
    await tx.wait();
    console.log("Transaction hash:", tx.hash);
}

main().catch((error) => {
    console.error("Error executing swap:", error);
});
