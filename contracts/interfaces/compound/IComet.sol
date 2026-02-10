// SPDX-License-Identifier: MIT
pragma solidity =0.8.28;

interface IComet {
    function supply(address asset, uint amount) external;
    function supplyTo(address dst, address asset, uint amount) external;
    function supplyFrom(address from, address dst, address asset, uint amount) external;
    function withdrawFrom(address src, address to, address asset, uint amount) external;
    function withdraw(address asset, uint amount) external;

    function borrowBalanceOf(address account) external view returns (uint);
}
