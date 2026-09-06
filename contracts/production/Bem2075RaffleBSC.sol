// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./BemContainerSeriesBSC.sol";

/// @notice Production release target selected by the user: BEHEMOTH #2075's
/// own container authorizes the series and receives 1 BEM per settled round.
/// @dev No organizer, container, processor or funding-window deployment override.
contract Bem2075RaffleBSC is BemContainerSeriesBSC {
    constructor(uint256 vrfSubscriptionId, uint16 confirmations, uint32 vrfCallbackGasLimit)
        BemContainerSeriesBSC(
            CIRCUITS,
            CIRCUIT_ID,
            BEHEMOTH_2075_CONTAINER,
            vrfSubscriptionId,
            confirmations,
            vrfCallbackGasLimit
        )
    {}
}
