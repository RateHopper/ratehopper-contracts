/**
 * Hardhat 3 Test Setup
 * Provides shared network connection, ethers, and networkHelpers for tests
 */
import hre from "hardhat";
import type { HardhatEthers } from "@nomicfoundation/hardhat-ethers/types";
import type { NetworkHelpers, Time } from "@nomicfoundation/hardhat-network-helpers/types";

// Module-level variables to share across tests
let _ethers: HardhatEthers;
let _networkHelpers: NetworkHelpers;
let _isConnected = false;

/**
 * Initialize the network connection
 * Call this in a before() hook at the top of your test file
 */
export async function connectNetwork() {
    if (!_isConnected) {
        const connection = await hre.network.connect();
        _ethers = connection.ethers;
        _networkHelpers = connection.networkHelpers;
        _isConnected = true;
    }
    return { ethers: _ethers, networkHelpers: _networkHelpers };
}

/**
 * Get ethers instance (must call connectNetwork first)
 */
export function getEthers(): HardhatEthers {
    if (!_isConnected) {
        throw new Error("Network not connected. Call connectNetwork() in a before() hook first.");
    }
    return _ethers;
}

/**
 * Get networkHelpers instance (must call connectNetwork first)
 */
export function getNetworkHelpers(): NetworkHelpers {
    if (!_isConnected) {
        throw new Error("Network not connected. Call connectNetwork() in a before() hook first.");
    }
    return _networkHelpers;
}

/**
 * Provides loadFixture from networkHelpers
 */
export async function loadFixture<T>(fixture: () => Promise<T>): Promise<T> {
    const helpers = getNetworkHelpers();
    return helpers.loadFixture(fixture);
}

/**
 * Provides time helpers from networkHelpers
 */
export function getTime(): Time {
    const helpers = getNetworkHelpers();
    return helpers.time;
}

// Re-export hre for convenience
export { hre };
