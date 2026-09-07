// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../BemContainer13061SeriesBSC.sol";

/// @notice Fixed 1 BEM / 10000 tickets. Integration-test deployment.
/// BEHEMOTH2075 computes and authorizes; TapeOut13061 receives the organizer1%.
/// Funding24h; self-service refunds for24h; unclaimed principal then goes to dead.
contract Bem2075Raffle13061Test1BSC is BemContainer13061SeriesBSC {
    bool public constant TEST_ONLY = true;
    constructor(uint256 vrfSubscriptionId,uint16 confirmations,uint32 vrfCallbackGasLimit)
        BemContainer13061SeriesBSC(CIRCUITS,CIRCUIT_ID,BEHEMOTH_2075_CONTAINER,
            vrfSubscriptionId,confirmations,vrfCallbackGasLimit,100000000) {}
}
