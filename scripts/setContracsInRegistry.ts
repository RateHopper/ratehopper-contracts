import { getCTokenMappingArrays, getMTokenMappingArrays } from "../contractAddresses";
import { ethers } from "ethers";

const [mTokens, mContracts] = getMTokenMappingArrays();

async function setContractsInRegistry(registry: ethers.Contract) {
    await registry.batchSetTokenMContracts(mTokens, mContracts);
    console.log("Moonwell token mappings set in ProtocolRegistry");

    const [cTokens, cContracts] = getCTokenMappingArrays();
    await registry.batchSetTokenCContracts(cTokens, cContracts);
    console.log("Compound token mappings set in ProtocolRegistry");
}

async function main() {
    const provider = new ethers.JsonRpcProvider("https://base.llamarpc.com");
    const signer = new ethers.Wallet(process.env.TESTING_SAFE_OWNER_KEY!, provider);
    const senderAddress = signer.address;

    // Get the contract ABI
    const registryAbi = require("../artifacts/contracts/ProtocolRegistry.sol/ProtocolRegistry.json").abi;
    const registry = new ethers.Contract("0xc2b45C4FCaEAE99e609Dd2aAB1684ffBbb95fDEa", registryAbi, signer);

    await setContractsInRegistry(registry);
}

main();
