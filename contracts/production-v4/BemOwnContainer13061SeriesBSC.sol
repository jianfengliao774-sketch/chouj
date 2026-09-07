// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./BemSelectableRaffle13061V4BSC.sol";

interface IOwnSeries13061ContainerOpener {
    function accountOf(address circuits, uint256 tokenId) external view returns (address);
    function isOpened(address circuits, uint256 tokenId) external view returns (bool);
}

interface IOwnSeries13061ContainerAccount {
    function token() external view returns (uint256 chainId, address tokenContract, uint256 tokenId);
}

/// @notice V4: TapeOut #13061's container authorizes this series and receives 1%.
/// BEHEMOTH #2075 is used only for the unchanged computation.
/// @dev This is a new deployment, not an upgrade or modification of the old game.
/// NFT custody stays outside this game. No post-activation holder permission is needed.
contract BemOwnContainer13061SeriesBSC is BemSelectableRaffle13061V4BSC {
    address public constant OPENER = 0x021745DE2f42A7839d96f2d3634d0294487D81F1;
    address public constant REVENUE_NFT = 0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C;
    uint256 public constant REVENUE_TOKEN_ID = 13061;
    address public constant REVENUE_CONTAINER = 0x001f110422F04a90bF7D6eC96714f75046BD7126;

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
    event RevenueBindingFixed(address indexed container, address indexed nft, uint256 tokenId);
    event ContainerSeriesAuthorized(address indexed container);
    event DrawWindowOpened(uint256 indexed roundId, uint64 lockedAt, uint64 targetDrawBy);
    event DrawScheduled(uint256 indexed roundId, uint64 scheduledDrawAt, uint64 targetDrawBy);
    event NextRoundScheduled(uint256 indexed resolvedRoundId, uint256 indexed nextRoundId, uint64 opensAt);

    constructor(
        uint256 vrfSubscriptionId,
        uint16 confirmations,
        uint32 vrfCallbackGasLimit,
        uint256 poolBaseUnits
    ) BemSelectableRaffle13061V4BSC(REVENUE_CONTAINER, vrfSubscriptionId, confirmations, vrfCallbackGasLimit, poolBaseUnits) {
        if (OPENER.code.length == 0 || REVENUE_CONTAINER.code.length == 0
            || IOwnSeries13061ContainerOpener(OPENER).accountOf(REVENUE_NFT, REVENUE_TOKEN_ID) != REVENUE_CONTAINER
            || !IOwnSeries13061ContainerOpener(OPENER).isOpened(REVENUE_NFT, REVENUE_TOKEN_ID)) {
            revert InvalidContainer();
        }
        (uint256 revenueChain, address revenueNft, uint256 revenueId) = IOwnSeries13061ContainerAccount(REVENUE_CONTAINER).token();
        if (revenueChain != BSC_CHAIN_ID || revenueNft != REVENUE_NFT || revenueId != REVENUE_TOKEN_ID) {
            revert InvalidContainer();
        }
        AUTHORIZATION_NFT = REVENUE_NFT;
        AUTHORIZATION_TOKEN_ID = REVENUE_TOKEN_ID;
        CONTAINER = REVENUE_CONTAINER;
        emit ContainerBindingFixed(REVENUE_CONTAINER, REVENUE_NFT, REVENUE_TOKEN_ID);
        emit RevenueBindingFixed(REVENUE_CONTAINER, REVENUE_NFT, REVENUE_TOKEN_ID);
    }

    /// @notice One-time activation via the fixed container's execute method.
    /// No NFT transfer/approval, revocation, or post-randomness holder veto exists.
    function authorizeSeries() external nonReentrant {
        if (msg.sender != CONTAINER) revert UnauthorizedContainer();
        if (seriesAuthorized) revert WrongState();
        if (CONTAINER.code.length == 0
            || !IOwnSeries13061ContainerOpener(OPENER).isOpened(AUTHORIZATION_NFT, AUTHORIZATION_TOKEN_ID)
            || IOwnSeries13061ContainerOpener(OPENER).accountOf(AUTHORIZATION_NFT, AUTHORIZATION_TOKEN_ID) != CONTAINER) {
            revert InvalidContainer();
        }
        (uint256 chainId, address nft, uint256 tokenId) = IOwnSeries13061ContainerAccount(CONTAINER).token();
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
