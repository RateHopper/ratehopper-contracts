import { expect } from "chai";
import * as ethersLib from "ethers";
import "dotenv/config";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { LeveragedPosition } from "../typechain-types/index.js";
import morphoAbi from "../externalAbi/morpho/morpho.json" with { type: "json" };
import ERC20Json from "@openzeppelin/contracts/build/contracts/ERC20.json" with { type: "json" };
const ERC20_ABI = ERC20Json.abi;
import { approve, getDecimals, getParaswapData, protocolHelperMap } from "./utils.js";
import { Protocols } from "./constants.js";
import { connectNetwork, getEthers, loadFixture } from "./testSetup.js";

// SKIPPED: This test requires @openzeppelin/hardhat-upgrades which is not yet compatible with Hardhat 3
describe.skip("Upgrade contract", function () {
    let impersonatedSigner: HardhatEthersSigner;
    let deployedContractAddress: string;

    before(async function () {
        await connectNetwork();
    });

    this.beforeEach(async () => {
        const ethers = getEthers();
        const SafeDebtManager = await ethers.getContractFactory("SafeDebtManagerUpgradeable");

        // Note: upgrades.deployProxy is not available in Hardhat 3 yet
        // Prepare constructor arguments for initialize
        const protocols = [Protocols.AAVE_V3];
        const handlers = ["0x123"];

        // TODO: Re-enable when @openzeppelin/hardhat-upgrades supports Hardhat 3
        // Deploy as upgradeable using UUPS proxy
        // const safeDebtManager = await upgrades.deployProxy(SafeDebtManager, [protocols, handlers], {
        //     kind: "uups",
        //     initializer: "initialize",
        // });
        // await safeDebtManager.deployed();
        // console.log("SafeDebtManager deployed to:", safeDebtManager.address);
    });

    it("deploy contract", async function () {
        console.log("deployed");
    });
});
