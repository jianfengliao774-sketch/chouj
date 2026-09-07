// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./BemOwnContainer13061SeriesBSC.sol";

/// @notice Fixed 10 BEM / 10000 tickets. V4 production denomination; 5000 tickets per purchase.
/// TapeOut13061 authorizes and receives 1%; BEHEMOTH2075 computes only.
/// Funding24h; refunds24h; unclaimed principal then goes to dead.
contract BemOwnContainer13061Pool10BSC is BemOwnContainer13061SeriesBSC {
    bool public constant TEST_ONLY = false;
    constructor(uint256 vrfSubscriptionId,uint16 confirmations,uint32 vrfCallbackGasLimit)
        BemOwnContainer13061SeriesBSC(vrfSubscriptionId,confirmations,vrfCallbackGasLimit,1000000000) {}
}
