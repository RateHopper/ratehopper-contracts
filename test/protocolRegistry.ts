import { expect } from "chai";
import * as ethersLib from "ethers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { ProtocolRegistry } from "../typechain-types/index.js";
import { connectNetwork, getEthers, loadFixture } from "./testSetup.js";
import { USDC_ADDRESS, cbETH_ADDRESS, WETH_ADDRESS, DAI_ADDRESS } from "./constants.js";
import { PARASWAP_V6_CONTRACT_ADDRESS, UNISWAP_V3_FACTORY_ADDRESS } from "../contractAddresses.js";

describe("ProtocolRegistry - setTokenMContract and setTokenCContract Tests", function () {
    let protocolRegistry: ProtocolRegistry;
    let owner: HardhatEthersSigner;
    let nonOwner: HardhatEthersSigner;
    let mockMContract: HardhatEthersSigner;
    let mockCContract: HardhatEthersSigner;

    before(async function () {
        await connectNetwork();
    });

    async function deployProtocolRegistryFixture() {
        const ethers = getEthers();
        const [owner, nonOwner, operator, mockMContract, mockCContract] = await ethers.getSigners();

        // Deploy a dummy timelock for testing
        // In Hardhat 3, we use the wrapper contract from Imports.sol
        const TimelockController = await ethers.getContractFactory("TimelockControllerForTest");
        const timelock = await TimelockController.deploy(
            0, // 0 delay for testing
            [owner.address],
            [owner.address],
            ethersLib.ZeroAddress,
        );
        await timelock.waitForDeployment();

        const ProtocolRegistry = await ethers.getContractFactory("ProtocolRegistry");
        const protocolRegistry = await ProtocolRegistry.deploy(
            WETH_ADDRESS,
            UNISWAP_V3_FACTORY_ADDRESS,
            owner.address, // initial admin
            await timelock.getAddress(), // timelock
            operator.address, // operator
            PARASWAP_V6_CONTRACT_ADDRESS,
        );
        await protocolRegistry.waitForDeployment();

        return {
            protocolRegistry,
            owner,
            nonOwner,
            mockMContract,
            mockCContract,
        };
    }

    beforeEach(async function () {
        const fixture = await loadFixture(deployProtocolRegistryFixture);
        protocolRegistry = fixture.protocolRegistry as ProtocolRegistry;
        owner = fixture.owner;
        nonOwner = fixture.nonOwner;
        mockMContract = fixture.mockMContract;
        mockCContract = fixture.mockCContract;
    });

    describe("setTokenMContract", function () {
        describe("Success Cases", function () {
            it("Should set token to mContract mapping successfully", async function () {
                await protocolRegistry.setTokenMContract(USDC_ADDRESS, mockMContract.address);

                const mContract = await protocolRegistry.getMContract(USDC_ADDRESS);
                expect(mContract).to.equal(mockMContract.address);
            });

            it("Should allow setting multiple different tokens", async function () {
                await protocolRegistry.setTokenMContract(USDC_ADDRESS, mockMContract.address);
                await protocolRegistry.setTokenMContract(cbETH_ADDRESS, mockCContract.address);

                expect(await protocolRegistry.getMContract(USDC_ADDRESS)).to.equal(mockMContract.address);
                expect(await protocolRegistry.getMContract(cbETH_ADDRESS)).to.equal(mockCContract.address);
            });

            it("Should allow overwriting existing mapping", async function () {
                // Set initial mapping
                await protocolRegistry.setTokenMContract(USDC_ADDRESS, mockMContract.address);
                expect(await protocolRegistry.getMContract(USDC_ADDRESS)).to.equal(mockMContract.address);

                // Overwrite with new mapping
                await protocolRegistry.setTokenMContract(USDC_ADDRESS, mockCContract.address);
                expect(await protocolRegistry.getMContract(USDC_ADDRESS)).to.equal(mockCContract.address);
            });

            it("Should allow setting mContract to zero address", async function () {
                // First set a valid mapping
                await protocolRegistry.setTokenMContract(USDC_ADDRESS, mockMContract.address);
                expect(await protocolRegistry.getMContract(USDC_ADDRESS)).to.equal(mockMContract.address);

                // Then set to zero address (effectively removing the mapping)
                await protocolRegistry.setTokenMContract(USDC_ADDRESS, ethersLib.ZeroAddress);
                expect(await protocolRegistry.getMContract(USDC_ADDRESS)).to.equal(ethersLib.ZeroAddress);
            });
        });

        describe("Access Control", function () {
            it("Should revert when called by non-admin", async function () {
                const DEFAULT_ADMIN_ROLE = await protocolRegistry.DEFAULT_ADMIN_ROLE();
                await expect(protocolRegistry.connect(nonOwner).setTokenMContract(USDC_ADDRESS, mockMContract.address))
                    .to.be.revertedWithCustomError(protocolRegistry, "AccessControlUnauthorizedAccount")
                    .withArgs(nonOwner.address, DEFAULT_ADMIN_ROLE);
            });

            it("Should only allow admin to call the function", async function () {
                const ethers = getEthers();
                // Owner (has DEFAULT_ADMIN_ROLE) should succeed
                await expect(
                    protocolRegistry.connect(owner).setTokenMContract(USDC_ADDRESS, mockMContract.address),
                ).to.not.be.revert(ethers);

                // Non-admin should fail
                const DEFAULT_ADMIN_ROLE = await protocolRegistry.DEFAULT_ADMIN_ROLE();
                await expect(protocolRegistry.connect(nonOwner).setTokenMContract(cbETH_ADDRESS, mockMContract.address))
                    .to.be.revertedWithCustomError(protocolRegistry, "AccessControlUnauthorizedAccount")
                    .withArgs(nonOwner.address, DEFAULT_ADMIN_ROLE);
            });
        });

        describe("Input Validation", function () {
            it("Should revert when token address is zero", async function () {
                await expect(
                    protocolRegistry.setTokenMContract(ethersLib.ZeroAddress, mockMContract.address),
                ).to.be.revertedWithCustomError(protocolRegistry, "ZeroAddress");
            });

            it("Should not revert when mContract address is zero", async function () {
                const ethers = getEthers();
                await expect(protocolRegistry.setTokenMContract(USDC_ADDRESS, ethersLib.ZeroAddress)).to.not.be.revert(
                    ethers,
                );
            });
        });

        describe("Edge Cases", function () {
            it("Should handle setting same token and mContract address", async function () {
                await protocolRegistry.setTokenMContract(USDC_ADDRESS, USDC_ADDRESS);
                expect(await protocolRegistry.getMContract(USDC_ADDRESS)).to.equal(USDC_ADDRESS);
            });

            it("Should return zero address for non-existent mappings", async function () {
                expect(await protocolRegistry.getMContract(WETH_ADDRESS)).to.equal(ethersLib.ZeroAddress);
            });
        });
    });

    describe("setTokenCContract", function () {
        describe("Success Cases", function () {
            it("Should set token to cContract mapping successfully", async function () {
                await protocolRegistry.setTokenCContract(USDC_ADDRESS, mockCContract.address);

                const cContract = await protocolRegistry.getCContract(USDC_ADDRESS);
                expect(cContract).to.equal(mockCContract.address);
            });

            it("Should allow setting multiple different tokens", async function () {
                await protocolRegistry.setTokenCContract(USDC_ADDRESS, mockCContract.address);
                await protocolRegistry.setTokenCContract(cbETH_ADDRESS, mockMContract.address);

                expect(await protocolRegistry.getCContract(USDC_ADDRESS)).to.equal(mockCContract.address);
                expect(await protocolRegistry.getCContract(cbETH_ADDRESS)).to.equal(mockMContract.address);
            });

            it("Should allow overwriting existing mapping", async function () {
                // Set initial mapping
                await protocolRegistry.setTokenCContract(USDC_ADDRESS, mockCContract.address);
                expect(await protocolRegistry.getCContract(USDC_ADDRESS)).to.equal(mockCContract.address);

                // Overwrite with new mapping
                await protocolRegistry.setTokenCContract(USDC_ADDRESS, mockMContract.address);
                expect(await protocolRegistry.getCContract(USDC_ADDRESS)).to.equal(mockMContract.address);
            });

            it("Should allow setting cContract to zero address", async function () {
                // First set a valid mapping
                await protocolRegistry.setTokenCContract(USDC_ADDRESS, mockCContract.address);
                expect(await protocolRegistry.getCContract(USDC_ADDRESS)).to.equal(mockCContract.address);

                // Then set to zero address (effectively removing the mapping)
                await protocolRegistry.setTokenCContract(USDC_ADDRESS, ethersLib.ZeroAddress);
                expect(await protocolRegistry.getCContract(USDC_ADDRESS)).to.equal(ethersLib.ZeroAddress);
            });
        });

        describe("Access Control", function () {
            it("Should revert when called by non-admin", async function () {
                const DEFAULT_ADMIN_ROLE = await protocolRegistry.DEFAULT_ADMIN_ROLE();
                await expect(protocolRegistry.connect(nonOwner).setTokenCContract(USDC_ADDRESS, mockCContract.address))
                    .to.be.revertedWithCustomError(protocolRegistry, "AccessControlUnauthorizedAccount")
                    .withArgs(nonOwner.address, DEFAULT_ADMIN_ROLE);
            });

            it("Should only allow admin to call the function", async function () {
                const ethers = getEthers();
                // Owner (has DEFAULT_ADMIN_ROLE) should succeed
                await expect(
                    protocolRegistry.connect(owner).setTokenCContract(USDC_ADDRESS, mockCContract.address),
                ).to.not.be.revert(ethers);

                // Non-admin should fail
                const DEFAULT_ADMIN_ROLE = await protocolRegistry.DEFAULT_ADMIN_ROLE();
                await expect(protocolRegistry.connect(nonOwner).setTokenCContract(cbETH_ADDRESS, mockCContract.address))
                    .to.be.revertedWithCustomError(protocolRegistry, "AccessControlUnauthorizedAccount")
                    .withArgs(nonOwner.address, DEFAULT_ADMIN_ROLE);
            });
        });

        describe("Input Validation", function () {
            it("Should revert when token address is zero", async function () {
                await expect(
                    protocolRegistry.setTokenCContract(ethersLib.ZeroAddress, mockCContract.address),
                ).to.be.revertedWithCustomError(protocolRegistry, "ZeroAddress");
            });

            it("Should not revert when cContract address is zero", async function () {
                const ethers = getEthers();
                await expect(protocolRegistry.setTokenCContract(USDC_ADDRESS, ethersLib.ZeroAddress)).to.not.be.revert(
                    ethers,
                );
            });
        });

        describe("Edge Cases", function () {
            it("Should handle setting same token and cContract address", async function () {
                await protocolRegistry.setTokenCContract(USDC_ADDRESS, USDC_ADDRESS);
                expect(await protocolRegistry.getCContract(USDC_ADDRESS)).to.equal(USDC_ADDRESS);
            });

            it("Should return zero address for non-existent mappings", async function () {
                expect(await protocolRegistry.getCContract(WETH_ADDRESS)).to.equal(ethersLib.ZeroAddress);
            });
        });
    });

    describe("removeFromWhitelist", function () {
        describe("Success Cases", function () {
            it("Should remove token from whitelist successfully", async function () {
                // First add token to whitelist
                await protocolRegistry.addToWhitelist(USDC_ADDRESS);
                expect(await protocolRegistry.isWhitelisted(USDC_ADDRESS)).to.be.true;

                // Then remove it
                const tx = await protocolRegistry.removeFromWhitelist(USDC_ADDRESS);

                expect(await protocolRegistry.isWhitelisted(USDC_ADDRESS)).to.be.false;
                expect(await protocolRegistry.whitelistedTokens(USDC_ADDRESS)).to.be.false;

                // Check event emission
                await expect(tx)
                    .to.emit(protocolRegistry, "TokenRemovedFromWhitelist")
                    .withArgs(USDC_ADDRESS, owner.address);
            });

            it("Should allow removing multiple different tokens", async function () {
                // Add multiple tokens to whitelist
                await protocolRegistry.addToWhitelist(USDC_ADDRESS);
                await protocolRegistry.addToWhitelist(cbETH_ADDRESS);
                await protocolRegistry.addToWhitelist(WETH_ADDRESS);

                // Verify they are whitelisted
                expect(await protocolRegistry.isWhitelisted(USDC_ADDRESS)).to.be.true;
                expect(await protocolRegistry.isWhitelisted(cbETH_ADDRESS)).to.be.true;
                expect(await protocolRegistry.isWhitelisted(WETH_ADDRESS)).to.be.true;

                // Remove them one by one
                await protocolRegistry.removeFromWhitelist(USDC_ADDRESS);
                await protocolRegistry.removeFromWhitelist(cbETH_ADDRESS);

                // Check status
                expect(await protocolRegistry.isWhitelisted(USDC_ADDRESS)).to.be.false;
                expect(await protocolRegistry.isWhitelisted(cbETH_ADDRESS)).to.be.false;
                expect(await protocolRegistry.isWhitelisted(WETH_ADDRESS)).to.be.true; // Still whitelisted
            });

            it("Should emit correct event with token and owner address", async function () {
                // Add token first
                await protocolRegistry.addToWhitelist(DAI_ADDRESS);

                // Remove and check event
                await expect(protocolRegistry.removeFromWhitelist(DAI_ADDRESS))
                    .to.emit(protocolRegistry, "TokenRemovedFromWhitelist")
                    .withArgs(DAI_ADDRESS, owner.address);
            });

            it("Should maintain state consistency after removal", async function () {
                // Add token
                await protocolRegistry.addToWhitelist(USDC_ADDRESS);
                expect(await protocolRegistry.isWhitelisted(USDC_ADDRESS)).to.be.true;
                expect(await protocolRegistry.whitelistedTokens(USDC_ADDRESS)).to.be.true;

                // Remove token
                await protocolRegistry.removeFromWhitelist(USDC_ADDRESS);
                expect(await protocolRegistry.isWhitelisted(USDC_ADDRESS)).to.be.false;
                expect(await protocolRegistry.whitelistedTokens(USDC_ADDRESS)).to.be.false;
            });
        });

        describe("Access Control", function () {
            it("Should revert when called by non-admin", async function () {
                // Add token first as owner
                await protocolRegistry.addToWhitelist(USDC_ADDRESS);

                // Try to remove as non-admin
                const DEFAULT_ADMIN_ROLE = await protocolRegistry.DEFAULT_ADMIN_ROLE();
                await expect(protocolRegistry.connect(nonOwner).removeFromWhitelist(USDC_ADDRESS))
                    .to.be.revertedWithCustomError(protocolRegistry, "AccessControlUnauthorizedAccount")
                    .withArgs(nonOwner.address, DEFAULT_ADMIN_ROLE);
            });

            it("Should only allow admin to call the function", async function () {
                const ethers = getEthers();
                // Add tokens first
                await protocolRegistry.addToWhitelist(USDC_ADDRESS);
                await protocolRegistry.addToWhitelist(cbETH_ADDRESS);

                // Owner (has DEFAULT_ADMIN_ROLE) should succeed
                await expect(protocolRegistry.connect(owner).removeFromWhitelist(USDC_ADDRESS)).to.not.be.revert(ethers);

                // Non-admin should fail
                const DEFAULT_ADMIN_ROLE = await protocolRegistry.DEFAULT_ADMIN_ROLE();
                await expect(protocolRegistry.connect(nonOwner).removeFromWhitelist(cbETH_ADDRESS))
                    .to.be.revertedWithCustomError(protocolRegistry, "AccessControlUnauthorizedAccount")
                    .withArgs(nonOwner.address, DEFAULT_ADMIN_ROLE);
            });
        });

        describe("Input Validation", function () {
            it("Should revert when token address is zero", async function () {
                await expect(protocolRegistry.removeFromWhitelist(ethersLib.ZeroAddress)).to.be.revertedWithCustomError(
                    protocolRegistry,
                    "ZeroAddress",
                );
            });

            it("Should revert when token is not whitelisted", async function () {
                // Try to remove a token that was never whitelisted
                await expect(protocolRegistry.removeFromWhitelist(USDC_ADDRESS)).to.be.revertedWith(
                    "Token not whitelisted",
                );
            });

            it("Should revert when trying to remove already removed token", async function () {
                // Add and remove token
                await protocolRegistry.addToWhitelist(USDC_ADDRESS);
                await protocolRegistry.removeFromWhitelist(USDC_ADDRESS);

                // Try to remove again
                await expect(protocolRegistry.removeFromWhitelist(USDC_ADDRESS)).to.be.revertedWith(
                    "Token not whitelisted",
                );
            });
        });

        describe("Edge Cases", function () {
            it("Should handle add/remove cycle correctly", async function () {
                // Add token
                await protocolRegistry.addToWhitelist(USDC_ADDRESS);
                expect(await protocolRegistry.isWhitelisted(USDC_ADDRESS)).to.be.true;

                // Remove token
                await protocolRegistry.removeFromWhitelist(USDC_ADDRESS);
                expect(await protocolRegistry.isWhitelisted(USDC_ADDRESS)).to.be.false;

                // Add again
                await protocolRegistry.addToWhitelist(USDC_ADDRESS);
                expect(await protocolRegistry.isWhitelisted(USDC_ADDRESS)).to.be.true;

                // Remove again
                await protocolRegistry.removeFromWhitelist(USDC_ADDRESS);
                expect(await protocolRegistry.isWhitelisted(USDC_ADDRESS)).to.be.false;
            });

            it("Should not affect other token mappings when removing from whitelist", async function () {
                // Set up other mappings for the token
                await protocolRegistry.setTokenMContract(USDC_ADDRESS, mockMContract.address);
                await protocolRegistry.setTokenCContract(USDC_ADDRESS, mockCContract.address);
                await protocolRegistry.addToWhitelist(USDC_ADDRESS);

                // Verify all mappings exist
                expect(await protocolRegistry.getMContract(USDC_ADDRESS)).to.equal(mockMContract.address);
                expect(await protocolRegistry.getCContract(USDC_ADDRESS)).to.equal(mockCContract.address);
                expect(await protocolRegistry.isWhitelisted(USDC_ADDRESS)).to.be.true;

                // Remove from whitelist
                await protocolRegistry.removeFromWhitelist(USDC_ADDRESS);

                // Other mappings should still exist
                expect(await protocolRegistry.getMContract(USDC_ADDRESS)).to.equal(mockMContract.address);
                expect(await protocolRegistry.getCContract(USDC_ADDRESS)).to.equal(mockCContract.address);
                expect(await protocolRegistry.isWhitelisted(USDC_ADDRESS)).to.be.false;
            });

            it("Should return false for removed tokens in batch queries", async function () {
                const tokens = [USDC_ADDRESS, cbETH_ADDRESS, WETH_ADDRESS];

                // Add all tokens
                for (const token of tokens) {
                    await protocolRegistry.addToWhitelist(token);
                }

                // Remove middle token
                await protocolRegistry.removeFromWhitelist(cbETH_ADDRESS);

                // Check individual status
                expect(await protocolRegistry.isWhitelisted(USDC_ADDRESS)).to.be.true;
                expect(await protocolRegistry.isWhitelisted(cbETH_ADDRESS)).to.be.false;
                expect(await protocolRegistry.isWhitelisted(WETH_ADDRESS)).to.be.true;
            });
        });

        describe("Integration with addToWhitelist", function () {
            it("Should be able to add token after removal", async function () {
                const ethers = getEthers();
                // Add token
                await protocolRegistry.addToWhitelist(USDC_ADDRESS);
                expect(await protocolRegistry.isWhitelisted(USDC_ADDRESS)).to.be.true;

                // Remove token
                await protocolRegistry.removeFromWhitelist(USDC_ADDRESS);
                expect(await protocolRegistry.isWhitelisted(USDC_ADDRESS)).to.be.false;

                // Add token again (should not revert with "already whitelisted")
                await expect(protocolRegistry.addToWhitelist(USDC_ADDRESS)).to.not.be.revert(ethers);
                expect(await protocolRegistry.isWhitelisted(USDC_ADDRESS)).to.be.true;
            });

            it("Should handle tokens added via batch and removed individually", async function () {
                const tokens = [USDC_ADDRESS, cbETH_ADDRESS, WETH_ADDRESS];

                // Add tokens via batch
                await protocolRegistry.addToWhitelistBatch(tokens);

                // Verify all are whitelisted
                for (const token of tokens) {
                    expect(await protocolRegistry.isWhitelisted(token)).to.be.true;
                }

                // Remove one individually
                await protocolRegistry.removeFromWhitelist(cbETH_ADDRESS);

                // Check final status
                expect(await protocolRegistry.isWhitelisted(USDC_ADDRESS)).to.be.true;
                expect(await protocolRegistry.isWhitelisted(cbETH_ADDRESS)).to.be.false;
                expect(await protocolRegistry.isWhitelisted(WETH_ADDRESS)).to.be.true;
            });
        });
    });

    describe("Cross-function Integration", function () {
        it("Should allow setting both mContract and cContract for same token", async function () {
            await protocolRegistry.setTokenMContract(USDC_ADDRESS, mockMContract.address);
            await protocolRegistry.setTokenCContract(USDC_ADDRESS, mockCContract.address);

            expect(await protocolRegistry.getMContract(USDC_ADDRESS)).to.equal(mockMContract.address);
            expect(await protocolRegistry.getCContract(USDC_ADDRESS)).to.equal(mockCContract.address);
        });

        it("Should maintain independent mappings for M and C contracts", async function () {
            await protocolRegistry.setTokenMContract(USDC_ADDRESS, mockMContract.address);
            await protocolRegistry.setTokenCContract(USDC_ADDRESS, mockCContract.address);

            // Changing mContract should not affect cContract
            await protocolRegistry.setTokenMContract(USDC_ADDRESS, mockCContract.address);
            expect(await protocolRegistry.getMContract(USDC_ADDRESS)).to.equal(mockCContract.address);
            expect(await protocolRegistry.getCContract(USDC_ADDRESS)).to.equal(mockCContract.address);

            // Changing cContract should not affect mContract
            await protocolRegistry.setTokenCContract(USDC_ADDRESS, mockMContract.address);
            expect(await protocolRegistry.getMContract(USDC_ADDRESS)).to.equal(mockCContract.address);
            expect(await protocolRegistry.getCContract(USDC_ADDRESS)).to.equal(mockMContract.address);
        });

        it("Should handle multiple tokens with different contract mappings", async function () {
            // Set up multiple mappings
            await protocolRegistry.setTokenMContract(USDC_ADDRESS, mockMContract.address);
            await protocolRegistry.setTokenCContract(USDC_ADDRESS, mockCContract.address);
            await protocolRegistry.setTokenMContract(cbETH_ADDRESS, mockCContract.address);
            await protocolRegistry.setTokenCContract(cbETH_ADDRESS, mockMContract.address);

            // Verify all mappings are correct
            expect(await protocolRegistry.getMContract(USDC_ADDRESS)).to.equal(mockMContract.address);
            expect(await protocolRegistry.getCContract(USDC_ADDRESS)).to.equal(mockCContract.address);
            expect(await protocolRegistry.getMContract(cbETH_ADDRESS)).to.equal(mockCContract.address);
            expect(await protocolRegistry.getCContract(cbETH_ADDRESS)).to.equal(mockMContract.address);
        });
    });

    describe("Gas Usage and Performance", function () {
        it("Should handle setting many mappings efficiently", async function () {
            const tokens = [USDC_ADDRESS, cbETH_ADDRESS, WETH_ADDRESS, DAI_ADDRESS];
            const contracts = [mockMContract.address, mockCContract.address, owner.address, nonOwner.address];

            // Set mContract mappings
            for (let i = 0; i < tokens.length; i++) {
                await protocolRegistry.setTokenMContract(tokens[i], contracts[i]);
            }

            // Set cContract mappings
            for (let i = 0; i < tokens.length; i++) {
                await protocolRegistry.setTokenCContract(tokens[i], contracts[i]);
            }

            // Verify all mappings
            for (let i = 0; i < tokens.length; i++) {
                expect(await protocolRegistry.getMContract(tokens[i])).to.equal(contracts[i]);
                expect(await protocolRegistry.getCContract(tokens[i])).to.equal(contracts[i]);
            }
        });
    });
});
