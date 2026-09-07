// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./BemSelectableRaffleV3.sol";

/// @notice Static BSC candidate with the official dependencies and a 24-hour funding window.
/// @dev This is the network layer, not the final container-authorized series.
/// The final series wrapper fixes the recipient independently of activation.
/// Native BNB pays VRF costs separately from the selected fixed BEM pool.
contract BemSelectableRaffle13061V3BSC is BemSelectableRaffleV3 {
    uint256 public constant BSC_CHAIN_ID = 56;
    address public constant BSC_VRF_COORDINATOR = 0xd691f04bc0C9a24Edb78af9E005Cf85768F694C9;
    bytes32 public constant BSC_VRF_KEY_HASH = 0x130dba50ad435d4ecc214aad0d5820474137bd68e7e77724144f27c3c377d3d4;
    uint32 public constant FUNDING_WINDOW_SECONDS = 24 hours;
    // Request guard only: the final purchase requests VRF atomically.
    // Requested rounds never enter refunds or unclaimed-principal burning.
    uint32 public constant REQUEST_WINDOW_SECONDS = 1 hours;

    error UnsupportedChain(uint256 chainId);

    constructor(
        address organizerAddress,
        uint256 vrfSubscriptionId,
        uint16 confirmations,
        uint32 vrfCallbackGasLimit,
        uint256 poolBaseUnits
    ) BemSelectableRaffleV3(
        poolBaseUnits,
        _officialBemOnBsc(),
        BSC_VRF_COORDINATOR,
        organizerAddress,
        vrfSubscriptionId,
        BSC_VRF_KEY_HASH,
        confirmations,
        vrfCallbackGasLimit,
        FUNDING_WINDOW_SECONDS,
        REQUEST_WINDOW_SECONDS
    ) {}

    function _officialBemOnBsc() private view returns (address) {
        if (block.chainid != BSC_CHAIN_ID) revert UnsupportedChain(block.chainid);
        return OFFICIAL_BEM;
    }
}
