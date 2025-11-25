import { ethers } from "hardhat";
import { Protocols, WETH_ADDRESS } from "./constants";
import { abi as ERC20_ABI } from "@openzeppelin/contracts/build/contracts/ERC20.json";
import { MaxUint256 } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import WETH_ABI from "../externalAbi/weth.json";

import { AaveV3Helper } from "./protocols/aaveV3";
import { CompoundHelper } from "./protocols/compound";
import { MorphoHelper } from "./protocols/morpho";
import { MoonwellHelper } from "./protocols/moonwell";
import { FluidHelper } from "./protocols/fluid";
import axios from "axios";

export const protocolHelperMap = new Map<Protocols, any>([
    [Protocols.AAVE_V3, AaveV3Helper],
    [Protocols.COMPOUND, CompoundHelper],
    [Protocols.MORPHO, MorphoHelper],
    [Protocols.FLUID, FluidHelper],
    [Protocols.MOONWELL, MoonwellHelper],
]);

export const defaultProvider = new ethers.JsonRpcProvider("https://base.llamarpc.com");

export async function approve(tokenAddress: string, spenderAddress: string, signer: any) {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
    const approveTx = await token.approve(spenderAddress, MaxUint256);
    await approveTx.wait();
    console.log("approve:" + tokenAddress + "token to " + spenderAddress);
}

export async function getDecimals(tokenAddress: string): Promise<number> {
    const provider = new ethers.JsonRpcProvider("https://base.llamarpc.com");

    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, provider);
    return await tokenContract.decimals();
}

export function getAmountInMax(amountOut: bigint): bigint {
    // Suppose 1% slippage is allowed. must be fetched from quote to get actual slippage
    const slippage = 1.01;
    const scaleFactor = 100n;
    const multiplier = BigInt(slippage * Number(scaleFactor));
    return (amountOut * multiplier) / scaleFactor;
}

export function formatAmount(amount: bigint): string {
    return ethers.formatUnits(String(amount), 6);
}

export async function wrapETH(amountIn: string, signer: HardhatEthersSigner) {
    const wethContract = new ethers.Contract(WETH_ADDRESS, WETH_ABI, signer);

    const amount = ethers.parseEther(amountIn);
    const tx = await wethContract.deposit({ value: amount });
    await tx.wait();
    console.log("Wrapped ETH to WETH:", amount);
}

export async function getParaswapData(
    destToken: string,
    srcToken: string,
    contractAddress: string,
    amount: bigint,
    // 0.01% fee by default
    flashloanFee = 1n,
) {
    const url = "https://api.paraswap.io/swap";

    // suppose flashloan fee is 0.05%, must be fetched dynamically
    // use the Ceiling Division formula
    const amountPlusFee = amount + (amount * flashloanFee + 9999n) / 10000n;

    // deal with debt amount is slightly increased after getting quote from Dex aggregator
    const amountPlusBuffer = (BigInt(amountPlusFee) * 101n) / 100n;
    console.log("amountPlusBuffer:", amountPlusBuffer);

    const srcDecimals = await getDecimals(srcToken);
    const destDecimals = await getDecimals(destToken);

    const params = {
        srcToken,
        srcDecimals,
        destToken,
        destDecimals,
        // destToken amount
        amount: amountPlusBuffer,
        // side must be BUY to use exactAmountOutSwap
        side: "BUY",
        network: "8453",
        // 2% slippage, should be passed by user dynamically
        slippage: "200",
        userAddress: contractAddress,
        // exclude Uniswap V3 to avoid conflict with flashloan pool. More sophisticated mechanism should be implemented
        excludeDEXS: "UniswapV3,BalancerV3,UniswapV2",
        version: 6.2,
    };

    try {
        const response = await axios.get(url, { params });
        if (!response?.data?.txParams || !response?.data?.priceRoute) {
            throw new Error("Invalid response from ParaSwap API");
        }

        console.log("selected dex:", response.data.priceRoute.bestRoute[0].swaps[0].swapExchanges[0].exchange);

        // add 2% slippage(must be set by user)
        const amountPlusSlippage = (BigInt(response.data.priceRoute.srcAmount) * 1020n) / 1000n;

        console.log("amountPlusSlippage:", amountPlusSlippage);

        return {
            srcAmount: amountPlusSlippage,
            swapData: response.data.txParams.data,
        };
    } catch (error) {
        console.error("Error fetching data from ParaSwap API:", error);
        throw new Error("Failed to fetch ParaSwap data");
    }
}

export async function fundETH(receiverAddress: string) {
    const wallet = new ethers.Wallet(process.env.PRIVATE_KEY!, ethers.provider); // Replace with a funded Hardhat account

    const tx = await wallet.sendTransaction({
        to: receiverAddress,
        value: ethers.parseEther("0.001"),
    });

    console.log("Transaction Hash:", tx.hash);

    const balance = await ethers.provider.getBalance(receiverAddress);
    console.log(`Balance:`, ethers.formatEther(balance), "ETH");
}
