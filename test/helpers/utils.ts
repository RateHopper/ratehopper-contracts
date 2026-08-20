import { ethers } from "hardhat";
import { Eip1193Provider, RequestArguments } from "@safe-global/protocol-kit";
import { abi as ERC20_ABI } from "@openzeppelin/contracts/build/contracts/ERC20.json";
import { MaxUint256 } from "ethers";
import axios from "axios";

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
              { includeDEXS: "UniswapV4" },
              { includeDEXS: "AerodromeSlipstream" },
              { includeDEXS: "AerodromeSlipstreamNewFactory" },
              { includeDEXS: "AerodromeSlipstreamFactory3" },
              { includeDEXS: "MaverickV2" },
              { includeDEXS: "SwapBasedV3" },
              { includeDEXS: "Alien" },
              { excludeDEXS: defaultExclusions },
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

/**
 * SafeYieldManager SwapLeg builders — one shape for every yield test so a
 * struct change is a single edit here, not one per test file.
 */
export function leg(amountOutMin: bigint | number, poolParam: string) {
    return { amountOutMin, poolParam };
}

export const ZERO_LEG = { amountOutMin: 0, poolParam: "0x" } as const;

/**
 * Write a fresh observation into a Uniswap V3 TWAP reference pool.
 *
 * A live chain keeps writing observations as time passes, because the pool
 * keeps being traded. A forked chain that only advances its clock does not, so
 * after a multi-day `evm_increaseTime` the reference looks abandoned and the
 * oracle correctly refuses it.
 *
 * The swap has to be big enough to MOVE THE TICK: Uniswap V3 writes an
 * observation only when `state.tick != slot0Start.tick`, so a dust trade
 * changes nothing. It does not disturb the reported average, because the
 * observation it writes carries the PRE-swap tick and the extrapolated tail is
 * zero in that same block.
 */
export async function pokeTwapPool(poolAddress: string) {
    const { ethers, network } = require("hardhat");
    const erc20 = [
        "function transfer(address,uint256) returns (bool)",
        "function approve(address,uint256) returns (bool)",
        "function balanceOf(address) view returns (uint256)",
    ];
    const poolAbi = [
        "function token0() view returns (address)",
        "function token1() view returns (address)",
        "function fee() view returns (uint24)",
        "function slot0() view returns (uint160,int24,uint16 observationIndex,uint16,uint16,uint8,bool)",
        "function observations(uint256) view returns (uint32 blockTimestamp,int56,uint160,bool)",
    ];
    const pool = new ethers.Contract(poolAddress, poolAbi, ethers.provider);
    const [token0, token1, fee] = await Promise.all([pool.token0(), pool.token1(), pool.fee()]);
    const before = (await pool.observations((await pool.slot0()).observationIndex)).blockTimestamp;

    const [funder] = await ethers.getSigners();
    // The pool is a deterministic holder of its own token0 on the fork; the
    // swap hands it straight back.
    await network.provider.send("hardhat_setBalance", [poolAddress, "0x8AC7230489E80000"]);
    const poolSigner = await ethers.getImpersonatedSigner(poolAddress);
    const poolToken0 = new ethers.Contract(token0, erc20, poolSigner);
    const amountIn = (await poolToken0.balanceOf(poolAddress)) / 50n;
    await (await poolToken0.transfer(funder.address, amountIn)).wait();
    await network.provider.send("hardhat_stopImpersonatingAccount", [poolAddress]);

    const routerAddress = "0x2626664c2603336E57B271c5C0b26F421741e481";
    await (await new ethers.Contract(token0, erc20, funder).approve(routerAddress, amountIn)).wait();
    const router = new ethers.Contract(
        routerAddress,
        [
            "function exactInputSingle((address tokenIn,address tokenOut,uint24 fee,address recipient,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)",
        ],
        funder,
    );
    await (
        await router.exactInputSingle({
            tokenIn: token0,
            tokenOut: token1,
            fee,
            recipient: funder.address,
            amountIn,
            amountOutMinimum: 0,
            sqrtPriceLimitX96: 0,
        })
    ).wait();

    const after = (await pool.observations((await pool.slot0()).observationIndex)).blockTimestamp;
    if (after === before) {
        throw new Error(`pokeTwapPool(${poolAddress}) did not move the tick, so no observation was written`);
    }
}
