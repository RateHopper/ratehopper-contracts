// SPDX-License-Identifier: MIT
pragma solidity =0.8.28;

interface IComptroller {
    function enterMarkets(address[] calldata mTokens) external returns (uint[] memory);
}
