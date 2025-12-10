import { ethers } from "ethers";
import IUniswapV3PoolABI from "@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json";
const quoterAbi = require("../externalAbi/uniswapV3/quoterV2.json");
import { computePoolAddress } from "@uniswap/v3-sdk";
import dotenv from "dotenv";
dotenv.config();

const provider = new ethers.JsonRpcProvider("https://base.llamarpc.com");
const signer = new ethers.Wallet(process.env.TESTING_SAFE_OWNER_KEY!, provider);

const uniswapV3PoolAddress = "0x06959273E9A65433De71F5A452D529544E07dDD0";

const uniswapV3PoolContract = new ethers.Contract(
    uniswapV3PoolAddress,
    IUniswapV3PoolABI.abi,
    signer,
);

const QUOTER_CONTRACT_ADDRESS = "0x3d4e44eb1374240ce5f1b871ab261cd16335b76a";

const quoterContract = new ethers.Contract(QUOTER_CONTRACT_ADDRESS, quoterAbi, signer);

async function getQuoteExactOutput(amountOut: string, tokenIn: string, tokenOut: string) {
    try {
        // const [token0, token1, fee] = await Promise.all([
        //     uniswapV3PoolContract.token0(),
        //     uniswapV3PoolContract.token1(),
        //     uniswapV3PoolContract.fee(),
        // ]);
        const amount = ethers.parseUnits(amountOut, 6);
        const quote = await quoterContract.quoteExactOutputSingle.staticCall({
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amount: amount,
            fee: 100,
            sqrtPriceLimitX96: 0,
        });

        console.log(
            `Quote for exact output of ${amountOut.toString()} is:`,
            ethers.formatUnits(quote[0].toString(), 6),
        );
    } catch (error) {
        console.error("Error getting quote:", error);
    }
}

const amountOut = "10000";
const tokenIn = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const tokenOut = "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca";

// const currentPoolAddress = computePoolAddress({
//     factoryAddress: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
//     tokenA: tokenIn,
//     tokenB: tokenOut,
//     fee: 100,
// });

getQuoteExactOutput(amountOut, tokenIn, tokenOut);
