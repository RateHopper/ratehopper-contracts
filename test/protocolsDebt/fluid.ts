import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { Contract, MaxUint256 } from "ethers";
import fluidAbi from "../../externalAbi/fluid/fluidVaultT1.json";
import fluidVaultResolverAbi from "../../externalAbi/fluid/fluidVaultResolver.json";
import { formatAmount } from "../utils";
import { abi as ERC20_ABI } from "@openzeppelin/contracts/build/contracts/ERC20.json";
import {
    cbBTC_ADDRESS,
    cbETH_ADDRESS,
    DEFAULT_SUPPLY_AMOUNT,
    EURC_ADDRESS,
    sUSDS_ADDRESS,
    TEST_ADDRESS,
    USDbC_ADDRESS,
    USDC_ADDRESS,
    WETH_ADDRESS,
} from "../constants";

export const FLUID_VAULT_RESOLVER = "0x1500d70d8551b828f8fb56fa739c977d113444df";
// export const FLUID_VAULT_RESOLVER = "0x79B3102173EB84E6BCa182C7440AfCa5A41aBcF8";
export const FLUID_cbETH_USDC_VAULT = "0x40d9b8417e6e1dcd358f04e3328bced061018a82";
export const FLUID_cbBTC_sUSDS_VAULT = "0xf2c8f54447cbd591c396b0dd7ac15faf552d0fa4";
export const FLUID_cbBTC_USDC_VAULT = "0x4045720a33193b4fe66c94dfbc8d37b0b4d9b469";
export const FLUID_cbETH_EURC_VAULT = "0xf55b8e9f0c51ace009f4b41d03321675d4c643b3";
export const FLUID_wstETH_USDC_VAULT = "0xbec491fef7b4f666b270f9d5e5c3f443cbf20991";
export const FLUID_wstETH_sUSDS_VAULT = "0xbc345229c1b52e4c30530c614bb487323ba38da5";
export const FLUID_WETH_USDC_VAULT = "0xeabbfca72f8a8bf14c4ac59e69ecb2eb69f0811c";

export const fluidVaultMap = new Map<string, string>([
    // https://fluid.instadapp.io/vaults/8453/6
    [USDC_ADDRESS, FLUID_cbETH_USDC_VAULT],
    // https://fluid.instadapp.io/vaults/8453/19
    [sUSDS_ADDRESS, FLUID_cbBTC_sUSDS_VAULT],

    [cbETH_ADDRESS, FLUID_cbETH_USDC_VAULT],
    // https://fluid.instadapp.io/vaults/8453/7
    [cbBTC_ADDRESS, FLUID_cbBTC_USDC_VAULT],
    [EURC_ADDRESS, FLUID_cbETH_EURC_VAULT],
    [WETH_ADDRESS, FLUID_WETH_USDC_VAULT],
]);

async function approve(tokenAddress: string, spenderAddress: string, signer: any) {
    const token = new ethers.Contract(tokenAddress, ERC20_ABI, signer);
    const approveTx = await token.approve(spenderAddress, MaxUint256);
    await approveTx.wait();
    console.log("approve:" + tokenAddress + "token to " + spenderAddress);
}

export class FluidHelper {
    constructor(private signer: HardhatEthersSigner | any) {}

    async getPosition(vaultAddress: string, userAddress) {
        const resolver = new ethers.Contract(FLUID_VAULT_RESOLVER, fluidVaultResolverAbi, this.signer);
        const positions = await resolver.positionsByUser(userAddress);
        const positionIndex = positions[1].findIndex((vault) => vault[0].toLowerCase() === vaultAddress);
        if (positionIndex === -1) {
            console.log("No position found on vault: " + vaultAddress);
            return;
        }
        return positions[0][positionIndex];
    }

    async getDebtAmount(vaultAddress: string, userAddress?: string): Promise<bigint> {
        const position = await this.getPosition(vaultAddress, userAddress || TEST_ADDRESS);
        if (!position) return BigInt(0);

        const debtAmount = position[10];
        console.log("debtAmount:", debtAmount + " on vault: " + vaultAddress);
        return debtAmount;
    }

    // INFO: https://docs.fluid.instadapp.io/integrate/vault-user-positions.html
    async getCollateralAmount(tokenAddress: string, userAddress?: string): Promise<bigint> {
        const vaultAddress = fluidVaultMap.get(tokenAddress)!;
        const position = await this.getPosition(vaultAddress, userAddress || TEST_ADDRESS);
        if (!position) return BigInt(0);
        const collateralAmount = position[9];
        console.log("collateralAmount:", collateralAmount + " on vault: " + vaultAddress);
        return collateralAmount;
    }

    async getNftId(vaultAddress: string, userAddress?: string): Promise<bigint> {
        const position = await this.getPosition(vaultAddress, userAddress || TEST_ADDRESS);
        if (!position) return BigInt(0);
        const nftId = position[0];
        console.log("nftId:", nftId + " on vault: " + vaultAddress);
        return nftId;
    }

    async supply(vaultAddress: string) {
        await approve(cbETH_ADDRESS, vaultAddress, this.signer);

        const vault = new ethers.Contract(vaultAddress, fluidAbi, this.signer);
        const supplyAmount = ethers.parseEther(DEFAULT_SUPPLY_AMOUNT);
        // new position
        const tx = await vault.operate(0, supplyAmount, 0, this.signer.address);
        await tx.wait();
    }

    async borrow(vaultAddress: string, tokenAddress: string, userAddress: string) {
        await approve(tokenAddress, vaultAddress, this.signer);

        const nftId = await this.getNftId(vaultAddress, userAddress);

        const vault = new ethers.Contract(vaultAddress, fluidAbi, this.signer);
        const borrowAmount = ethers.parseUnits("1", 6);
        // new position
        const tx = await vault.operate(nftId, 0, borrowAmount, this.signer.address);
        await tx.wait();
    }
}
