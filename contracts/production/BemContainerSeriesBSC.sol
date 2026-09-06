// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./BemSelectableRaffleBSC.sol";

interface ISeriesContainerOpener {
    function accountOf(address circuits, uint256 tokenId) external view returns (address);
    function isOpened(address circuits, uint256 tokenId) external view returns (bool);
}

interface ISeriesContainerAccount {
    function token() external view returns (uint256 chainId, address tokenContract, uint256 tokenId);
}

/// @notice Fixed-rule selectable series; the selected official container both
/// authorizes activation and receives the organizer's 1 BEM. Selection is immutable.
/// @dev The deployment candidate supports the two discussed container bindings.
/// The release manifest must select ONE before deployment. Settlement always calls
/// BEHEMOTH #2075 directly and never requires recurring NFT-holder permission.
contract BemContainerSeriesBSC is BemSelectableRaffleBSC {
    address public constant OPENER = 0x021745DE2f42A7839d96f2d3634d0294487D81F1;
    address public constant BEHEMOTH_2075_CONTAINER = 0x358BE84b95224d228f3A61964Fa3c9fB61D7B646;
    address public constant TAPEOUT_NFT = 0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C;
    address public constant TAPEOUT_13043_CONTAINER = 0x167897fe1d2fE713E1D6C3661D1B08d5353B9D34;

    address public immutable AUTHORIZATION_NFT;
    uint256 public immutable AUTHORIZATION_TOKEN_ID;
    address public immutable CONTAINER;

    uint64 public constant DRAW_TARGET_SECONDS = 60;
    uint64 public constant MIN_DRAW_DELAY = 8;
    uint64 public constant MAX_DRAW_DELAY = 30;
    uint64 public constant NEXT_ROUND_DELAY = 60;

    struct DrawTiming {
        uint64 lockedAt;
        uint64 targetDrawBy;
        uint64 scheduledDrawAt;
        uint64 settledAt;
    }

    bool public seriesAuthorized;
    uint64 public nextRoundOpensAt;
    mapping(uint256 => DrawTiming) public drawTiming;

    error UnauthorizedContainer();
    error InvalidContainer();
    error SeriesNotAuthorized();
    error PreviousRoundUnresolved(uint256 roundId);
    error RoundCoolingDown(uint64 opensAt);
    error DrawNotDue(uint64 scheduledDrawAt);

    event ContainerBindingFixed(address indexed container, address indexed nft, uint256 tokenId);
    event ContainerSeriesAuthorized(address indexed container);
    event DrawWindowOpened(uint256 indexed roundId, uint64 lockedAt, uint64 targetDrawBy);
    event DrawScheduled(uint256 indexed roundId, uint64 scheduledDrawAt, uint64 targetDrawBy);
    event NextRoundScheduled(uint256 indexed resolvedRoundId, uint256 indexed nextRoundId, uint64 opensAt);

    constructor(
        address authorizationNft,
        uint256 authorizationTokenId,
        address containerAddress,
        uint256 vrfSubscriptionId,
        uint16 confirmations,
        uint32 vrfCallbackGasLimit
    ) BemSelectableRaffleBSC(containerAddress, vrfSubscriptionId, confirmations, vrfCallbackGasLimit) {
        bool behemoth = authorizationNft == CIRCUITS && authorizationTokenId == CIRCUIT_ID
            && containerAddress == BEHEMOTH_2075_CONTAINER;
        bool tapeout = authorizationNft == TAPEOUT_NFT && authorizationTokenId == 13043
            && containerAddress == TAPEOUT_13043_CONTAINER;
        if ((!behemoth && !tapeout) || OPENER.code.length == 0
            || ISeriesContainerOpener(OPENER).accountOf(authorizationNft, authorizationTokenId) != containerAddress) {
            revert InvalidContainer();
        }
        AUTHORIZATION_NFT = authorizationNft;
        AUTHORIZATION_TOKEN_ID = authorizationTokenId;
        CONTAINER = containerAddress;
        emit ContainerBindingFixed(containerAddress, authorizationNft, authorizationTokenId);
    }

    /// @notice One-time activation via the chosen container's execute method.
    /// No NFT transfer/approval, revocation, or post-randomness holder veto exists.
    function authorizeSeries() external nonReentrant {
        if (msg.sender != CONTAINER) revert UnauthorizedContainer();
        if (seriesAuthorized) revert WrongState();
        if (CONTAINER.code.length == 0
            || !ISeriesContainerOpener(OPENER).isOpened(AUTHORIZATION_NFT, AUTHORIZATION_TOKEN_ID)
            || ISeriesContainerOpener(OPENER).accountOf(AUTHORIZATION_NFT, AUTHORIZATION_TOKEN_ID) != CONTAINER) {
            revert InvalidContainer();
        }
        (uint256 chainId, address nft, uint256 tokenId) = ISeriesContainerAccount(CONTAINER).token();
        if (chainId != BSC_CHAIN_ID || nft != AUTHORIZATION_NFT || tokenId != AUTHORIZATION_TOKEN_ID) {
            revert InvalidContainer();
        }
        seriesAuthorized = true;
        emit ContainerSeriesAuthorized(CONTAINER);
        _openNextRound();
    }

    function openNextRound() external nonReentrant { _openNextRound(); }

    function _openNextRound() private {
        uint256 roundId = currentRoundId;
        _requireRoundAuthorization(roundId);
        Round storage r = rounds[roundId];
        if (r.status != Status.Unstarted) revert WrongState();
        r.status = Status.Funding;
        r.fundingDeadline = uint64(block.timestamp + fundingWindow);
        emit RoundStarted(roundId, r.fundingDeadline);
    }

    function _requireRoundAuthorization(uint256 roundId) internal view override {
        if (!seriesAuthorized) revert SeriesNotAuthorized();
        if (roundId > 1) {
            Status previous = rounds[roundId - 1].status;
            if (previous != Status.Settled && previous != Status.Refunding) {
                revert PreviousRoundUnresolved(roundId - 1);
            }
        }
        if (block.timestamp < nextRoundOpensAt) revert RoundCoolingDown(nextRoundOpensAt);
    }

    /// @dev Final purchase seals all ticket ownership and requests VRF atomically.
    /// A request failure reverts that entire purchase, including its BEM payment.
    function _afterRoundLocked(uint256 roundId) internal override {
        DrawTiming storage timing = drawTiming[roundId];
        timing.lockedAt = uint64(block.timestamp);
        timing.targetDrawBy = uint64(block.timestamp + DRAW_TARGET_SECONDS);
        emit DrawWindowOpened(roundId, timing.lockedAt, timing.targetDrawBy);
        _requestDraw(roundId);
    }

    /// @dev Timing derives from the original VRF words. Timestamp is never entropy.
    /// The callback stores data only; actual circuit calls and transfers occur later.
    function _afterRandomnessReceived(uint256 roundId) internal override {
        Round storage r = rounds[roundId];
        DrawTiming storage timing = drawTiming[roundId];
        uint64 delaySeconds = MIN_DRAW_DELAY + uint64(uint256(keccak256(abi.encode(
            "BEM2075_DRAW_TIME_V1", roundId, r.requestId, r.ticketWord, r.circuitWord
        ))) % (MAX_DRAW_DELAY - MIN_DRAW_DELAY + 1));
        timing.scheduledDrawAt = timing.lockedAt + delaySeconds;
        emit DrawScheduled(roundId, timing.scheduledDrawAt, timing.targetDrawBy);
    }

    function _beforeSettlement(uint256 roundId) internal view override {
        uint64 due = drawTiming[roundId].scheduledDrawAt;
        if (block.timestamp < due) revert DrawNotDue(due);
        // Sixty seconds is an operating target, never a cancellation/reroll cutoff.
    }

    function _afterSettlement(uint256 roundId) internal override {
        drawTiming[roundId].settledAt = uint64(block.timestamp);
        _scheduleNextRound(roundId);
    }

    function _afterRefundsOpened(uint256 roundId) internal override {
        // Refund liabilities stay reserved as the following round becomes available.
        _scheduleNextRound(roundId);
    }

    function _scheduleNextRound(uint256 roundId) private {
        nextRoundOpensAt = uint64(block.timestamp + NEXT_ROUND_DELAY);
        emit NextRoundScheduled(roundId, currentRoundId, nextRoundOpensAt);
    }
}
