import { time, loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
const { expect } = require("chai");
import { ethers, upgrades } from "hardhat";

import "dotenv/config";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { LeveragedPosition } from "../typechain-types";
import morphoAbi from "../externalAbi/morpho/morpho.json";
import { abi as ERC20_ABI } from "@openzeppelin/contracts/build/contracts/ERC20.json";
import { approve, getDecimals, getParaswapData, protocolHelperMap } from "./utils";
import { Protocols } from "./constants";

describe.skip("Upgrade contract", function () {
    let impersonatedSigner: HardhatEthersSigner;

    let deployedContractAddress: string;

    this.beforeEach(async () => {
        const SafeDebtManager = await ethers.getContractFactory("SafeDebtManagerUpgradeable");

        // Prepare constructor arguments for initialize
        const protocols = [Protocols.AAVE_V3];
        const handlers = ["0x123"];

        // Deploy as upgradeable using UUPS proxy
        const safeDebtManager = await upgrades.deployProxy(SafeDebtManager, [protocols, handlers], {
            kind: "uups",
            initializer: "initialize",
        });

        await safeDebtManager.deployed();
        console.log("SafeDebtManager deployed to:", safeDebtManager.address);
    });

    it("deploy contract", async function () {
        console.log("deployed");
    });
});
