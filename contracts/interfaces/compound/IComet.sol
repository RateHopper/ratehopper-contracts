// SPDX-License-Identifier: MIT
pragma solidity =0.8.28;

struct AssetInfo {
    uint8 offset;
    address asset;
    address priceFeed;
    uint64 scale;
    uint64 borrowCollateralFactor;
    uint64 liquidateCollateralFactor;
    uint64 liquidationFactor;
    uint128 supplyCap;
}

interface IComet {
    function supply(address asset, uint amount) external;
    function supplyTo(address dst, address asset, uint amount) external;
    function supplyFrom(address from, address dst, address asset, uint amount) external;
    function withdrawFrom(address src, address to, address asset, uint amount) external;
    function withdraw(address asset, uint amount) external;

    function borrowBalanceOf(address account) external view returns (uint);
    function collateralBalanceOf(address account, address asset) external view returns (uint128);

    function getAssetInfoByAddress(address asset) external view returns (AssetInfo memory);
    function baseTokenPriceFeed() external view returns (address);
    function getPrice(address priceFeed) external view returns (uint256);
    function baseScale() external view returns (uint256);
}
