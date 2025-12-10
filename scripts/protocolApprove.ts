import { ethers, MaxUint256 } from "ethers";

import dotenv from "dotenv";
import { AAVE_V3_POOL_ADDRESS, cbETH_ADDRESS, USDbC_ADDRESS, USDC_ADDRESS, WETH_ADDRESS } from "../test/constants";
import cometAbi from "../externalAbi/compound/comet.json";
import { approve } from "../test/utils";
import aaveDebtTokenJson from "../externalAbi/aaveV3/aaveDebtToken.json";
dotenv.config();
import aaveProtocolDataProviderAbi from "../externalAbi/aaveV3/aaveProtocolDataProvider.json";
import aaveV3PoolJson from "../externalAbi/aaveV3/aaveV3Pool.json";
const debtSwapContractAddress = "0x7c60013D3ad4C4696F80f56FF42f806c6fB11e69";
const provider = new ethers.JsonRpcProvider("https://base.llamarpc.com");
const signer = new ethers.Wallet(process.env.TESTING_SAFE_OWNER_KEY!, provider);
import { abi as ERC20_ABI } from "@openzeppelin/contracts/build/contracts/ERC20.json";
import morphoAbi from "../externalAbi/morpho/morpho.json";

async function main() {
    await compound();
    // await aaveFrom();
    // await aaveTo(USDC_ADDRESS);
    // await morpho();
}

async function compound() {
    const USDC_COMET_ADDRESS = "0xb125E6687d4313864e53df431d5425969c15Eb2F";
    const USDbC_COMET_ADDRESS = "0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf";
    const comet = new ethers.Contract(USDC_COMET_ADDRESS, cometAbi, signer);
    // const tx = await comet.allow(debtSwapContractAddress, true);
    const tx = await comet.allow(debtSwapContractAddress, false);
    await tx.wait();
    console.log("Successfully approved DebtSwap contract for Compound");
}

async function aaveFrom() {
    const pool = new ethers.Contract(AAVE_V3_POOL_ADDRESS, aaveV3PoolJson, signer);
    const result = await pool.getReserveData(WETH_ADDRESS);
    const aTokenAddress = result.aTokenAddress;
    const spenderAddress = debtSwapContractAddress;
    const token = new ethers.Contract(aTokenAddress, ERC20_ABI, signer);
    const approveTx = await token.approve(spenderAddress, MaxUint256);
    await approveTx.wait();
    console.log("approve:" + aTokenAddress + "token to " + spenderAddress);
    console.log("Successfully approved A Token");
}

const aaveV3ProtocolDataProvider = "0xd82a47fdebB5bf5329b09441C3DaB4b5df2153Ad";

async function aaveTo(tokenAddress: string) {
    const protocolDataProvider = new ethers.Contract(aaveV3ProtocolDataProvider, aaveProtocolDataProviderAbi, signer);
    const response = await protocolDataProvider.getReserveTokensAddresses(tokenAddress);
    const debtTokenAddress = response.variableDebtTokenAddress;
    const aaveDebtToken = new ethers.Contract(debtTokenAddress, aaveDebtTokenJson, signer);
    const approveDelegationTx = await aaveDebtToken.approveDelegation(debtSwapContractAddress, MaxUint256);
    await approveDelegationTx.wait();
    console.log("approveDelegation:", debtTokenAddress);
}

async function morpho() {
    const MORPHO_ADDRESS = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";
    const morphoContract = new ethers.Contract(MORPHO_ADDRESS, morphoAbi, signer);
    await morphoContract.setAuthorization(debtSwapContractAddress, true);
}

main().catch((error) => {
    console.error("Error executing:", error);
});
