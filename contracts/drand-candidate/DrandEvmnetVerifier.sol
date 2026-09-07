// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {BLS} from "./vendor/BLS.sol";

/// @notice Candidate only: pinned evmnet key and signature verification, no funds.
contract DrandEvmnetVerifier {
    bytes32 public constant BEACON_CHAIN_HASH =
        0x04f1e9062b8a81f848fded9c12306733282b2727ecced50032187751166ec8c3;
    string public constant DST = "BLS_SIG_BN254G1_XMD:KECCAK-256_SVDW_RO_NUL_";
    uint64 public constant GENESIS_TIME = 1727521075;
    uint64 public constant PERIOD = 3;

    error InvalidSignature();
    error InvalidBeaconRound();

    function publicKey() public pure returns (BLS.PointG2 memory) {
        return BLS.PointG2(
            [uint256(0x557ec32c2ad488e4d4f6008f89a346f18492092ccc0d594610de2732c8b808f),
             uint256(0x7e1d1d335df83fa98462005690372c643340060d205306a9aa8106b6bd0b382)],
            [uint256(0x297d3a4f9749b33eb2d904c9d9ebf17224150ddd7abd7567a9bec6c74480ee0b),
             uint256(0x95685ae3a85ba243747b1b2f426049010f6b73a0cf1d389351d5aaaa1047f6)]
        );
    }

    /// @dev Uses the exact evmnet message encoding; never trusts API randomness.
    function verifyBeacon(uint64 beaconRound, bytes calldata signature) public view returns (bytes32) {
        if (beaconRound == 0) revert InvalidBeaconRound();
        if (signature.length != 64) revert InvalidSignature();
        BLS.PointG1 memory point = BLS.g1Unmarshal(signature);
        if (point.x == 0 && point.y == 0) revert InvalidSignature();
        (bool pairingSuccess, bool callSuccess) = BLS.verifySingle(
            point, publicKey(),
            BLS.hashToPoint(bytes(DST), abi.encodePacked(keccak256(abi.encodePacked(beaconRound))))
        );
        if (!pairingSuccess || !callSuccess) revert InvalidSignature();
        return sha256(signature);
    }

    function beaconTime(uint64 beaconRound) public pure returns (uint256) {
        if (beaconRound == 0) revert InvalidBeaconRound();
        return uint256(GENESIS_TIME) + (uint256(beaconRound) - 1) * PERIOD;
    }
}
