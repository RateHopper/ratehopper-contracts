import { ethers, MaxUint256 } from "ethers";

import dotenv from "dotenv";
import {
    cbETH_ADDRESS,
    DEFAULT_SUPPLY_AMOUNT,
    Protocols,
    USDbC_ADDRESS,
    USDC_ADDRESS,
    USDC_hyUSD_POOL,
    WETH_ADDRESS,
} from "../test/constants";
dotenv.config();
// import * as debtSwapJson from "../artifacts/contracts/DebtSwap.sol/DebtSwap.json";
import debtSwapJson from "../abis/debtSwap.json";
import { AaveV3Helper } from "../test/protocols/aaveV3";
import { DebtSwap } from "../typechain-types";

async function main() {
    const provider = new ethers.JsonRpcProvider("https://base.llamarpc.com");
    const signer = new ethers.Wallet(process.env.MY_PRIVATE_KEY2!, provider);

    const debtSwapAddress = "0x0F4bA1e061823830D42350e410513727E7125171";
    // const aaveV3Helper = new AaveV3Helper(signer);
    // await aaveV3Helper.approveDelegation(USDbC_ADDRESS, debtSwapAddress);

    const debtSwapContract = new ethers.Contract(debtSwapAddress, debtSwapJson, signer);

    const toExtraData = ethers.AbiCoder.defaultAbiCoder().encode(
        ["address"],
        ["0x9c4ec768c28520B50860ea7a15bd7213a9fF58bf"],
    );

    const zeroAddress = "0x0000000000000000000000000000000000000000";
    let paraswapData = {
        router: zeroAddress,
        tokenTransferProxy: zeroAddress,
        swapData: "0x",
    };

    const tx = await debtSwapContract.executeDebtSwap(
        // USDC_hyUSD_POOL,
        "0x07598e2773F7F17e65739280689f30983762A872",
        Protocols.AAVE_V3,
        Protocols.COMPOUND,
        USDbC_ADDRESS,
        USDbC_ADDRESS,
        "100000",
        0,
        [{ asset: WETH_ADDRESS, amount: "200834612229632" }],
        "0x",
        toExtraData,
        paraswapData,
    );
    console.log("tx:", tx);

    const result = await tx.wait();
    console.log("result:", result);
}

main().catch((error) => {
    console.error("Error executing:", error);
});
