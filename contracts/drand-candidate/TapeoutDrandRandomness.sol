// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {DrandEvmnetVerifier} from "./DrandEvmnetVerifier.sol";

/// @notice Candidate randomness adapter, not an integrated/deployed raffle.
/// @dev The immutable consumer must atomically close sales before requesting.
/// It must bind its sold-ticket snapshot to entriesCommitment and never reopen it.
contract TapeoutDrandRandomness is DrandEvmnetVerifier {
    address public immutable consumer;
    // Candidate finality margin, subject to review before BNB mainnet deployment.
    uint64 public constant BEACON_DELAY = 60;
    uint64 public constant FULFILLMENT_WINDOW = 24 hours;
    bytes32 public constant SEED_DOMAIN = keccak256("Tapeout SparkDraw drand candidate v1");

    struct Draw {
        uint64 beaconRound;
        uint64 requestedAt;
        uint32 sold;
        bool fulfilled;
        bool expired;
        bytes32 entriesCommitment;
        bytes32 beaconRandomness;
        bytes32 drawSeed;
    }
    mapping(uint256 => Draw) public draws;
    // Two storage words per verified signature, with public retrieval below.
    mapping(uint256 => bytes32[2]) private signatures;

    error UnauthorizedConsumer();
    error InvalidRequest();
    error AlreadyRequested();
    error NotRequested();
    error AlreadyFulfilled();
    error BeaconNotDue();
    error RequestExpired();
    error DeadlineNotPassed();

    event RandomnessRequested(uint256 indexed drawId, uint64 indexed beaconRound,
        uint32 sold, bytes32 entriesCommitment, uint256 scheduledBeaconTime);
    event RandomnessVerified(uint256 indexed drawId, uint64 indexed beaconRound,
        bytes32 beaconRandomness, bytes32 drawSeed, bytes signature, address submitter);
    event RandomnessExpired(uint256 indexed drawId, uint64 indexed beaconRound);

    constructor(address fixedConsumer) {
        if (fixedConsumer == address(0)) revert InvalidRequest();
        consumer = fixedConsumer;
    }

    /// @notice Called exactly once by the raffle during its sealing transaction.
    function requestRandomness(uint256 drawId, uint32 sold, bytes32 entriesCommitment)
        external returns (uint64 beaconRound)
    {
        if (msg.sender != consumer) revert UnauthorizedConsumer();
        if (drawId == 0 || sold == 0 || sold > 10000 || entriesCommitment == bytes32(0)) revert InvalidRequest();
        if (draws[drawId].beaconRound != 0) revert AlreadyRequested();
        uint256 target = block.timestamp + BEACON_DELAY;
        if (target < GENESIS_TIME) revert InvalidRequest();
        // First beacon at or after target; the caller cannot supply a round.
        uint256 round = (target - GENESIS_TIME + PERIOD - 1) / PERIOD + 1;
        if (round > type(uint64).max || block.timestamp > type(uint64).max) revert InvalidRequest();
        beaconRound = uint64(round);
        draws[drawId] = Draw(beaconRound, uint64(block.timestamp), sold, false, false,
            entriesCommitment, bytes32(0), bytes32(0));
        emit RandomnessRequested(drawId, beaconRound, sold, entriesCommitment, beaconTime(beaconRound));
    }

    /// @notice Anyone may relay the fixed beacon; no operator key or paid API.
    function fulfillRandomness(uint256 drawId, bytes calldata signature) external {
        Draw storage draw = draws[drawId];
        if (draw.beaconRound == 0) revert NotRequested();
        if (draw.fulfilled) revert AlreadyFulfilled();
        if (draw.expired || block.timestamp > expiresAt(drawId)) revert RequestExpired();
        if (block.timestamp < beaconTime(draw.beaconRound)) revert BeaconNotDue();
        bytes32 value = verifyBeacon(draw.beaconRound, signature);
        bytes32 seed = keccak256(abi.encode(SEED_DOMAIN, block.chainid, address(this),
            consumer, drawId, draw.sold, draw.entriesCommitment, BEACON_CHAIN_HASH, draw.beaconRound, value));
        draw.fulfilled = true;
        draw.beaconRandomness = value;
        draw.drawSeed = seed;
        signatures[drawId] = [bytes32(signature[:32]), bytes32(signature[32:])];
        emit RandomnessVerified(drawId, draw.beaconRound, value, seed, signature, msg.sender);
    }

    function proof(uint256 drawId) external view returns (bytes memory) {
        if (!draws[drawId].fulfilled) return bytes("");
        return abi.encodePacked(signatures[drawId][0], signatures[drawId][1]);
    }

    function expiresAt(uint256 drawId) public view returns (uint256) {
        uint64 round = draws[drawId].beaconRound;
        if (round == 0) revert NotRequested();
        return uint256(draws[drawId].requestedAt) + FULFILLMENT_WINDOW;
    }

    /// @notice The raffle must use this condition to enable principal refunds.
    /// It must not depend on a server sending expireRandomness first.
    function isTimedOut(uint256 drawId) public view returns (bool) {
        Draw storage draw = draws[drawId];
        return draw.beaconRound != 0 && !draw.fulfilled && block.timestamp > expiresAt(drawId);
    }

    /// @notice Public audit event; this adapter holds no funds and cannot refund.
    function expireRandomness(uint256 drawId) external {
        Draw storage draw = draws[drawId];
        if (draw.beaconRound == 0) revert NotRequested();
        if (draw.fulfilled) revert AlreadyFulfilled();
        if (draw.expired) revert RequestExpired();
        if (!isTimedOut(drawId)) revert DeadlineNotPassed();
        draw.expired = true;
        emit RandomnessExpired(drawId, draw.beaconRound);
    }
}
