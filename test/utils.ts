import * as ethersLib from "ethers";
import { Eip1193Provider, RequestArguments } from "@safe-global/protocol-kit";
import { Protocols, WETH_ADDRESS } from "./constants.js";
import ERC20Json from "@openzeppelin/contracts/build/contracts/ERC20.json" with { type: "json" };
const ERC20_ABI = ERC20Json.abi;
import { MaxUint256 } from "ethers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import WETH_ABI from "../externalAbi/weth.json" with { type: "json" };
import { getEthers } from "./testSetup.js";

import { AaveV3Helper } from "./protocols/aaveV3.js";
import { CompoundHelper } from "./protocols/compound.js";
import { MorphoHelper } from "./protocols/morpho.js";
import { MoonwellHelper } from "./protocols/moonwell.js";
import { FluidHelper } from "./protocols/fluid.js";
import axios from "axios";

export const protocolHelperMap = new Map<Protocols, any>([
    [Protocols.AAVE_V3, AaveV3Helper],
    [Protocols.COMPOUND, CompoundHelper],
    [Protocols.MORPHO, MorphoHelper],
    [Protocols.FLUID, FluidHelper],
    [Protocols.MOONWELL, MoonwellHelper],
]);

export const defaultProvider = new ethersLib.JsonRpcProvider("https://base.llamarpc.com");

export async function approve(tokenAddress: string, spenderAddress: string, signer: any) {
    const token = new ethersLib.Contract(tokenAddress, ERC20_ABI, signer);
    const approveTx = await token.approve(spenderAddress, MaxUint256);
    await approveTx.wait();
    console.log("approve:" + tokenAddress + "token to " + spenderAddress);
}

export async function getDecimals(tokenAddress: string): Promise<number> {
    const provider = new ethersLib.JsonRpcProvider("https://base.llamarpc.com");

    const tokenContract = new ethersLib.Contract(tokenAddress, ERC20_ABI, provider);
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
    return ethersLib.formatUnits(String(amount), 6);
}

export async function wrapETH(amountIn: string, signer: HardhatEthersSigner) {
    const wethContract = new ethersLib.Contract(WETH_ADDRESS, WETH_ABI, signer);

    const amount = ethersLib.parseEther(amountIn);
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
    const ethers = getEthers();
    const wallet = new ethersLib.Wallet(process.env.TESTING_SAFE_OWNER_KEY!, ethers.provider);

    const tx = await wallet.sendTransaction({
        to: receiverAddress,
        value: ethersLib.parseEther("0.001"),
    });

    console.log("Transaction Hash:", tx.hash);

    const balance = await ethers.provider.getBalance(receiverAddress);
    console.log(`Balance:`, ethersLib.formatEther(balance), "ETH");
}

/**
 * Fund an address with ETH for gas fees using the first Hardhat signer (deployer)
 * This is useful for funding impersonated accounts in tests
 * @param receiverAddress The address to fund with ETH
 * @param amount The amount of ETH to send (default: "1.0")
 */
export async function fundSignerWithETH(receiverAddress: string, amount: string = "1.0") {
    const ethers = getEthers();
    const [deployer] = await ethers.getSigners();
    const tx = await deployer.sendTransaction({
        to: receiverAddress,
        value: ethersLib.parseEther(amount),
    });
    await tx.wait();
    console.log(`Funded ${receiverAddress} with ${amount} ETH for gas fees`);
}

/**
 * EIP-1193 Provider wrapper for Safe SDK
 * This is used to wrap Hardhat's provider for use with Safe SDK
 */
export function createEip1193Provider(): Eip1193Provider {
    const ethers = getEthers();
    return {
        request: async (args: RequestArguments) => {
            const { method, params } = args;
            return ethers.provider.send(method, Array.isArray(params) ? params : []);
        },
    };
}

// For backward compatibility - but requires network to be connected first
export const eip1193Provider: Eip1193Provider = {
    request: async (args: RequestArguments) => {
        const ethers = getEthers();
        const { method, params } = args;
        return ethers.provider.send(method, Array.isArray(params) ? params : []);
    },
};
