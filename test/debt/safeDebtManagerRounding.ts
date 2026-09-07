import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, setCode } from "@nomicfoundation/hardhat-network-helpers";

async function deployRoundingFixture() {
    const [admin, operator, safe, repaymentSink, factory] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const fromAsset = await Token.deploy("Source", "SRC", 18);
    const toAsset = await Token.deploy("Destination", "DST", 6);
    const fromAddress = await fromAsset.getAddress();
    const toAddress = await toAsset.getAddress();
    const [token0, token1] = [fromAddress, toAddress].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));

    const Pool = await ethers.getContractFactory("MockDebtRoundingFlashPool");
    const poolTemplate = await Pool.deploy(token0, token1);
    // Keep production CallbackValidation intact: the callback must originate
    // from the address derived for this factory, pair and fee tier.
    const poolAddress = ethers.getCreate2Address(
        factory.address,
        ethers.keccak256(
            ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24"], [token0, token1, 500]),
        ),
        "0xe34f199b19b2b4f47f68442619d555527d244f78a3297ea89325f843f87b8b54",
    );
    await setCode(poolAddress, await ethers.provider.getCode(await poolTemplate.getAddress()));

    const Swap = await ethers.getContractFactory("MockDebtRoundingSwap");
    const swap = await Swap.deploy();
    const Handler = await ethers.getContractFactory("MockDebtRoundingHandler");
    const handler = await Handler.deploy(repaymentSink.address);
    const Registry = await ethers.getContractFactory("ProtocolRegistry");
    const registry = await Registry.deploy(
        fromAddress,
        factory.address,
        admin.address,
        admin.address,
        operator.address,
        await swap.getAddress(),
    );
    const Manager = await ethers.getContractFactory("SafeDebtManager");
    const manager = await Manager.deploy(
        await registry.getAddress(),
        [0, 1],
        [await handler.getAddress(), await handler.getAddress()],
        admin.address,
    );
    await fromAsset.mint(poolAddress, ethers.parseUnits("10", 18));
    return { operator, safe, repaymentSink, fromAsset, toAsset, poolAddress, swap, handler, manager };
}

describe("SafeDebtManager flash principal rounding (Shred L-4)", function () {
    for (const { principal, expectedInput, expectedDust } of [
        { principal: 1_000_000_000_000_000_001n, expectedInput: 1_000_002n, expectedDust: 999_999_999_999n },
        { principal: 1_000_000_000_000_000_000n, expectedInput: 1_000_001n, expectedDust: 0n },
    ]) {
        it(`repays the exact flash debt with 18 -> 6 decimals and srcAmount == 0 (principal ${principal})`, async function () {
            const { operator, safe, repaymentSink, fromAsset, toAsset, poolAddress, swap, handler, manager } =
                await loadFixture(deployRoundingFixture);
            const managerAddress = await manager.getAddress();
            const swapAddress = await swap.getAddress();
            const fromAddress = await fromAsset.getAddress();
            const toAddress = await toAsset.getAddress();
            const poolBefore = await fromAsset.balanceOf(poolAddress);
            const flashFee = 1_000_000_000_000n;

            const tx = manager
                .connect(operator)
                .executeDebtSwap(poolAddress, 0, 1, fromAddress, toAddress, principal, [], safe.address, ["0x", "0x"], {
                    srcAmount: 0,
                    swapData: swap.interface.encodeFunctionData("swap", [toAddress, fromAddress]),
                });

            // Both the destination borrow and actual swap must include the
            // rounded-up principal plus the fee. Floor division underfunds the
            // non-divisible case by one source wei and makes the callback revert.
            await expect(tx).to.emit(manager, "DebtSwapped");
            await expect(tx).to.emit(handler.attach(managerAddress), "Borrowed").withArgs(toAddress, expectedInput);
            await expect(tx)
                .to.emit(swap, "Swapped")
                .withArgs(expectedInput, expectedInput * 1_000_000_000_000n);
            expect(await fromAsset.balanceOf(repaymentSink.address)).to.equal(principal);
            expect(await fromAsset.balanceOf(poolAddress)).to.equal(poolBefore + flashFee);
            expect(await fromAsset.balanceOf(safe.address)).to.equal(expectedDust);
            expect(await fromAsset.balanceOf(managerAddress)).to.equal(0n);
            expect(await toAsset.balanceOf(managerAddress)).to.equal(0n);
            expect(await toAsset.allowance(managerAddress, swapAddress)).to.equal(0n);
        });
    }
});
