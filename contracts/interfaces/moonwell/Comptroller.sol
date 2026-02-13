// SPDX-License-Identifier: MIT
pragma solidity =0.8.28;

interface IComptroller {
    function enterMarkets(address[] calldata mTokens) external returns (uint[] memory);
    function getAccountLiquidity(address account) external view returns (uint error, uint liquidity, uint shortfall);
    function oracle() external view returns (address);
    function markets(address mToken) external view returns (bool isListed, uint256 collateralFactorMantissa);
}

interface IMoonwellOracle {
    function getUnderlyingPrice(address mToken) external view returns (uint);
}
