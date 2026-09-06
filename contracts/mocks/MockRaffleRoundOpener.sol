// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./MockRaffleDependencies.sol";

/// @dev LOCAL TEST ONLY. An outer transaction has ample gas; the consumer receives
/// exactly the explicit budget. This models the callback cap, not VRF proof costs.
contract MockRaffleBudgetCoordinator is MockRaffleCoordinator {
    event CallbackBudgetUsed(uint256 gasBudget, uint256 gasUsed);

    function fulfillWithGas(address consumer, uint256 requestId, uint256[] calldata words, uint256 gasBudget)
        external
    {
        bytes memory payload = abi.encodeCall(BemCircuitRaffle.rawFulfillRandomWords, (requestId, words));
        uint256 beforeCall = gasleft();
        (bool ok, bytes memory returned) = consumer.call{gas: gasBudget}(payload);
        uint256 used = beforeCall - gasleft();
        if (!ok) assembly { revert(add(returned, 32), mload(returned)) }
        emit CallbackBudgetUsed(gasBudget, used);
    }
}

/// @dev LOCAL TEST ONLY. Setters model NFT sale, marketplace freeze and upstream outages.
/// This is not the official ERC-6551 implementation and does not prove its permissions.
contract MockRaffleRoundOpener {
    address public mockOwner;
    uint256 public boundChainId;
    address public boundTokenContract;
    uint256 public boundTokenId;
    bool public frozen;
    bool public rejectReads;
    uint256 public constant EXECUTION_FEE = 0.0002 ether;

    function configure(address holder, uint256 chainId, address tokenContract, uint256 tokenId) external {
        mockOwner = holder;
        boundChainId = chainId;
        boundTokenContract = tokenContract;
        boundTokenId = tokenId;
    }
    function setOwnerForTest(address holder) external { mockOwner = holder; }
    function setFrozen(bool value) external { frozen = value; }
    function setRejectReads(bool value) external { rejectReads = value; }
    function owner() external view returns (address) {
        require(!rejectReads, "mock owner read unavailable");
        return mockOwner;
    }
    function token() external view returns (uint256, address, uint256) {
        require(!rejectReads, "mock binding read unavailable");
        return (boundChainId, boundTokenContract, boundTokenId);
    }
    function execute(address to, uint256 value, bytes calldata data, uint8 operation)
        external payable returns (bytes memory result)
    {
        require(msg.sender == mockOwner, "mock owner authorization");
        require(!frozen, "mock marketplace freeze");
        require(operation == 0, "only call");
        require(msg.value >= EXECUTION_FEE, "mock execution fee");
        (bool ok, bytes memory returned) = to.call{value: value}(data);
        if (!ok) assembly { revert(add(returned, 32), mload(returned)) }
        return returned;
    }
}

contract MockRaffleOpeningGateway {
    address public account;
    bool public opened;
    bool public rejectReads;
    function setAccount(address value) external { account = value; }
    function setOpened(bool value) external { opened = value; }
    function setRejectReads(bool value) external { rejectReads = value; }
    function accountOf(address circuits, uint256 tokenId) external view returns (address) {
        require(!rejectReads, "mock gateway unavailable");
        require(circuits == 0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C && tokenId == 2075, "wrong registry lookup");
        return account;
    }
    function isOpened(address circuits, uint256 tokenId) external view returns (bool) {
        require(!rejectReads, "mock gateway unavailable");
        require(circuits == 0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C && tokenId == 2075, "wrong opened lookup");
        return opened;
    }
}
