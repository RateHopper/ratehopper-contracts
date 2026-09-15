import { ethers } from "hardhat";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// Canonical Safe v1.4.1 deployments on Base mainnet.
const SAFE_PROXY_FACTORY_ADDRESS = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
const SAFE_L2_SINGLETON_ADDRESS = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";
const COMPATIBILITY_FALLBACK_HANDLER_ADDRESS = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99";

const FACTORY_ABI = [
    "function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
    "event ProxyCreation(address indexed proxy, address singleton)",
];
const SAFE_ABI = [
    "function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
    "function enableModule(address module)",
    "function isModuleEnabled(address module) view returns (bool)",
    "function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)",
];

/// Deploys a real Safe proxy (v1.4.1 L2 singleton, CompatibilityFallbackHandler)
/// on the fork with `owner` as its sole owner at threshold 1.
export async function deployRealSafe(owner: HardhatEthersSigner): Promise<string> {
    const factory = new ethers.Contract(SAFE_PROXY_FACTORY_ADDRESS, FACTORY_ABI, owner);
    const initializer = new ethers.Interface(SAFE_ABI).encodeFunctionData("setup", [
        [owner.address],
        1,
        ethers.ZeroAddress,
        "0x",
        COMPATIBILITY_FALLBACK_HANDLER_ADDRESS,
        ethers.ZeroAddress,
        0,
        ethers.ZeroAddress,
    ]);
    const receipt = await (await factory.createProxyWithNonce(SAFE_L2_SINGLETON_ADDRESS, initializer, 0)).wait();
    const created = receipt!.logs
        .map((log) => {
            try {
                return factory.interface.parseLog(log);
            } catch {
                return null;
            }
        })
        .find((parsed) => parsed?.name === "ProxyCreation");
    if (!created) throw new Error("ProxyCreation event not found");
    return created.args.proxy as string;
}

/// Enables `module` on the Safe through a real owner-executed execTransaction,
/// using the pre-validated signature scheme (v = 1, msg.sender == owner).
export async function enableModuleOnSafe(
    safeAddress: string,
    owner: HardhatEthersSigner,
    module: string,
): Promise<void> {
    const safe = new ethers.Contract(safeAddress, SAFE_ABI, owner);
    const data = safe.interface.encodeFunctionData("enableModule", [module]);
    const preValidatedSignature = ethers.concat([ethers.zeroPadValue(owner.address, 32), ethers.ZeroHash, "0x01"]);
    await (
        await safe.execTransaction(
            safeAddress,
            0,
            data,
            0,
            0,
            0,
            0,
            ethers.ZeroAddress,
            ethers.ZeroAddress,
            preValidatedSignature,
        )
    ).wait();
    if (!(await safe.isModuleEnabled(module))) throw new Error("module not enabled on Safe");
}
