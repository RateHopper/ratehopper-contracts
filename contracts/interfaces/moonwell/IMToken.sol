// SPDX-License-Identifier: MIT
pragma solidity =0.8.28;

interface IMToken {
    function borrow(uint256 borrowAmount) external returns (uint256);

    function repayBorrowBehalf(address borrower, uint repayAmount) external returns (uint);

    function mint(uint256 mintAmount) external returns (uint256);

    function repayBorrow(uint256 repayAmount) external returns (uint256);

    function redeem(uint256 redeemTokens) external returns (uint256);

    function redeemUnderlying(uint256 amount) external returns (uint256);

    function borrowBalanceStored(address account) external view returns (uint256);

    function borrowBalanceCurrent(address account) external returns (uint256);

    function exchangeRateStored() external view returns (uint256);
}
