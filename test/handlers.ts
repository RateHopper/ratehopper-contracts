import { expect } from "chai";
import { connectNetwork, getEthers, loadFixture } from "./testSetup.js";
import { TEST_ADDRESS, USDC_ADDRESS, DAI_ADDRESS, MAI_ADDRESS } from "./constants.js";
import { deployHandlers, deployMaliciousUniswapV3Pool } from "./deployUtils.js";

describe("Handler contracts should", function () {
    let aaveV3Handler;
    let compoundHandler;
    let moonwellHandler;
    let fluidHandler;
    let morphoHandler;
    let protocolRegistry;

    before(async function () {
        await connectNetwork();
    });

    this.beforeEach(async () => {
        ({ aaveV3Handler, compoundHandler, moonwellHandler, fluidHandler, morphoHandler, protocolRegistry } =
            await loadFixture(deployHandlers));
    });

    it("revert when calling directly with default signer", async function () {
        const ethers = getEthers();
        await expect(aaveV3Handler.borrow(USDC_ADDRESS, ethers.parseUnits("1", 6), TEST_ADDRESS, "0x")).to.be.revert(
            ethers,
        );
    });

    it("revert when calling directly with another signer", async function () {
        const ethers = getEthers();
        const [, signer1] = await ethers.getSigners();
        const aaveV3HandlerWithSigner1 = aaveV3Handler.connect(signer1);

        await expect(
            aaveV3HandlerWithSigner1.borrow(USDC_ADDRESS, ethers.parseUnits("1", 6), TEST_ADDRESS, "0x"),
        ).to.be.revert(ethers);
    });

    it("CompoundHandler should revert when calling borrow directly with default signer", async function () {
        const ethers = getEthers();
        await expect(compoundHandler.borrow(USDC_ADDRESS, ethers.parseUnits("1", 6), TEST_ADDRESS, "0x")).to.be.revert(
            ethers,
        );
    });

    it("CompoundHandler should revert when calling borrow directly with another signer", async function () {
        const ethers = getEthers();
        const [, signer1] = await ethers.getSigners();
        const compoundHandlerWithSigner1 = compoundHandler.connect(signer1);

        await expect(
            compoundHandlerWithSigner1.borrow(USDC_ADDRESS, ethers.parseUnits("1", 6), TEST_ADDRESS, "0x"),
        ).to.be.revert(ethers);
    });

    it("MoonwellHandler should revert when calling borrow directly with default signer", async function () {
        const ethers = getEthers();
        await expect(moonwellHandler.borrow(USDC_ADDRESS, ethers.parseUnits("1", 6), TEST_ADDRESS, "0x")).to.be.revert(
            ethers,
        );
    });

    it("FluidHandler should revert when calling borrow directly with default signer", async function () {
        const ethers = getEthers();
        await expect(fluidHandler.borrow(USDC_ADDRESS, ethers.parseUnits("1", 6), TEST_ADDRESS, "0x")).to.be.revert(
            ethers,
        );
    });

    it("MorphoHandler should revert when calling borrow directly with default signer", async function () {
        const ethers = getEthers();
        await expect(morphoHandler.borrow(USDC_ADDRESS, ethers.parseUnits("1", 6), TEST_ADDRESS, "0x")).to.be.revert(
            ethers,
        );
    });


    describe("Malicious contract security tests", function () {
        let maliciousPool: any;
        let maliciousPoolCompound: any;

        beforeEach(async function () {
            maliciousPool = await deployMaliciousUniswapV3Pool(await aaveV3Handler.getAddress());
            maliciousPoolCompound = await deployMaliciousUniswapV3Pool(await compoundHandler.getAddress());
        });

        it("should revert malicious pool attempting borrow", async function () {
            const ethers = getEthers();
            expect(await maliciousPool.token0()).to.equal(USDC_ADDRESS);
            expect(await maliciousPool.fee()).to.equal(3000);
            expect(await maliciousPool.targetHandler()).to.equal(await aaveV3Handler.getAddress());

            await expect(maliciousPool.attemptMaliciousBorrow(USDC_ADDRESS, 1000, TEST_ADDRESS)).to.be.revert(ethers);
        });

        it("should revert malicious pool attempting CompoundHandler borrow", async function () {
            const ethers = getEthers();
            expect(await maliciousPoolCompound.token0()).to.equal(USDC_ADDRESS);
            expect(await maliciousPoolCompound.fee()).to.equal(3000);
            expect(await maliciousPoolCompound.targetHandler()).to.equal(await compoundHandler.getAddress());

            await expect(maliciousPoolCompound.attemptMaliciousBorrow(USDC_ADDRESS, 1000, TEST_ADDRESS)).to.be.revert(
                ethers,
            );
        });

        it("should revert malicious pool attempting CompoundHandler borrow with unregistered token", async function () {
            const ethers = getEthers();
            // Try to borrow MAI which is not registered in Compound protocol
            await expect(maliciousPoolCompound.attemptMaliciousBorrow(MAI_ADDRESS, 1000, TEST_ADDRESS)).to.be.revert(
                ethers,
            );
        });
    });
});
