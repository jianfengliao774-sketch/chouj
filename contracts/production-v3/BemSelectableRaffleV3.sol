// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// V3 partial-fill candidate. Release leaves pin a formal denomination.
// Container authorization and operating cadence belong to the series wrapper.

interface IV3SelectableRaffleToken {
    function decimals() external view returns (uint8);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IV3SelectableRaffleCircuitSource {
    function netlist(uint256 id) external view returns (bytes memory);
    function circuitInfo(uint256 id) external view returns (uint32, uint32, uint32, uint32);
    function eval(uint256 id, bytes calldata inputs) external view returns (bytes memory);
}

library V3SelectableRaffleVRFClient {
    struct RandomWordsRequest {
        bytes32 keyHash;
        uint256 subId;
        uint16 requestConfirmations;
        uint32 callbackGasLimit;
        uint32 numWords;
        bytes extraArgs;
    }
}

interface IV3SelectableRaffleVRFCoordinator {
    function requestRandomWords(V3SelectableRaffleVRFClient.RandomWordsRequest calldata request)
        external returns (uint256 requestId);
}

/// @notice Fixed denomination, 10,000-ticket raffle with explicit or automatic ticket selection. No administrator or upgrade entry point.
/// @dev Winning bytes MUST be obtained from live Behemoth #2075 eval calls. The
/// verified arithmetic is used only to reject incorrect upstream outputs; never
/// as a fallback. Upstream failure can block settlement. Randomness comes from VRF,
/// NOT from the deterministic circuit. A requested draw cannot be cancelled or rerolled.
/// Funding lasts 24 hours. Unfilled rounds have a fixed further 24-hour claim
/// period; unclaimed principal can then be sent to the dead address, per round.
/// The token constructor argument permits testing; mainnet deployment MUST use official BEM.
contract BemSelectableRaffleV3 {
    bool public constant PARTIAL_FILL = true;
    uint256 public immutable TICKET_PRICE; // Fixed by the release leaf, 8 BEM decimals
    uint32 public constant TICKETS_PER_ROUND = 10_000;
    // Each transaction remains subject to the network gas limit; wallets estimate
    // the chosen tickets before sending. Multiple buys share the address limit.
    uint32 public constant MAX_TICKETS_PER_PURCHASE = 1000;
    uint32 public constant MAX_TICKETS_PER_ADDRESS = 5000;
    uint64 public constant REFUND_CLAIM_WINDOW = 24 hours;
    mapping(uint256 => uint256) public refundedPrincipal;
    mapping(uint256 => bool) public unclaimedPrincipalBurned;
    uint256 public immutable ROUND_POOL;
    uint256 public immutable ORGANIZER_AMOUNT;
    uint256 public immutable BLACKHOLE_AMOUNT;
    uint256 public immutable WINNER_AMOUNT;
    address public constant BLACKHOLE = 0x000000000000000000000000000000000000dEaD;
    address public constant OFFICIAL_BEM = 0x5ce033B2bFCa3Af30b3e8C8457DeaF776A8b695a;
    address public constant CIRCUITS = 0x1F5Cb4aeaE1807Bf60c3b9C0D8aDBCC14e91f12C;
    uint256 public constant CIRCUIT_ID = 2075;
    bytes32 public constant CIRCUIT_HASH = 0xa375924f2a31f5169606ea20e357efa2aeeb2355aff859f28f40a15519714eef;
    bytes internal constant CIRCUIT_RAW = hex"0000000200000a0000000a00000e0000000200000e0000000b00000b00000003000003000000110000120000000300000b0000000e0000140000001300001500000013000016000000130000140000000e000017000000180000190000000400000c0000000c00000c000000040000040000001c00001d0000001b00001e0000001600001f000000160000200000001f0000200000000500000d0000000d00000d00000005000005000000240000250000001e000026000000230000270000001b000023000000260000290000001600002a0000002800002b0000000600002c0000002600002c000000230000260000001e00002f0000003000003000000021000031000000060000070000000600002b000000060000330000002c000033000000280000350000003400003600000007000034000000360000370000000800002c00000008000033000000330000330000000800003d0000003d00003e0000003c00003f0000002d0000400000000900002c0000000900003e000000090000090000003e00003e00000044000045000000430000460000002d00004700000009000045000000490000490000002d00004a0000000f0000100000001700001a000000210000220000002e0000320000002d0000380000003900003a0000003b000041000000420000480000004b00004b";

    enum Status { Unstarted, Funding, Locked, Requested, Ready, Settled, Refunding }
    struct Round {
        Status status;
        uint32 sold;
        uint64 fundingDeadline;
        uint64 drawDeadline;
        uint256 requestId;
        uint256 ticketWord;
        uint256 circuitWord;
        uint32 drawCursor;
        uint32 winningTicket;
        address winner;
    }
    struct Attempt {
        uint16 input0;
        uint16 input1;
        uint16 output0;
        uint16 output1;
        uint16 candidate;
        bool accepted;
        uint32 ticket;
    }
    struct SelectionCache {
        uint256[625] words;
        bool[625] loaded;
        bool[625] dirty;
    }
    struct SelectionRange {
        uint32 first;
        uint32 previous;
        bool active;
    }

    IV3SelectableRaffleToken public immutable bem;
    IV3SelectableRaffleVRFCoordinator public immutable coordinator;
    address public immutable organizer;
    uint256 public immutable subscriptionId;
    bytes32 public immutable keyHash;
    uint16 public immutable requestConfirmations;
    uint32 public immutable callbackGasLimit;
    uint32 public immutable fundingWindow;
    uint32 public immutable drawWindow;
    uint256 public immutable sourceVerifiedAtBlock;
    uint256 public currentRoundId = 1;
    uint256 public totalLiability;
    uint256 private guard = 1;
    mapping(uint256 => Round) public rounds;
    // Each storage word packs 16 uint16 buyer IDs.
    // ID 0 means unsold. At most 10,000 distinct buyers can exist in one round.
    mapping(uint256 => mapping(uint256 => uint256)) private packedTicketOwners;
    mapping(uint256 => mapping(address => uint16)) public ticketBuyerId;
    mapping(uint256 => mapping(uint16 => address)) public ticketBuyer;
    mapping(uint256 => uint16) private nextTicketBuyerId;
    mapping(uint256 => uint32) private automaticTicketCursor;
    error TicketAlreadySold(uint32 ticket);
    error TicketsNotStrictlyAscending();
    mapping(uint256 => mapping(address => uint32)) public ticketsOf;
    mapping(uint256 => uint256) public requestRound;

    error BadConfiguration();
    error WrongCircuit();
    error WrongState();
    error DeadlinePassed();
    error TooEarly();
    error InvalidTicketCount();
    error PurchaseLimitExceeded(uint256 requested, uint256 maximum);
    error TokenTransferFailed();
    error UnexpectedTokenAmount();
    error UnauthorizedCoordinator();
    error ReentrantCall();
    error NothingToRefund();
    error AddressTicketLimitExceeded(uint256 requestedTotal, uint256 maximum);
    error RefundClaimPeriodEnded(uint64 deadline);
    error NothingToBurn();
    event UnclaimedPrincipalBurned(uint256 indexed roundId, uint256 amount);
    error InvalidRandomness();
    error Insolvent();
    error WrongRound(uint256 expectedRoundId, uint256 actualRoundId);

    event RoundStarted(uint256 indexed roundId, uint64 fundingDeadline);
    event PurchaseResult(uint256 indexed roundId, address indexed buyer, uint32 requested, uint32 filled, uint256 paid, uint256 unspent);
    event TicketsPurchased(uint256 indexed roundId, address indexed buyer, uint32 firstTicket, uint32 endExclusive, uint256 paid);
    event RoundLocked(uint256 indexed roundId, uint64 drawDeadline);
    event DrawRequested(uint256 indexed roundId, uint256 indexed requestId);
    event RandomnessReceived(uint256 indexed roundId, uint256 indexed requestId, uint256 ticketWord, uint256 circuitWord);
    event RandomnessIgnored(uint256 indexed requestId);
    event RefundsOpened(uint256 indexed roundId);
    event Refunded(uint256 indexed roundId, address indexed buyer, uint256 amount);
    event AttemptEvaluated(uint256 indexed roundId, uint32 indexed cursor, uint16 input0, uint16 input1, uint16 output0, uint16 output1, uint16 candidate, bool accepted);
    event DrawProgress(uint256 indexed roundId, uint32 nextCursor);
    event Settled(uint256 indexed roundId, address indexed winner, uint32 winningTicket);
    event BlackholeTransfer(uint256 indexed roundId, uint256 amount);

    modifier nonReentrant() {
        if (guard != 1) revert ReentrantCall();
        guard = 2;
        _;
        guard = 1;
    }

    constructor(
        uint256 poolBaseUnits,
        address token,
        address vrfCoordinator,
        address organizerAddress,
        uint256 vrfSubscriptionId,
        bytes32 vrfKeyHash,
        uint16 confirmations,
        uint32 vrfCallbackGasLimit,
        uint32 fundingWindowSeconds,
        uint32 drawWindowSeconds
    ) {
        if (poolBaseUnits != 100_000_000 && poolBaseUnits != 1_000_000_000
            && poolBaseUnits != 5_000_000_000 && poolBaseUnits != 10_000_000_000) revert BadConfiguration();
        ROUND_POOL = poolBaseUnits;
        TICKET_PRICE = poolBaseUnits / TICKETS_PER_ROUND;
        ORGANIZER_AMOUNT = poolBaseUnits / 100;
        BLACKHOLE_AMOUNT = poolBaseUnits * 4 / 100;
        WINNER_AMOUNT = poolBaseUnits * 95 / 100;
        if (token.code.length == 0 || vrfCoordinator.code.length == 0 || organizerAddress == address(0)
            || organizerAddress == BLACKHOLE || organizerAddress == address(this)
            || vrfSubscriptionId == 0 || vrfKeyHash == bytes32(0)
            || confirmations < 3 || confirmations > 200
            || vrfCallbackGasLimit < 150_000 || vrfCallbackGasLimit > 2_000_000
            || fundingWindowSeconds < 1 hours || fundingWindowSeconds > 30 days
            || drawWindowSeconds < 1 hours || drawWindowSeconds > 30 days) revert BadConfiguration();
        if (IV3SelectableRaffleToken(token).decimals() != 8) revert BadConfiguration();
        if (keccak256(CIRCUIT_RAW) != CIRCUIT_HASH) revert WrongCircuit();
        IV3SelectableRaffleCircuitSource source = IV3SelectableRaffleCircuitSource(CIRCUITS);
        if (keccak256(source.netlist(CIRCUIT_ID)) != CIRCUIT_HASH) revert WrongCircuit();
        (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount) = source.circuitInfo(CIRCUIT_ID);
        if (nIn != 12 || nOut != 9 || nState != 0 || gateCount != 71) revert WrongCircuit();
        bem = IV3SelectableRaffleToken(token);
        coordinator = IV3SelectableRaffleVRFCoordinator(vrfCoordinator);
        organizer = organizerAddress;
        subscriptionId = vrfSubscriptionId;
        keyHash = vrfKeyHash;
        requestConfirmations = confirmations;
        callbackGasLimit = vrfCallbackGasLimit;
        fundingWindow = fundingWindowSeconds;
        drawWindow = drawWindowSeconds;
        sourceVerifiedAtBlock = block.number;
    }

    /// @notice Buy up to count tickets, limited by current stock and address quota.
    /// Only the filled quantity is charged; unspent BEM stays in the buyer wallet.
    function buy(uint256 expectedRoundId, uint32 count) external nonReentrant returns (uint256 roundId) {
        uint32 filled;
        (roundId, filled) = _beginTicketPurchase(expectedRoundId, count);
        if (filled != 0) {
            _assignAutomaticTickets(roundId, filled, _ticketBuyerId(roundId));
            _finishTicketPurchase(roundId, filled);
        }
        _purchaseResult(roundId, count, filled);
    }

    /// @notice Validate the entire ascending, zero-based selection, then fill
    /// its prefix up to available stock/address quota. Sold selected numbers
    /// retain the previous deterministic forward replacement with wraparound.
    function buySelected(uint256 expectedRoundId, uint16[] calldata selectedTickets)
        external nonReentrant returns (uint256 roundId)
    {
        uint256 length = selectedTickets.length;
        if (length == 0) revert InvalidTicketCount();
        if (length > MAX_TICKETS_PER_PURCHASE) revert PurchaseLimitExceeded(length, MAX_TICKETS_PER_PURCHASE);
        // Validate even a tail that will not be filled, including zero-fill races.
        for (uint256 i; i < length; ++i) {
            if (selectedTickets[i] >= TICKETS_PER_ROUND) revert InvalidTicketCount();
            if (i != 0 && selectedTickets[i] <= selectedTickets[i - 1]) revert TicketsNotStrictlyAscending();
        }
        uint32 filled;
        (roundId, filled) = _beginTicketPurchase(expectedRoundId, uint32(length));
        if (filled != 0) {
            _assignSelectedTickets(roundId, selectedTickets[:filled], _ticketBuyerId(roundId));
            _finishTicketPurchase(roundId, filled);
        }
        _purchaseResult(roundId, uint32(length), filled);
    }

    function _purchaseResult(uint256 roundId, uint32 requested, uint32 filled) private {
        emit PurchaseResult(roundId, msg.sender, requested, filled,
            uint256(filled) * TICKET_PRICE, uint256(requested - filled) * TICKET_PRICE);
    }

    function _beginTicketPurchase(uint256 expectedRoundId, uint32 count)
        private returns (uint256 roundId, uint32 filled)
    {
        if (count == 0) revert InvalidTicketCount();
        if (count > MAX_TICKETS_PER_PURCHASE) revert PurchaseLimitExceeded(count, MAX_TICKETS_PER_PURCHASE);
        roundId = currentRoundId;
        if (expectedRoundId != roundId) {
            // A previously full round may have locked between simulation and
            // mining. Record a zero fill, never route the order to a new round.
            if (expectedRoundId < roundId && rounds[expectedRoundId].sold == TICKETS_PER_ROUND) {
                return (expectedRoundId, 0);
            }
            revert WrongRound(expectedRoundId, roundId);
        }
        _requireRoundAuthorization(roundId);
        Round storage r = rounds[roundId];
        if (r.status == Status.Unstarted) {
            r.status = Status.Funding;
            r.fundingDeadline = uint64(block.timestamp + fundingWindow);
            emit RoundStarted(roundId, r.fundingDeadline);
        }
        if (r.status != Status.Funding) revert WrongState();
        if (block.timestamp >= r.fundingDeadline) revert DeadlinePassed();
        filled = count;
        uint32 remaining = TICKETS_PER_ROUND - r.sold;
        if (filled > remaining) filled = remaining;
        uint32 quota = MAX_TICKETS_PER_ADDRESS - ticketsOf[roundId][msg.sender];
        if (filled > quota) filled = quota;
    }

    function _ticketBuyerId(uint256 roundId) private returns (uint16 id) {
        id = ticketBuyerId[roundId][msg.sender];
        if (id == 0) {
            id = ++nextTicketBuyerId[roundId];
            ticketBuyerId[roundId][msg.sender] = id;
            ticketBuyer[roundId][id] = msg.sender;
        }
    }

    function _ticketRange(uint256 roundId, uint32 first, uint32 endExclusive) private {
        // Only called with a nonempty range wholly within 0..10,000.
        unchecked {
            emit TicketsPurchased(roundId, msg.sender, first, endExclusive,
                uint256(endExclusive - first) * TICKET_PRICE);
        }
    }

    function _assignSelectedTickets(uint256 roundId, uint16[] calldata tickets, uint16 buyerId) private {
        SelectionCache memory cache;
        (uint16[] memory missing, uint256 missingCount) = _reserveRequested(cache, roundId, tickets, buyerId);
        if (missingCount != 0) _replaceSoldTickets(cache, roundId, missing, missingCount, buyerId);
        // Each touched storage word is loaded once and written at most once.
        for (uint256 word; word < 625; ++word) {
            if (cache.dirty[word]) packedTicketOwners[roundId][word] = cache.words[word];
        }
    }

    function _selectionWord(SelectionCache memory cache, uint256 roundId, uint256 word) private view returns (uint256) {
        if (!cache.loaded[word]) {
            cache.words[word] = packedTicketOwners[roundId][word];
            cache.loaded[word] = true;
        }
        return cache.words[word];
    }

    function _selectionRange(SelectionRange memory range, uint256 roundId, uint32 ticket) private {
        if (!range.active) {
            range.first = ticket;
            range.active = true;
        } else if (ticket != range.previous + 1) {
            _ticketRange(roundId, range.first, range.previous + 1);
            range.first = ticket;
        }
        range.previous = ticket;
    }

    function _reserveRequested(SelectionCache memory cache, uint256 roundId, uint16[] calldata tickets, uint16 buyerId)
        private returns (uint16[] memory missing, uint256 missingCount)
    {
        missing = new uint16[](tickets.length);
        SelectionRange memory range;
        for (uint256 i; i < tickets.length; ++i) {
            uint32 ticket = uint32(tickets[i]);
            if (ticket >= TICKETS_PER_ROUND) revert InvalidTicketCount();
            if (i != 0 && ticket <= tickets[i - 1]) revert TicketsNotStrictlyAscending();
            uint256 word = ticket >> 4;
            uint256 packed = _selectionWord(cache, roundId, word);
            uint256 shift = (ticket & 15) << 4;
            if (uint16(packed >> shift) != 0) missing[missingCount++] = uint16(ticket);
            else {
                cache.words[word] = packed | (uint256(buyerId) << shift);
                cache.dirty[word] = true;
                _selectionRange(range, roundId, ticket);
            }
        }
        if (range.active) _ticketRange(roundId, range.first, range.previous + 1);
    }

    function _replaceSoldTickets(SelectionCache memory cache, uint256 roundId, uint16[] memory missing, uint256 count, uint16 buyerId) private {
        uint32 cursor;
        uint32 scanned;
        bool wrapped;
        SelectionRange memory range;
        for (uint256 i; i < count; ++i) {
            // Before wrapping, skip straight to the next requested starting point.
            // After wrapping, never restart a scan from a later high request.
            if (!wrapped && cursor <= missing[i]) cursor = uint32(missing[i]) + 1;
            bool assigned;
            while (!assigned) {
                if (cursor == TICKETS_PER_ROUND) { cursor = 0; wrapped = true; }
                uint256 word = cursor >> 4;
                uint256 packed = _selectionWord(cache, roundId, word);
                do {
                    // The caller proved count <= unsold before reserving any
                    // desired tickets. Two linear sweeps suffice, even with gaps.
                    if (++scanned > 2 * TICKETS_PER_ROUND) revert InvalidTicketCount();
                    uint256 shift = (cursor & 15) << 4;
                    if (uint16(packed >> shift) == 0) {
                        cache.words[word] = packed | (uint256(buyerId) << shift);
                        cache.dirty[word] = true;
                        _selectionRange(range, roundId, cursor);
                        assigned = true;
                    }
                    ++cursor;
                } while ((cursor & 15) != 0 && !assigned);
            }
        }
        if (range.active) _ticketRange(roundId, range.first, range.previous + 1);
    }

    function _assignAutomaticTickets(uint256 roundId, uint32 count, uint16 buyerId) private {
      // _beginTicketPurchase proves count <= unsold and supply is exactly 10,000.
      // Thus assigned <= 10,000 and cursor <= 10,000 throughout this bounded scan.
      unchecked {
        uint32 cursor = automaticTicketCursor[roundId];
        uint32 assigned;
        uint32 first;
        uint32 previous;
        // Start at the first not-yet-scanned number and cache each packed word.
        // A purchase scans at most 625 words and writes only words it changes.
        while (assigned < count) {
            uint256 word = cursor >> 4;
            uint256 packed = packedTicketOwners[roundId][word];
            uint256 original = packed;
            do {
                if (uint16(packed >> ((cursor & 15) << 4)) == 0) {
                    if (assigned == 0) first = cursor;
                    else if (cursor != previous + 1) {
                        _ticketRange(roundId, first, previous + 1);
                        first = cursor;
                    }
                    packed |= uint256(buyerId) << ((cursor & 15) << 4);
                    previous = cursor;
                    ++assigned;
                }
                ++cursor;
            } while ((cursor & 15) != 0 && assigned < count);
            if (packed != original) packedTicketOwners[roundId][word] = packed;
        }
        automaticTicketCursor[roundId] = cursor;
        _ticketRange(roundId, first, previous + 1);
      }
    }

    function _finishTicketPurchase(uint256 roundId, uint32 count) private {
        Round storage r = rounds[roundId];
        uint256 amount = uint256(count) * TICKET_PRICE;
        uint256 beforeBalance = bem.balanceOf(address(this));
        _tokenCall(abi.encodeCall(IV3SelectableRaffleToken.transferFrom, (msg.sender, address(this), amount)));
        if (bem.balanceOf(address(this)) != beforeBalance + amount) revert UnexpectedTokenAmount();
        r.sold += count;
        ticketsOf[roundId][msg.sender] += count;
        totalLiability += amount;
        if (r.sold == TICKETS_PER_ROUND) {
            r.status = Status.Locked;
            r.drawDeadline = uint64(block.timestamp + drawWindow);
            currentRoundId = roundId + 1;
            emit RoundLocked(roundId, r.drawDeadline);
            _afterRoundLocked(roundId);
        }
        _assertSolvent();
    }

    /// @notice Anyone may request exactly one draw for a locked round.
    /// @dev VRF subscription costs are paid separately, never taken from the BEM pool.
    function requestDraw(uint256 roundId) external nonReentrant returns (uint256 requestId) {
        return _requestDraw(roundId);
    }

    function _requestDraw(uint256 roundId) internal returns (uint256 requestId) {
        Round storage r = rounds[roundId];
        if (r.status != Status.Locked) revert WrongState();
        if (block.timestamp >= r.drawDeadline) revert DeadlinePassed();
        r.status = Status.Requested;
        requestId = coordinator.requestRandomWords(V3SelectableRaffleVRFClient.RandomWordsRequest({
            keyHash: keyHash,
            subId: subscriptionId,
            requestConfirmations: requestConfirmations,
            callbackGasLimit: callbackGasLimit,
            numWords: 2,
            extraArgs: abi.encodeWithSelector(bytes4(keccak256("VRF ExtraArgsV1")), true)
        }));
        if (requestId == 0 || requestRound[requestId] != 0) revert InvalidRandomness();
        r.requestId = requestId;
        requestRound[requestId] = roundId;
        emit DrawRequested(roundId, requestId);
    }

    /// @dev Cheap callback: no transfers, circuit execution or untrusted external calls.
    function rawFulfillRandomWords(uint256 requestId, uint256[] calldata words) external {
        if (msg.sender != address(coordinator)) revert UnauthorizedCoordinator();
        uint256 roundId = requestRound[requestId];
        Round storage r = rounds[roundId];
        if (roundId == 0 || r.status != Status.Requested) {
            emit RandomnessIgnored(requestId);
            return;
        }
        if (words.length != 2) revert InvalidRandomness();
        r.ticketWord = words[0];
        r.circuitWord = words[1];
        r.status = Status.Ready;
        emit RandomnessReceived(roundId, requestId, words[0], words[1]);
        _afterRandomnessReceived(roundId);
    }

    /// @notice Anyone may settle; recipients and amounts cannot be chosen by the caller.
    /// @dev Transfer to dead address FIRST, then organizer, then winner, atomically.
    /// This locks tokens at the dead address; it does NOT reduce BEM totalSupply().
    function settle(uint256 roundId) external nonReentrant {
        Round storage r = rounds[roundId];
        if (r.status != Status.Ready) revert WrongState();
        _beforeSettlement(roundId);
        // At most eight live circuit calls per transaction. The caller cannot
        // choose or skip candidates; only rejected samples advance the cursor.
        for (uint256 i; i < 4; ++i) {
            uint32 cursor = r.drawCursor;
            Attempt memory a = previewAttempt(r.ticketWord, r.circuitWord, cursor);
            emit AttemptEvaluated(roundId, cursor, a.input0, a.input1, a.output0, a.output1, a.candidate, a.accepted);
            if (a.accepted) {
                _payWinner(roundId, r, a.ticket);
                return;
            }
            r.drawCursor = cursor + 1;
        }
        emit DrawProgress(roundId, r.drawCursor);
    }

    function _payWinner(uint256 roundId, Round storage r, uint32 ticket) private {
        address winner = ticketOwner(roundId, ticket);
        r.status = Status.Settled;
        r.winningTicket = ticket;
        r.winner = winner;
        totalLiability -= ROUND_POOL;
        uint256 balanceBefore = bem.balanceOf(address(this));
        uint256 deadBefore = bem.balanceOf(BLACKHOLE);
        _tokenCall(abi.encodeCall(IV3SelectableRaffleToken.transfer, (BLACKHOLE, BLACKHOLE_AMOUNT)));
        if (bem.balanceOf(BLACKHOLE) != deadBefore + BLACKHOLE_AMOUNT) revert UnexpectedTokenAmount();
        emit BlackholeTransfer(roundId, BLACKHOLE_AMOUNT);
        _tokenCall(abi.encodeCall(IV3SelectableRaffleToken.transfer, (organizer, ORGANIZER_AMOUNT)));
        _tokenCall(abi.encodeCall(IV3SelectableRaffleToken.transfer, (winner, WINNER_AMOUNT)));
        if (bem.balanceOf(address(this)) + ROUND_POOL != balanceBefore) revert UnexpectedTokenAmount();
        _assertSolvent();
        emit Settled(roundId, winner, ticket);
        _afterSettlement(roundId);
    }

    /// @notice Fixed timeout refunds only BEFORE requesting randomness. After
    /// request, funds wait for that exact result and live circuit execution, even
    /// if an external dependency is unavailable. No selective cancellation.
    function openRefunds(uint256 roundId) public {
        Round storage r = rounds[roundId];
        if (r.status == Status.Refunding) return;
        if (r.status == Status.Funding) {
            if (block.timestamp < r.fundingDeadline) revert TooEarly();
            if (currentRoundId == roundId) currentRoundId = roundId + 1;
        } else revert WrongState();
        r.status = Status.Refunding;
        emit RefundsOpened(roundId);
        _afterRefundsOpened(roundId);
    }

    /// @notice Anyone can pay gas to refund a participant; money always goes to that participant.
    function refund(uint256 roundId, address participant) external nonReentrant {
        openRefunds(roundId);
        uint64 deadline = refundClaimDeadline(roundId);
        if (block.timestamp >= deadline || unclaimedPrincipalBurned[roundId]) revert RefundClaimPeriodEnded(deadline);
        uint256 amount = uint256(ticketsOf[roundId][participant]) * TICKET_PRICE;
        if (amount == 0) revert NothingToRefund();
        ticketsOf[roundId][participant] = 0;
        refundedPrincipal[roundId] += amount;
        totalLiability -= amount;
        _tokenCall(abi.encodeCall(IV3SelectableRaffleToken.transfer, (participant, amount)));
        _assertSolvent();
        emit Refunded(roundId, participant, amount);
    }

    /// @notice Fixed deadline, even when refunds are opened late by another caller.
    function refundClaimDeadline(uint256 roundId) public view returns (uint64) {
        uint64 fundingDeadline = rounds[roundId].fundingDeadline;
        return fundingDeadline == 0 ? 0 : fundingDeadline + REFUND_CLAIM_WINDOW;
    }

    /// @notice After the fixed claim deadline, anyone can move only this failed
    /// round's unclaimed principal to the dead address. No other round is touched.
    function burnUnclaimed(uint256 roundId) external nonReentrant {
        Round storage r = rounds[roundId];
        if (r.status != Status.Funding && r.status != Status.Refunding) revert WrongState();
        uint64 deadline = refundClaimDeadline(roundId);
        if (deadline == 0 || block.timestamp < deadline) revert TooEarly();
        if (unclaimedPrincipalBurned[roundId]) revert NothingToBurn();
        openRefunds(roundId);
        uint256 amount = uint256(r.sold) * TICKET_PRICE - refundedPrincipal[roundId];
        if (amount == 0) revert NothingToBurn();
        unclaimedPrincipalBurned[roundId] = true;
        totalLiability -= amount;
        uint256 beforeBalance = bem.balanceOf(address(this));
        uint256 deadBefore = bem.balanceOf(BLACKHOLE);
        _tokenCall(abi.encodeCall(IV3SelectableRaffleToken.transfer, (BLACKHOLE, amount)));
        if (bem.balanceOf(BLACKHOLE) != deadBefore + amount
            || bem.balanceOf(address(this)) + amount != beforeBalance) revert UnexpectedTokenAmount();
        _assertSolvent();
        emit UnclaimedPrincipalBurned(roundId, amount);
    }

    function circuitNetlist() external pure returns (bytes memory) { return CIRCUIT_RAW; }

    /// @notice Exact zero-based ticket ownership. Unsold tickets return zero.
    /// Ownership remains a historical record after refund; tickets cannot be resold.
    function ticketOwner(uint256 roundId, uint32 ticket) public view returns (address) {
        if (ticket >= TICKETS_PER_ROUND) revert InvalidTicketCount();
        uint16 id = uint16(packedTicketOwners[roundId][ticket >> 4] >> ((ticket & 15) << 4));
        return ticketBuyer[roundId][id];
    }

    /// @notice Up to 625 words. Each has 16 low-to-high uint16 buyer IDs; zero=unsold.
    function ticketWords(uint256 roundId, uint16 startWord, uint16 count)
        external view returns (uint256[] memory words)
    {
        if (uint256(startWord) + count > 625) revert InvalidTicketCount();
        words = new uint256[](count);
        for (uint256 i; i < count; ++i) words[i] = packedTicketOwners[roundId][uint256(startWord) + i];
    }

    /// @notice MUST call the real circuit. Known arithmetic is a validation guard,
    /// not a substitute for the call. Inputs and outputs use little-endian bytes.
    function runCircuit2075(uint16 input) public view returns (uint16 output) {
        if (input > 4095) revert WrongCircuit();
        IV3SelectableRaffleCircuitSource source = IV3SelectableRaffleCircuitSource(CIRCUITS);
        if (keccak256(source.netlist(CIRCUIT_ID)) != CIRCUIT_HASH) revert WrongCircuit();
        bytes memory result = source.eval(CIRCUIT_ID, abi.encodePacked(uint8(input), uint8(input >> 8)));
        if (result.length != 2) revert WrongCircuit();
        output = uint16(uint8(result[0])) | (uint16(uint8(result[1])) << 8);
        if (output != (input & 255) + (input >> 8)) revert WrongCircuit();
    }

    /// @notice Public replay of any attempt. Settlement always uses the stored cursor.
    /// The first 20 attempts use disjoint VRF bits. Later attempts use a fixed,
    /// domain-separated cryptographic expansion of the SAME verified words.
    function previewAttempt(uint256 word0, uint256 word1, uint32 cursor) public view returns (Attempt memory a) {
        uint256 group = uint256(cursor) / 10;
        uint256 word = group == 0 ? word0 : group == 1 ? word1
            : uint256(keccak256(abi.encode("BEM2075_INPUTS_V1", word0, word1, group)));
        uint256 shift = (uint256(cursor) % 10) * 24;
        a.input0 = uint16((word >> shift) & 4095);
        a.input1 = uint16((word >> (shift + 12)) & 4095);
        a.output0 = runCircuit2075(a.input0);
        a.output1 = runCircuit2075(a.input1);
        // Each output's LOW byte is uniform: for every high input nibble b,
        // a -> (a+b) mod 256 permutes all 256 low input bytes.
        a.candidate = (uint16(uint8(a.output0)) << 8) | uint16(uint8(a.output1));
        a.accepted = a.candidate < 60_000;
        if (a.accepted) a.ticket = uint32(a.candidate % TICKETS_PER_ROUND);
    }

    /// @dev Specialized games may require an irreversible authorization BEFORE
    /// accepting any ticket money. Settlement and refunds do not use this hook.
    function _requireRoundAuthorization(uint256) internal view virtual {}
    function _afterRoundLocked(uint256) internal virtual {}
    function _afterRandomnessReceived(uint256) internal virtual {}
    function _beforeSettlement(uint256) internal view virtual {}
    function _afterSettlement(uint256) internal virtual {}
    function _afterRefundsOpened(uint256) internal virtual {}

    function _tokenCall(bytes memory data) private {
        (bool ok, bytes memory result) = address(bem).call(data);
        if (!ok || (result.length != 0 && (result.length != 32 || !abi.decode(result, (bool))))) revert TokenTransferFailed();
    }
    function _assertSolvent() private view {
        if (bem.balanceOf(address(this)) < totalLiability) revert Insolvent();
    }
}
