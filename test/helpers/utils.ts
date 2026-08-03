import { ethers } from "hardhat";
import { Eip1193Provider, RequestArguments } from "@safe-global/protocol-kit";
import { DebtProtocols } from "./constants";
import { abi as ERC20_ABI } from "@openzeppelin/contracts/build/contracts/ERC20.json";
import { MaxUint256 } from "ethers";

import { AaveV3Helper } from "./protocolsDebt/aaveV3";
import { CompoundHelper } from "./protocolsDebt/compound";
import { MorphoHelper } from "./protocolsDebt/morpho";
import { MoonwellHelper } from "./protocolsDebt/moonwell";
import { FluidHelper } from "./protocolsDebt/fluid";
import axios from "axios";

export const protocolHelperMap = new Map<DebtProtocols, any>([
    [DebtProtocols.AAVE_V3, AaveV3Helper],
    [DebtProtocols.COMPOUND, CompoundHelper],
    [DebtProtocols.MORPHO, MorphoHelper],
    [DebtProtocols.FLUID, FluidHelper],
    [DebtProtocols.MOONWELL, MoonwellHelper],
]);

// Read through Hardhat's fork provider so repeated integration-test calls share
// its pinned state and cache instead of hammering the upstream RPC directly.
export const defaultProvider = ethers.provider;

export async function approve(tokenAddress: string, spenderAddress: string, signer: any) {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
    const approveTx = await token.approve(spenderAddress, MaxUint256);
    await approveTx.wait();
    console.log("approve:" + tokenAddress + "token to " + spenderAddress);
}

export async function getDecimals(tokenAddress: string): Promise<number> {
    const tokenContract = new ethers.Contract(tokenAddress, ERC20_ABI, ethers.provider);
    return await tokenContract.decimals();
}

export function formatAmount(amount: bigint): string {
    return ethers.formatUnits(String(amount), 6);
}

export async function getParaswapData(
    destToken: string,
    srcToken: string,
    contractAddress: string,
    amount: bigint,
    // 0.01% fee by default
    flashloanFee = 1n,
    preferredDEX?: string,
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

    let lastError: unknown;
    // ParaSwap can report "Unable to build transaction" when its best route
    // uses excluded Uniswap V3 even though another supported DEX has a route.
    // Try the broad safe set first, then force known callback-safe adapters.
    const { excludeDEXS: defaultExclusions, ...baseParams } = params;
    const routeOptions = preferredDEX
        ? [{ includeDEXS: preferredDEX }]
        : [
              { excludeDEXS: defaultExclusions },
              { includeDEXS: "UniswapV4" },
              { includeDEXS: "AerodromeSlipstream" },
              { includeDEXS: "AerodromeSlipstreamNewFactory" },
              { includeDEXS: "AerodromeSlipstreamFactory3" },
              { includeDEXS: "MaverickV2" },
              { includeDEXS: "SwapBasedV3" },
              { includeDEXS: "Alien" },
          ];
    for (const routeOption of routeOptions) {
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                const response = await axios.get(url, {
                    params: { ...baseParams, ...routeOption },
                    timeout: 30_000,
                });
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
                lastError = error;
                if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 1_000));
            }
        }
    }

    const detail = axios.isAxiosError(lastError)
        ? `HTTP ${lastError.response?.status ?? "network error"}: ${JSON.stringify(lastError.response?.data ?? {})}`
        : String(lastError);
    throw new Error(`Failed to fetch ParaSwap data after retries (${detail})`);
}

export async function fundETH(receiverAddress: string) {
    const wallet = new ethers.Wallet(process.env.TESTING_SAFE_OWNER_KEY!, ethers.provider); // Replace with a funded Hardhat account

    const tx = await wallet.sendTransaction({
        to: receiverAddress,
        value: ethers.parseEther("0.001"),
    });

    console.log("Transaction Hash:", tx.hash);

    const balance = await ethers.provider.getBalance(receiverAddress);
    console.log(`Balance:`, ethers.formatEther(balance), "ETH");
}

/**
 * Fund an address with ETH for gas fees using the first Hardhat signer (deployer)
 * This is useful for funding impersonated accounts in tests
 * @param receiverAddress The address to fund with ETH
 * @param amount The amount of ETH to send (default: "1.0")
 */
export async function fundSignerWithETH(receiverAddress: string, amount: string = "1.0") {
    const [deployer] = await ethers.getSigners();
    const tx = await deployer.sendTransaction({
        to: receiverAddress,
        value: ethers.parseEther(amount),
    });
    await tx.wait();
    console.log(`Funded ${receiverAddress} with ${amount} ETH for gas fees`);
}

/**
 * EIP-1193 Provider wrapper for Safe SDK
 * This is used to wrap Hardhat's provider for use with Safe SDK
 */
export const eip1193Provider: Eip1193Provider = {
    request: async (args: RequestArguments) => {
        const { method, params } = args;
        return ethers.provider.send(method, Array.isArray(params) ? params : []);
    },
};
