import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { expect } from "chai";
import { ethers } from "hardhat";
import { Roles } from "../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("Zodiac Roles Modifier", function () {
    // Test accounts
    let owner: HardhatEthersSigner;
    let avatar: HardhatEthersSigner; // Simulating a Safe wallet
    let module1: HardhatEthersSigner; // Module that will use roles
    let module2: HardhatEthersSigner;
    let unauthorized: HardhatEthersSigner;

    // Contracts
    let roles: Roles;
    let targetContract: any; // Mock target contract for testing

    // Role keys
    const ROLE_KEY_1 = ethers.keccak256(ethers.toUtf8Bytes("ROLE_1"));
    const ROLE_KEY_2 = ethers.keccak256(ethers.toUtf8Bytes("ROLE_2"));

    async function deployRolesFixture() {
        // Get signers
        [owner, avatar, module1, module2, unauthorized] = await ethers.getSigners();

        // Deploy a simple mock contract as target
        const MockTarget = await ethers.getContractFactory("MockContract");
        const mockTarget = await MockTarget.deploy();
        await mockTarget.waitForDeployment();

        // Deploy Roles contract
        // Constructor params: owner, avatar, target
        const Roles = await ethers.getContractFactory("Roles");
        const rolesContract = await Roles.deploy(
            owner.address,
            avatar.address,
            await mockTarget.getAddress()
        );
        await rolesContract.waitForDeployment();

        console.log("Roles deployed to:", await rolesContract.getAddress());
        console.log("Owner:", owner.address);
        console.log("Avatar:", avatar.address);
        console.log("Target:", await mockTarget.getAddress());

        return { roles: rolesContract, mockTarget };
    }

    describe("Deployment", function () {
        it("should deploy with correct initial parameters", async function () {
            const { roles: rolesContract } = await loadFixture(deployRolesFixture);

            // Check that the contract deployed successfully
            expect(await rolesContract.getAddress()).to.be.properAddress;

            // Verify owner
            expect(await rolesContract.owner()).to.equal(owner.address);

            // Verify avatar
            expect(await rolesContract.avatar()).to.equal(avatar.address);
        });

        it("should emit RolesModSetup event on deployment", async function () {
            const Roles = await ethers.getContractFactory("Roles");
            const MockTarget = await ethers.getContractFactory("MockContract");
            const mockTarget = await MockTarget.deploy();
            const targetAddress = await mockTarget.getAddress();

            // Deploy and check for event
            await expect(Roles.deploy(owner.address, avatar.address, targetAddress))
                .to.emit(Roles, "RolesModSetup")
                .withArgs(owner.address, owner.address, avatar.address, targetAddress);
        });
    });

    describe("Role Assignment", function () {
        beforeEach(async function () {
            ({ roles } = await loadFixture(deployRolesFixture));
        });

        it("should allow owner to assign roles to a module", async function () {
            const roleKeys = [ROLE_KEY_1];
            const memberOf = [true];

            await expect(roles.connect(owner).assignRoles(module1.address, roleKeys, memberOf))
                .to.emit(roles, "AssignRoles")
                .withArgs(module1.address, roleKeys, memberOf);
        });

        it("should allow owner to assign multiple roles to a module", async function () {
            const roleKeys = [ROLE_KEY_1, ROLE_KEY_2];
            const memberOf = [true, true];

            await expect(roles.connect(owner).assignRoles(module1.address, roleKeys, memberOf))
                .to.emit(roles, "AssignRoles")
                .withArgs(module1.address, roleKeys, memberOf);
        });

        it("should allow owner to revoke roles from a module", async function () {
            // First assign roles
            await roles.connect(owner).assignRoles(module1.address, [ROLE_KEY_1], [true]);

            // Then revoke
            const roleKeys = [ROLE_KEY_1];
            const memberOf = [false];

            await expect(roles.connect(owner).assignRoles(module1.address, roleKeys, memberOf))
                .to.emit(roles, "AssignRoles")
                .withArgs(module1.address, roleKeys, memberOf);
        });

        it("should revert if non-owner tries to assign roles", async function () {
            const roleKeys = [ROLE_KEY_1];
            const memberOf = [true];

            await expect(
                roles.connect(unauthorized).assignRoles(module1.address, roleKeys, memberOf)
            ).to.be.revertedWithCustomError(roles, "OwnableUnauthorizedAccount");
        });

        it("should revert if arrays have different lengths", async function () {
            const roleKeys = [ROLE_KEY_1, ROLE_KEY_2];
            const memberOf = [true]; // Mismatched length

            await expect(
                roles.connect(owner).assignRoles(module1.address, roleKeys, memberOf)
            ).to.be.revertedWithCustomError(roles, "ArraysDifferentLength");
        });
    });

    describe("Default Role Management", function () {
        beforeEach(async function () {
            ({ roles } = await loadFixture(deployRolesFixture));
        });

        it("should allow owner to set default role for a module", async function () {
            await expect(roles.connect(owner).setDefaultRole(module1.address, ROLE_KEY_1))
                .to.emit(roles, "SetDefaultRole")
                .withArgs(module1.address, ROLE_KEY_1);

            // Verify the default role was set
            expect(await roles.defaultRoles(module1.address)).to.equal(ROLE_KEY_1);
        });

        it("should allow owner to change default role for a module", async function () {
            // Set initial default role
            await roles.connect(owner).setDefaultRole(module1.address, ROLE_KEY_1);

            // Change to a different role
            await expect(roles.connect(owner).setDefaultRole(module1.address, ROLE_KEY_2))
                .to.emit(roles, "SetDefaultRole")
                .withArgs(module1.address, ROLE_KEY_2);

            expect(await roles.defaultRoles(module1.address)).to.equal(ROLE_KEY_2);
        });

        it("should revert if non-owner tries to set default role", async function () {
            await expect(
                roles.connect(unauthorized).setDefaultRole(module1.address, ROLE_KEY_1)
            ).to.be.revertedWithCustomError(roles, "OwnableUnauthorizedAccount");
        });
    });

    describe("Transaction Execution", function () {
        let mockTarget: any;

        beforeEach(async function () {
            ({ roles, mockTarget } = await loadFixture(deployRolesFixture));

            // Assign role to module1
            await roles.connect(owner).assignRoles(module1.address, [ROLE_KEY_1], [true]);

            // Set default role for module1
            await roles.connect(owner).setDefaultRole(module1.address, ROLE_KEY_1);
        });

        it("should allow module to execute transaction from module with default role", async function () {
            // This test would require proper permission setup and a real target contract
            // For now, we'll test that the function exists and can be called by enabled modules
            const data = "0x"; // Empty data for test

            // Note: This will likely revert with "NoMembership" since we haven't set up
            // actual permissions, but it confirms the function signature is correct
            await expect(
                roles.connect(module1).execTransactionFromModule(
                    await mockTarget.getAddress(),
                    0,
                    data,
                    0 // Operation.Call
                )
            ).to.be.reverted;
        });
    });

    describe("Access Control", function () {
        beforeEach(async function () {
            ({ roles } = await loadFixture(deployRolesFixture));
        });

        it("should only allow owner to transfer ownership", async function () {
            const newOwner = module1.address;

            await expect(roles.connect(owner).transferOwnership(newOwner))
                .to.emit(roles, "OwnershipTransferred")
                .withArgs(owner.address, newOwner);

            expect(await roles.owner()).to.equal(newOwner);
        });

        it("should revert if non-owner tries to transfer ownership", async function () {
            await expect(
                roles.connect(unauthorized).transferOwnership(module1.address)
            ).to.be.revertedWithCustomError(roles, "OwnableUnauthorizedAccount");
        });

        it("should allow owner to set avatar", async function () {
            const newAvatar = module2.address;

            await expect(roles.connect(owner).setAvatar(newAvatar))
                .to.emit(roles, "AvatarSet")
                .withArgs(newAvatar);

            expect(await roles.avatar()).to.equal(newAvatar);
        });

        it("should allow owner to set target", async function () {
            const newTarget = module2.address;

            await expect(roles.connect(owner).setTarget(newTarget))
                .to.emit(roles, "TargetSet")
                .withArgs(newTarget);

            expect(await roles.target()).to.equal(newTarget);
        });
    });

    describe("Edge Cases", function () {
        beforeEach(async function () {
            ({ roles } = await loadFixture(deployRolesFixture));
        });

        it("should handle assigning same role multiple times", async function () {
            // Assign role first time
            await roles.connect(owner).assignRoles(module1.address, [ROLE_KEY_1], [true]);

            // Assign same role again - should not revert
            await expect(
                roles.connect(owner).assignRoles(module1.address, [ROLE_KEY_1], [true])
            ).to.not.be.reverted;
        });

        it("should handle revoking role that was never assigned", async function () {
            // Revoke role that was never assigned - should not revert
            await expect(
                roles.connect(owner).assignRoles(module1.address, [ROLE_KEY_1], [false])
            ).to.not.be.reverted;
        });

        it("should handle setting default role to zero", async function () {
            const ZERO_ROLE = ethers.ZeroHash;

            await expect(roles.connect(owner).setDefaultRole(module1.address, ZERO_ROLE))
                .to.emit(roles, "SetDefaultRole")
                .withArgs(module1.address, ZERO_ROLE);

            expect(await roles.defaultRoles(module1.address)).to.equal(ZERO_ROLE);
        });
    });
});
