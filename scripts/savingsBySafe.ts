import { ethers, network } from "hardhat";
import dotenv from "dotenv";
dotenv.config();
import Safe from "@safe-global/protocol-kit";
import { MetaTransactionData, OperationType } from "@safe-global/types-kit";
import {
    OSERO_REFERRAL_CODE,
    SPARK_PSM3_ADDRESS,
    USDC_ADDRESS,
    YieldProtocol,
    encodeSkySavingsPoolParam,
    sUSDS_ADDRESS,
} from "../contractAddresses";
import { ERC20_ABI, deployedManagerAddress, resolveOwnerKey, waitForReceipt } from "./lpSafeShared";

/**
 * Walks a Safe through the savings source (protocol 3, sUSDS through Spark
 * PSM3) on a deployed SafeYieldManager: status, open, close, withdraw, and a
 * direct PSM3 redemption of sUSDS the module no longer tracks.
 *
 * Caller paths (CALLER env):
 *   safe      (default) the Safe owner executes through protocol-kit, threshold
 *             must be 1; `enableModule(manager)` is prepended when needed.
 *             Key: TESTING_SAFE_OWNER_KEY / SAFE_OWNER_PRIVATE_KEY / DEPLOYER_PRIVATE_KEY.
 *   operator  the registry operator calls the manager directly.
 *             Key: TESTING_SAFE_OPERATOR_KEY / OPERATOR_PRIVATE_KEY.
 *             (redeem-direct always goes through the Safe.)
 *
 * Usage (always dry-run first; DRY_RUN=false to send):
 *   IGNITION_DEPLOYMENT_ID=<id> ACTION=status   npx hardhat run scripts/savingsBySafe.ts --network base
 *   IGNITION_DEPLOYMENT_ID=<id> ACTION=open     USDC_AMOUNT=0.5 DRY_RUN=false npx hardhat run ...
 *   IGNITION_DEPLOYMENT_ID=<id> ACTION=close    EXIT_BPS=5000 DRY_RUN=false npx hardhat run ...
 *   IGNITION_DEPLOYMENT_ID=<id> ACTION=withdraw DRY_RUN=false npx hardhat run ...
 *   IGNITION_DEPLOYMENT_ID=<id> ACTION=redeem-direct DRY_RUN=false npx hardhat run ...
 * Env: SAFE_ADDRESS (defaults to TESTING_SAFE_WALLET_ADDRESS), MANAGER_ADDRESS
 * (defaults to the Ignition journal named by IGNITION_DEPLOYMENT_ID),
 * SLIPPAGE_BPS (oracle tolerance, default 20), MIN_USDC_OUT (close, default 0).
 */

const PROTOCOL = YieldProtocol.SKY_SAVINGS;
const POOL_PARAM = encodeSkySavingsPoolParam(SPARK_PSM3_ADDRESS, sUSDS_ADDRESS);
const ZERO_LEG = { amountOutMin: 0, poolParam: "0x" };
const DEADLINE_SECONDS = 1_200n;

const PSM3_ABI = [
    "function pocket() view returns (address)",
    "function previewSwapExactIn(address,address,uint256) view returns (uint256)",
    "function swapExactIn(address,address,uint256,uint256,address,uint256) returns (uint256)",
];
const SAFE_VIEW_ABI = [
    "function isModuleEnabled(address) view returns (bool)",
    "function getThreshold() view returns (uint256)",
];

function env(name: string, fallback = ""): string {
    const value = process.env[name];
    return value === undefined || value === "" ? fallback : value;
}

async function main() {
    const ACTION = env("ACTION", "status");
    const CALLER = env("CALLER", "safe");
    const DRY_RUN = env("DRY_RUN", "true") !== "false";
    const SAFE_ADDRESS = env("SAFE_ADDRESS", env("TESTING_SAFE_WALLET_ADDRESS"));
    const MANAGER_ADDRESS = env("MANAGER_ADDRESS") || deployedManagerAddress();
    const SLIPPAGE_BPS = Number(env("SLIPPAGE_BPS", "20"));
    const EXIT_BPS = Number(env("EXIT_BPS", "10000"));
    const usdcAmount = ethers.parseUnits(env("USDC_AMOUNT", "0.5"), 6);
    const minUsdcOut = ethers.parseUnits(env("MIN_USDC_OUT", "0"), 6);
    if (!ethers.isAddress(SAFE_ADDRESS)) throw new Error("Set SAFE_ADDRESS (or TESTING_SAFE_WALLET_ADDRESS)");
    if (!["status", "open", "close", "withdraw", "redeem-direct"].includes(ACTION))
        throw new Error(`Unknown ACTION ${ACTION}`);

    const provider = ethers.provider;
    const manager = await ethers.getContractAt("SafeYieldManager", MANAGER_ADDRESS);
    const handlerAddress: string = await manager.yieldHandlers(PROTOCOL);
    if (handlerAddress === ethers.ZeroAddress)
        throw new Error(`No handler registered under protocol ${PROTOCOL} on ${MANAGER_ADDRESS}`);
    const handler = await ethers.getContractAt("SkySavingsYieldHandler", handlerAddress);
    const handlerEvents = await ethers.getContractAt("SkySavingsYieldHandler", MANAGER_ADDRESS);
    const provider_ = await ethers.getContractAt("ChainlinkSsrRateProvider", await handler.RATE_PROVIDER());
    const psm3 = new ethers.Contract(SPARK_PSM3_ADDRESS, PSM3_ABI, provider);
    const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
    const susds = new ethers.Contract(sUSDS_ADDRESS, ERC20_ABI, provider);
    const safeView = new ethers.Contract(SAFE_ADDRESS, SAFE_VIEW_ABI, provider);
    const tokenId = BigInt(SAFE_ADDRESS);

    const status = async () => {
        const [rate, pocket, shares, basis, pinned, openOn, closeOn, allowed, moduleOn] = await Promise.all([
            provider_.rate(sUSDS_ADDRESS),
            psm3.pocket().then((pocket: string) => usdc.balanceOf(pocket)),
            handler.savingsSharesSlot(tokenId).then((slot: string) => provider.getStorage(MANAGER_ADDRESS, slot)),
            manager.residualBasisUsd6Of(PROTOCOL, tokenId),
            manager.positionHandlerOf(PROTOCOL, tokenId),
            manager.protocolEnabledForOpen(PROTOCOL),
            manager.protocolEnabledForClose(PROTOCOL),
            manager.isPoolParamAllowed(PROTOCOL, POOL_PARAM),
            safeView.isModuleEnabled(MANAGER_ADDRESS),
        ]);
        const trackedShares = BigInt(shares);
        console.log("Manager:", MANAGER_ADDRESS, "| handler (protocol 3):", handlerAddress);
        console.log(
            "Switches: open",
            openOn,
            "close",
            closeOn,
            "| pool param allowed:",
            allowed,
            "| module enabled on Safe:",
            moduleOn,
        );
        console.log(
            "sUSDS rate (USDC per sUSDS):",
            ethers.formatEther(rate),
            "| PSM3 pocket USDC:",
            ethers.formatUnits(pocket, 6),
        );
        console.log(
            "Safe:",
            SAFE_ADDRESS,
            "| USDC",
            ethers.formatUnits(await usdc.balanceOf(SAFE_ADDRESS), 6),
            "| sUSDS",
            ethers.formatEther(await susds.balanceOf(SAFE_ADDRESS)),
        );
        console.log(
            "Position: pinned build",
            pinned,
            "| basis USDC",
            ethers.formatUnits(basis, 6),
            "| tracked shares",
            ethers.formatEther(trackedShares),
            trackedShares > 0n
                ? `(~${ethers.formatUnits((trackedShares * rate) / 10n ** 30n, 6)} USDC at the oracle rate)`
                : "",
        );
        return { rate, trackedShares, pinned, moduleOn };
    };

    const s = await status();
    if (ACTION === "status") return;

    const block = await provider.getBlock("latest");
    const deadline = BigInt(block!.timestamp) + DEADLINE_SECONDS;
    let target = MANAGER_ADDRESS;
    let data = "0x";
    let extra: MetaTransactionData[] = [];

    if (ACTION === "open") {
        if (!(await manager.protocolEnabledForOpen(PROTOCOL))) throw new Error("Protocol 3 is disabled for open");
        if (s.pinned !== ethers.ZeroAddress)
            throw new Error("This Safe already has an open savings position (no top-ups): close or withdraw first");
        const balance: bigint = await usdc.balanceOf(SAFE_ADDRESS);
        if (balance < usdcAmount)
            throw new Error(
                `Safe USDC ${ethers.formatUnits(balance, 6)} < requested ${ethers.formatUnits(usdcAmount, 6)}`,
            );
        const quoted: bigint = await psm3.previewSwapExactIn(USDC_ADDRESS, sUSDS_ADDRESS, usdcAmount);
        const floor = (((usdcAmount * 10n ** 12n * 10n ** 18n) / s.rate) * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n;
        console.log(
            "open:",
            ethers.formatUnits(usdcAmount, 6),
            "USDC -> PSM3 quotes",
            ethers.formatEther(quoted),
            "sUSDS | handler floor",
            ethers.formatEther(floor),
            `(tolerance ${SLIPPAGE_BPS} bps)`,
        );
        if (quoted < floor)
            throw new Error(
                "PSM3 pays below the oracle floor right now; raise SLIPPAGE_BPS within the handler's ceiling or wait",
            );
        data = manager.interface.encodeFunctionData("open", [
            PROTOCOL,
            {
                onBehalfOf: SAFE_ADDRESS,
                usdcAmount,
                tickLower: 0,
                tickUpper: 0,
                mintAmount0Min: 0,
                mintAmount1Min: 0,
                swap0: ZERO_LEG,
                swap1: ZERO_LEG,
                slippageBps: SLIPPAGE_BPS,
                deadline,
                poolParam: POOL_PARAM,
                stake: false,
            },
        ]);
    } else if (ACTION === "close") {
        if (s.pinned === ethers.ZeroAddress) throw new Error("No open savings position for this Safe");
        const toRedeem = EXIT_BPS === 10_000 ? s.trackedShares : (s.trackedShares * BigInt(EXIT_BPS)) / 10_000n;
        const quoted: bigint =
            toRedeem > 0n ? await psm3.previewSwapExactIn(sUSDS_ADDRESS, USDC_ADDRESS, toRedeem) : 0n;
        console.log(
            "close:",
            `exitBps ${EXIT_BPS}`,
            "redeems",
            ethers.formatEther(toRedeem),
            "sUSDS -> PSM3 quotes",
            ethers.formatUnits(quoted, 6),
            "USDC",
        );
        data = manager.interface.encodeFunctionData("close", [
            PROTOCOL,
            {
                onBehalfOf: SAFE_ADDRESS,
                tokenId,
                exitBps: EXIT_BPS,
                swap0: ZERO_LEG,
                swap1: ZERO_LEG,
                slippageBps: SLIPPAGE_BPS,
                decreaseAmount0Min: 0,
                decreaseAmount1Min: 0,
                deadline,
                minUsdcOut,
            },
        ]);
    } else if (ACTION === "withdraw") {
        if (s.pinned === ethers.ZeroAddress) throw new Error("No open savings position for this Safe");
        console.log(
            "withdraw: releases",
            ethers.formatEther(s.trackedShares),
            "sUSDS in kind (no price read, no PSM3 call); they stay on the Safe",
        );
        data = manager.interface.encodeFunctionData("withdraw", [
            PROTOCOL,
            { onBehalfOf: SAFE_ADDRESS, tokenId, decreaseAmount0Min: 0, decreaseAmount1Min: 0, deadline },
        ]);
    } else if (ACTION === "redeem-direct") {
        if (CALLER !== "safe") throw new Error("redeem-direct runs as the Safe owner (CALLER=safe)");
        const shares: bigint = await susds.balanceOf(SAFE_ADDRESS);
        if (shares === 0n) throw new Error("The Safe holds no sUSDS");
        const quoted: bigint = await psm3.previewSwapExactIn(sUSDS_ADDRESS, USDC_ADDRESS, shares);
        const minOut = (quoted * BigInt(10_000 - SLIPPAGE_BPS)) / 10_000n;
        console.log(
            "redeem-direct:",
            ethers.formatEther(shares),
            "sUSDS -> PSM3 quotes",
            ethers.formatUnits(quoted, 6),
            "USDC | minOut",
            ethers.formatUnits(minOut, 6),
        );
        const erc20 = new ethers.Interface(["function approve(address,uint256)"]);
        target = sUSDS_ADDRESS;
        data = erc20.encodeFunctionData("approve", [SPARK_PSM3_ADDRESS, shares]);
        extra = [
            {
                to: SPARK_PSM3_ADDRESS,
                value: "0",
                data: psm3.interface.encodeFunctionData("swapExactIn", [
                    sUSDS_ADDRESS,
                    USDC_ADDRESS,
                    shares,
                    minOut,
                    SAFE_ADDRESS,
                    OSERO_REFERRAL_CODE,
                ]),
                operation: OperationType.Call,
            },
            {
                to: sUSDS_ADDRESS,
                value: "0",
                data: erc20.encodeFunctionData("approve", [SPARK_PSM3_ADDRESS, 0]),
                operation: OperationType.Call,
            },
        ];
    }

    if (DRY_RUN) {
        console.log(`\nDRY_RUN — ${ACTION} calldata to ${target}:`);
        console.log(data);
        for (const tx of extra) console.log(`then to ${tx.to}:`, tx.data);
        return;
    }

    const rpcUrl = (network.config as { url?: string }).url;
    if (!rpcUrl) throw new Error(`Network ${network.name} has no RPC url — run with --network base`);
    let hash: string;
    if (CALLER === "operator") {
        const key = env("TESTING_SAFE_OPERATOR_KEY", env("OPERATOR_PRIVATE_KEY"));
        if (!key) throw new Error("Set TESTING_SAFE_OPERATOR_KEY (or OPERATOR_PRIVATE_KEY)");
        if (!s.moduleOn)
            throw new Error("The manager is not enabled as a module on this Safe; run once with CALLER=safe first");
        const operator = new ethers.Wallet(key, new ethers.JsonRpcProvider(rpcUrl));
        const tx = await operator.sendTransaction({ to: target, data });
        hash = tx.hash;
    } else {
        const ownerKey = resolveOwnerKey();
        if (!ownerKey) throw new Error("Set TESTING_SAFE_OWNER_KEY (or SAFE_OWNER_PRIVATE_KEY / DEPLOYER_PRIVATE_KEY)");
        const safeWallet = await Safe.init({ provider: rpcUrl, signer: ownerKey, safeAddress: SAFE_ADDRESS });
        if ((await safeWallet.getThreshold()) > 1)
            throw new Error("Safe threshold > 1: propose the printed calldata through the Safe UI instead");
        const transactions: MetaTransactionData[] = [];
        if (!s.moduleOn && target === MANAGER_ADDRESS) {
            console.log("Manager not enabled as a module — prepending enableModule");
            const safeIface = new ethers.Interface(["function enableModule(address)"]);
            transactions.push({
                to: SAFE_ADDRESS,
                value: "0",
                data: safeIface.encodeFunctionData("enableModule", [MANAGER_ADDRESS]),
                operation: OperationType.Call,
            });
        }
        transactions.push({ to: target, value: "0", data, operation: OperationType.Call }, ...extra);
        const result = await safeWallet.executeTransaction(await safeWallet.createTransaction({ transactions }));
        hash = result.hash;
    }
    console.log("Submitted:", hash);
    const receipt = await waitForReceipt(provider, hash);
    console.log("Confirmed in block", receipt.blockNumber);

    const eventTables: Array<[{ interface: { parseLog(log: { topics: string[]; data: string }): any } }, string[]]> = [
        [manager, ["PositionOpened", "PositionClosed", "PositionWithdrawn"]],
        [handlerEvents, ["SavingsDeposited", "SavingsRedeemed", "SavingsReleased", "SavingsSharesShortfall"]],
    ];
    for (const [contract, names] of eventTables) {
        for (const log of receipt.logs) {
            if (log.address.toLowerCase() !== MANAGER_ADDRESS.toLowerCase()) continue;
            const parsed = contract.interface.parseLog({ topics: [...log.topics], data: log.data });
            if (parsed && names.includes(parsed.name)) console.log(`${parsed.name}:`, parsed.args.toObject());
        }
    }
    console.log("\nAfter:");
    await status();
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
