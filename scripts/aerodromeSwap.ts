import { ethers } from "ethers";
import { abi as ERC20_ABI } from "@openzeppelin/contracts/build/contracts/ERC20.json";
import dotenv from "dotenv";
dotenv.config();

const routerABI = [
  "function swapExactTokensForTokens(uint amountIn, uint amountOutMin, (address from,address to,bool stable,address factory)[] calldata routes, address to, uint deadline) external returns (uint[] memory amounts)",
];

const ROUTER_ADDRESS = "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43";
const factoryAddress = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da";

const provider = new ethers.JsonRpcProvider("https://base.llamarpc.com");
const signer = new ethers.Wallet(process.env.TESTING_SAFE_OWNER_KEY!, provider);

async function main() {
  const routerContract = new ethers.Contract(ROUTER_ADDRESS, routerABI, signer);

  const inputToken = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"; // USDC
  const outputToken = "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca"; // USDbC

  const amountIn = ethers.parseUnits("0.1", 6);
  const amountOutMin = ethers.parseUnits("0.09", 6);
  const recipient = await signer.getAddress();
  const deadline = Math.floor(Date.now() / 1000) + 300; // 5 minutes from now

  const routes = [
    {
      from: inputToken,
      to: outputToken,
      stable: true,
      factory: factoryAddress,
    },
  ];

  console.log("Approve token...");
  const tokenContract = new ethers.Contract(inputToken, ERC20_ABI, signer);
  const approveTx = await tokenContract.approve(ROUTER_ADDRESS, amountIn);
  const approveTxResult = await approveTx.wait();
  console.log("approveTxResult:", approveTxResult);

  console.log("Executing swap...");
  const tx = await routerContract.swapExactTokensForTokens(
    amountIn,
    amountOutMin,
    routes,
    recipient,
    deadline
  );
  console.log("Transaction sent:", tx.hash);

  const receipt = await tx.wait();
  console.log("Transaction confirmed:", receipt);
}

main().catch((error) => {
  console.error("Error executing swap:", error);
});
