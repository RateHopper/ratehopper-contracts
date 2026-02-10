import { ethers, MaxUint256 } from "ethers";
import dotenv from "dotenv";
dotenv.config();
const provider = new ethers.JsonRpcProvider("https://base.llamarpc.com");
const signer = new ethers.Wallet(process.env.SAFE_OWNER_PRIVATE_KEY!, provider);
import aaveProtocolDataProviderAbi from "../externalAbi/aaveV3/aaveProtocolDataProvider.json";
import aaveDebtTokenJson from "../externalAbi/aaveV3/aaveDebtToken.json";
import { cbETH_ADDRESS, cbETH_ETH_POOL, DEFAULT_SUPPLY_AMOUNT, Protocols, USDC_ADDRESS } from "../test/constants";
const contractAddress = "0x4c3b238eb2d349095A77c7ef7b842924e5071843";
const aaveV3ProtocolDataProvider = "0xd82a47fdebB5bf5329b09441C3DaB4b5df2153Ad";
import leveragedPositionJson from "../abis/LeveragedPosition.json";
import axios from "axios";
import { abi as ERC20_ABI } from "@openzeppelin/contracts/build/contracts/ERC20.json";

async function aaveApprove(tokenAddress: string) {
    const protocolDataProvider = new ethers.Contract(aaveV3ProtocolDataProvider, aaveProtocolDataProviderAbi, signer);
    const response = await protocolDataProvider.getReserveTokensAddresses(tokenAddress);
    const debtTokenAddress = response.variableDebtTokenAddress;
    const aaveDebtToken = new ethers.Contract(debtTokenAddress, aaveDebtTokenJson, signer);
    const approveDelegationTx = await aaveDebtToken.approveDelegation(contractAddress, MaxUint256);
    await approveDelegationTx.wait();
    console.log("approveDelegation:", debtTokenAddress);
}

async function approve(tokenAddress: string, spenderAddress: string, signer: any) {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
    const approveTx = await token.approve(spenderAddress, MaxUint256);
    await approveTx.wait();
    console.log("approve:" + tokenAddress + "token to " + spenderAddress);
}

async function createLeveragedPosition() {
    const leveragedPosition = new ethers.Contract(contractAddress, leveragedPositionJson, signer);

    const principleAmount = Number(DEFAULT_SUPPLY_AMOUNT);
    const defaultTargetSupplyAmount = "0.005";
    const collateralDecimals = 18;
    const parsedTargetAmount = ethers.parseUnits(defaultTargetSupplyAmount, collateralDecimals);
    const collateralAsset = cbETH_ADDRESS;
    const debtAsset = USDC_ADDRESS;
    const diffAmount = parsedTargetAmount - ethers.parseUnits(principleAmount.toString(), collateralDecimals);
    console.log("diffAmount:", diffAmount);

    const paraswapUrl = "https://automation-server-6mysb.ondigitalocean.app/api/common/paraswap-data";
    const params = {
        destToken: debtAsset,
        srcToken: collateralAsset,
        amount: diffAmount.toString(),
        userAddress: signer.address,
    };
    const headers = {
        "x-api-key": "9D998B72-7106-463F-9588-90425AB9FB10",
    };
    let response;
    try {
        response = await axios.get(paraswapUrl, { params, headers });
        console.log("Paraswap data response:", response.data);
    } catch (error) {
        console.error("Error fetching Paraswap data:", error);
    }

    // add 1% slippage(must be set by user)
    const amountPlusSlippage = (BigInt(response.data.srcAmount) * 1100n) / 1000n;

    const tx = await leveragedPosition.createLeveragedPosition(
        cbETH_ETH_POOL,
        Protocols.AAVE_V3,
        collateralAsset,
        ethers.parseUnits(principleAmount.toString(), collateralDecimals),
        parsedTargetAmount,
        debtAsset,
        amountPlusSlippage,
        "0x",
        response.data.txParams,
        { gasLimit: 2000000 },
    );
    await tx.wait();
}

async function main() {
    // await aaveApprove(USDC_ADDRESS);
    // await approve(cbETH_ADDRESS, contractAddress, signer);
    await createLeveragedPosition();
}

main().catch((error) => {
    console.error("Error executing:", error);
});
