import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { Contract, MaxUint256 } from "ethers";
import {
    cbBTC_ADDRESS,
    cbETH_ADDRESS,
    DEFAULT_SUPPLY_AMOUNT,
    eUSD_ADDRESS,
    MAI_ADDRESS,
    TEST_ADDRESS,
    USDC_ADDRESS,
    WETH_ADDRESS,
} from "../constants";

import { abi as ERC20_ABI } from "@openzeppelin/contracts/build/contracts/ERC20.json";
import { approve, defaultProvider, formatAmount } from "../utils";
import chainAgnosticBundlerV2Abi from "../../externalAbi/morpho/chainAgnosticBundlerV2.json";
import morphoAbi from "../../externalAbi/morpho/morpho.json";
import { BundlerAction } from "@morpho-org/bundler-sdk-ethers";
import { MetaTransactionData, OperationType } from "@safe-global/types-kit";
import { safeAddress } from "../debtSwapBySafe";

export const bundlerAddress = "0x23055618898e202386e6c13955a58d3c68200bfb";
export const MORPHO_ADDRESS = "0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb";

export const morphoMarket1Id = "0x1c21c59df9db44bf6f645d854ee710a8ca17b479451447e9f56758aee10a2fad";
export const morphoMarket2Id = "0xdba352d93a64b17c71104cbddc6aef85cd432322a1446b5b65163cbbc615cd0c";
export const morphoMarket3Id = "0xf761e909ee2f87f118e36b7efb42c5915752a6d39263eec0c000c15d0ab7f489";
export const morphoMarket4Id = "0x9103c3b4e834476c9a62ea009ba2c884ee42e94e6e314a26f04d312434191836";
export const morphoMarket5Id = "0xb5d424e4af49244b074790f1f2dc9c20df948ce291fc6bcc6b59149ecf91196d";
export const morphoMarket6Id = "0x3b3769cfca57be2eaed03fcc5299c25691b77781a1e124e7a8d520eb9a7eabb5";
export const morphoMarket7Id = "0x8793cf302b8ffd655ab97bd1c695dbd967807e8367a65cb2f4edaf1380ba1bda";

const market1Params = {
    collateralToken: cbETH_ADDRESS,
    loanToken: USDC_ADDRESS,
    irm: "0x46415998764C29aB2a25CbeA6254146D50D22687",
    oracle: "0xb40d93F44411D8C09aD17d7F88195eF9b05cCD96",
    lltv: 860000000000000000n,
};

const market2Params = {
    collateralToken: cbETH_ADDRESS,
    loanToken: USDC_ADDRESS,
    irm: "0x46415998764C29aB2a25CbeA6254146D50D22687",
    oracle: "0x4756c26E01E61c7c2F86b10f4316e179db8F9425",
    lltv: 860000000000000000n,
};

const market3Params = {
    collateralToken: cbETH_ADDRESS,
    loanToken: MAI_ADDRESS,
    irm: "0x46415998764C29aB2a25CbeA6254146D50D22687",
    oracle: "0xc3Fa71D77d80f671F366DAA6812C8bD6C7749cEc",
    lltv: 860000000000000000n,
};

const market4Params = {
    collateralToken: cbBTC_ADDRESS,
    loanToken: USDC_ADDRESS,
    irm: "0x46415998764C29aB2a25CbeA6254146D50D22687",
    oracle: "0x663BECd10daE6C4A3Dcd89F1d76c1174199639B9",
    lltv: 860000000000000000n,
};

const market5Params = {
    collateralToken: cbETH_ADDRESS,
    loanToken: eUSD_ADDRESS,
    irm: "0x46415998764C29aB2a25CbeA6254146D50D22687",
    oracle: "0xc3Fa71D77d80f671F366DAA6812C8bD6C7749cEc",
    lltv: 860000000000000000n,
};

const market6Params = {
    collateralToken: USDC_ADDRESS,
    loanToken: WETH_ADDRESS,
    irm: "0x46415998764C29aB2a25CbeA6254146D50D22687",
    oracle: "0xD09048c8B568Dbf5f189302beA26c9edABFC4858",
    lltv: 860000000000000000n,
};

const market7Params = {
    collateralToken: WETH_ADDRESS,
    loanToken: USDC_ADDRESS,
    irm: "0x46415998764C29aB2a25CbeA6254146D50D22687",
    oracle: "0xFEa2D58cEfCb9fcb597723c6bAE66fFE4193aFE4",
    lltv: 860000000000000000n,
};

export const marketParamsMap = new Map<string, any>([
    [morphoMarket1Id, market1Params],
    [morphoMarket2Id, market2Params],
    [morphoMarket3Id, market3Params],
    [morphoMarket4Id, market4Params],
    [morphoMarket5Id, market5Params],
    [morphoMarket6Id, market6Params],
    [morphoMarket7Id, market7Params],
]);

export class MorphoHelper {
    private morpho;

    constructor(private signer: HardhatEthersSigner | any) {
        this.morpho = new ethers.Contract(MORPHO_ADDRESS, morphoAbi, signer);
    }

    async getDebtAmount(marketId: string, userAddress?: string): Promise<bigint> {
        const positionData = await this.getPosition(marketId, userAddress);
        const marketData = await this.getMarketData(marketId);
        // picked this logic from AP-API Morpho BP
        const borrowShares = BigInt(positionData.borrowShares);
        const totalBorrowAssets = BigInt(marketData.totalBorrowAssets) + BigInt(1);
        const totalBorrowShares = BigInt(marketData.totalBorrowShares) + BigInt(1000000);

        const result1 = borrowShares * totalBorrowAssets;
        const result2 = totalBorrowShares - BigInt(1);
        const debtAmount = result1 / result2;
        console.log(`morpho DebtAmount ${marketId}:`, debtAmount);
        return debtAmount;
    }

    async getCollateralAmount(marketId: string, userAddress?: string): Promise<bigint> {
        const positionData = await this.getPosition(marketId, userAddress);
        const collateralAmount = positionData.collateral;
        console.log(`morpho collateralAmount ${marketId}:`, collateralAmount);
        return collateralAmount;
    }

    async getBorrowShares(marketId: string, userAddress?: string): Promise<bigint> {
        const positionData = await this.getPosition(marketId, userAddress);
        const borrowShares = positionData.borrowShares;
        console.log(`morpho borrowShares ${marketId}:`, borrowShares);
        return borrowShares;
    }

    async getPosition(marketId: string, userAddress?: string) {
        return await this.morpho.position(marketId, userAddress || TEST_ADDRESS);
    }

    async getMarketData(marketId: string) {
        return await this.morpho.market(marketId);
    }

    async borrow(marketId: string, decimals = 6) {
        const marketParams = marketParamsMap.get(marketId)!;
        const amount = ethers.parseUnits("1", decimals);
        const tx = await this.morpho.borrow(marketParams, amount, 0, TEST_ADDRESS, TEST_ADDRESS);
        await tx.wait();
        console.log("borrowed", amount);
        // const receipt = await tx.wait();
        // console.log("Transaction Receipt:", receipt);

        // if (receipt.logs) {
        //     receipt.logs.forEach((log, index) => {
        //         console.log(`Log ${index}:`, log);
        //     });
        // }
    }

    async supply(collateralTokenAddress: string, marketId: string) {
        const tokenContract = new ethers.Contract(collateralTokenAddress, ERC20_ABI, this.signer);
        await approve(collateralTokenAddress, bundlerAddress, this.signer);
        const amount = ethers.parseEther(DEFAULT_SUPPLY_AMOUNT);

        const walletBalance = await tokenContract.balanceOf(TEST_ADDRESS);
        console.log(`${collateralTokenAddress} Wallet Balance:`, formatAmount(walletBalance));

        const erc20TransferAction = BundlerAction.erc20TransferFrom(collateralTokenAddress, amount);

        const marketParam = marketParamsMap.get(marketId)!;

        const supplyAction = BundlerAction.morphoSupplyCollateral(marketParam, amount, TEST_ADDRESS, []);

        const borrowAmount = ethers.parseUnits("1", 6);
        const borrowAction = BundlerAction.morphoBorrow(marketParam, borrowAmount, 0n, 0n, TEST_ADDRESS);

        const bundler = new Contract(bundlerAddress, chainAgnosticBundlerV2Abi, this.signer);
        await bundler.multicall([erc20TransferAction, supplyAction]);

        const walletBalanceAfter = await tokenContract.balanceOf(TEST_ADDRESS);
        console.log(`${collateralTokenAddress} Wallet Balance:`, formatAmount(walletBalanceAfter));
    }

    encodeExtraData(marketId: string, borrowShares: bigint) {
        const fromMarketParams = marketParamsMap.get(marketId)!;

        const structType = ["address", "address", "address", "address", "uint256"];
        const structValue = [
            fromMarketParams.loanToken,
            fromMarketParams.collateralToken,
            fromMarketParams.oracle,
            fromMarketParams.irm,
            fromMarketParams.lltv,
        ];

        return ethers.AbiCoder.defaultAbiCoder().encode(
            [`tuple(${structType.join(",")})`, "uint256"],
            [structValue, borrowShares],
        );
    }

    async decode(rawData: string) {
        const iface = new ethers.Interface(chainAgnosticBundlerV2Abi);
        const calldataArray = iface.decodeFunctionData(rawData.slice(0, 10), rawData);
        console.log("Calldata Array:", calldataArray.length);

        for (const calldata of calldataArray) {
            const decodedFunction = iface.parseTransaction({ data: calldata[0] });
            console.log("Function name:", decodedFunction!.name);
            const decodedData = iface.decodeFunctionData(calldata[0].slice(0, 10), calldata[0]);
            console.log("Decoded Data:", decodedData);
        }
    }

    async getSupplyAndBorrowTxdata(debtTokenAddress, collateralAddress = cbETH_ADDRESS): Promise<MetaTransactionData[]> {
        const morphoContract = new ethers.Contract(MORPHO_ADDRESS, morphoAbi, defaultProvider);
        const marketParams = marketParamsMap.get(morphoMarket1Id)!;

        const collateralContract = new ethers.Contract(collateralAddress, ERC20_ABI, defaultProvider);

        const approveTransactionData: MetaTransactionData = {
            to: collateralAddress,
            value: "0",
            data: collateralContract.interface.encodeFunctionData("approve", [MORPHO_ADDRESS, ethers.parseEther("1")]),
            operation: OperationType.Call,
        };

        const supplyTransactionData: MetaTransactionData = {
            to: MORPHO_ADDRESS,
            value: "0",
            data: morphoContract.interface.encodeFunctionData("supplyCollateral", [
                marketParams,
                ethers.parseEther(DEFAULT_SUPPLY_AMOUNT),
                safeAddress,
                "0x",
            ]),
            operation: OperationType.Call,
        };

        const amount = ethers.parseUnits("1", 6);
        const borrowTransactionData: MetaTransactionData = {
            to: MORPHO_ADDRESS,
            value: "0",
            data: morphoContract.interface.encodeFunctionData("borrow", [
                marketParams,
                amount,
                0,
                safeAddress,
                safeAddress,
            ]),
            operation: OperationType.Call,
        };
        return [approveTransactionData, supplyTransactionData, borrowTransactionData];
    }
}
