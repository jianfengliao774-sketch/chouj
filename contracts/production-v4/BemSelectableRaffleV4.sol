// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

// V4 partial-fill candidate. Release leaves pin a formal denomination.
// Container authorization and operating cadence belong to the series wrapper.

interface IV4SelectableRaffleToken {
    function decimals() external view returns (uint8);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IV4SelectableRaffleCircuitSource {
    function netlist(uint256 id) external view returns (bytes memory);
    function circuitInfo(uint256 id) external view returns (uint32, uint32, uint32, uint32);
    function eval(uint256 id, bytes calldata inputs) external view returns (bytes memory);
}

library V4SelectableRaffleVRFClient {
    struct RandomWordsRequest {
        bytes32 keyHash;
        uint256 subId;
        uint16 requestConfirmations;
        uint32 callbackGasLimit;
        uint32 numWords;
        bytes extraArgs;
    }
}

interface IV4SelectableRaffleVRFCoordinator {
    function requestRandomWords(V4SelectableRaffleVRFClient.RandomWordsRequest calldata request)
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
contract BemSelectableRaffleV4 {
    bool public constant PARTIAL_FILL = true;
    uint256 public immutable TICKET_PRICE; // Fixed by the release leaf, 8 BEM decimals
    uint32 public constant TICKETS_PER_ROUND = 10_000;
    // Each transaction remains subject to the network gas limit; wallets estimate
    // the chosen tickets before sending. Multiple buys share the address limit.
    uint32 public constant MAX_TICKETS_PER_PURCHASE = 5000;
    uint32 public constant MAX_TICKETS_PER_ADDRESS = 5000;
    uint64 public constant REFUND_CLAIM_WINDOW = 24 hours;
    mapping(uint256 => uint256) public refundedPrincipal;
    mapping(uint256 => bool) public unclaimedPrincipalBurned;
    uint256 public immutable ROUND_POOL;
    uint256 public immutable ORGANIZER_AMOUNT;
    uint256 public immutable BLACKHOLE_AMOUNT;
    uint256 public immutable BURN_PERCENT;
    uint32 public constant EARLY_DRAW_THRESHOLD = 9500;
    uint64 public constant EARLY_DRAW_DELAY = 30 minutes;
    bool public constant BITMAP_TICKETS = true;
    mapping(uint256 => uint64) public earlyDrawDeadline;
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
    IV4SelectableRaffleToken public immutable bem;
    IV4SelectableRaffleVRFCoordinator public immutable coordinator;
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
    // Each storage word packs 18 14-bit buyer IDs.
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
    event EarlyDrawScheduled(uint256 indexed roundId, uint64 closesAt, uint32 sold);
    event TicketsAllocated(uint256 indexed roundId, address indexed buyer, uint256[40] bitmap, uint32 count, uint256 paid);
    event UnsoldTicketSkipped(uint256 indexed roundId, uint32 cursor, uint32 ticket);
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
        if (poolBaseUnits != 500_000_000 && poolBaseUnits != 1_000_000_000
            && poolBaseUnits != 5_000_000_000 && poolBaseUnits != 10_000_000_000) revert BadConfiguration();
        ROUND_POOL = poolBaseUnits;
        TICKET_PRICE = poolBaseUnits / TICKETS_PER_ROUND;
        ORGANIZER_AMOUNT = poolBaseUnits / 100;
        uint256 burnPercent = poolBaseUnits == 500_000_000 ? 3 : poolBaseUnits == 1_000_000_000 ? 4 : poolBaseUnits == 5_000_000_000 ? 5 : 6;
        BURN_PERCENT = burnPercent;
        BLACKHOLE_AMOUNT = poolBaseUnits * burnPercent / 100;
        WINNER_AMOUNT = poolBaseUnits - ORGANIZER_AMOUNT - BLACKHOLE_AMOUNT;
        if (token.code.length == 0 || vrfCoordinator.code.length == 0 || organizerAddress == address(0)
            || organizerAddress == BLACKHOLE || organizerAddress == address(this)
            || vrfSubscriptionId == 0 || vrfKeyHash == bytes32(0)
            || confirmations < 3 || confirmations > 200
            || vrfCallbackGasLimit < 150_000 || vrfCallbackGasLimit > 2_000_000
            || fundingWindowSeconds < 1 hours || fundingWindowSeconds > 30 days
            || drawWindowSeconds < 1 hours || drawWindowSeconds > 30 days) revert BadConfiguration();
        if (IV4SelectableRaffleToken(token).decimals() != 8) revert BadConfiguration();
        if (keccak256(CIRCUIT_RAW) != CIRCUIT_HASH) revert WrongCircuit();
        IV4SelectableRaffleCircuitSource source = IV4SelectableRaffleCircuitSource(CIRCUITS);
        if (keccak256(source.netlist(CIRCUIT_ID)) != CIRCUIT_HASH) revert WrongCircuit();
        (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount) = source.circuitInfo(CIRCUIT_ID);
        if (nIn != 12 || nOut != 9 || nState != 0 || gateCount != 71) revert WrongCircuit();
        bem = IV4SelectableRaffleToken(token);
        coordinator = IV4SelectableRaffleVRFCoordinator(vrfCoordinator);
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
            if (expectedRoundId < roundId && rounds[expectedRoundId].sold >= EARLY_DRAW_THRESHOLD && rounds[expectedRoundId].status != Status.Funding && rounds[expectedRoundId].status != Status.Refunding) {
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
        if (block.timestamp >= fundingClosesAt(roundId)) revert DeadlinePassed();
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

    // 18 owners per storage word, 14 bits per ID: 10,000 buyers fit without
    // truncation. One bitmap event avoids thousands of per-range log entries.
    function _assignSelectedTickets(uint256 roundId, uint16[] calldata tickets, uint16 buyerId) private {
        uint256[556] memory words;
        uint256[40] memory allocated;
        uint16[] memory missing = new uint16[](tickets.length);
        // All calldata tickets were validated ascending and <10,000 before this
        // call. Word indices are <=555, bitmap indices <=39, buyerId <=10,000.
        // Scratch memory is only 0..63; arrays are compiler-allocated and bounded.
        assembly ("memory-safe") {
            mstore(0, roundId)
            mstore(32, packedTicketOwners.slot)
            let base := keccak256(0,64)
            for { let w := 0 } lt(w,556) { w := add(w,1) } {
                mstore(0,w) mstore(32,base)
                mstore(add(words,mul(w,32)),sload(keccak256(0,64)))
            }
            let nMissing := 0
            for { let i := 0 } lt(i,tickets.length) { i := add(i,1) } {
                let ticket := calldataload(add(tickets.offset,mul(i,32)))
                let location := add(words,mul(div(ticket,18),32))
                let shift := mul(mod(ticket,18),14)
                let packed := mload(location)
                switch and(shr(shift,packed),16383)
                case 0 {
                    mstore(location,or(packed,shl(shift,buyerId)))
                    let bitmap := add(allocated,mul(shr(8,ticket),32))
                    mstore(bitmap,or(mload(bitmap),shl(and(ticket,255),1)))
                }
                default { mstore(add(add(missing,32),mul(nMissing,32)),ticket) nMissing := add(nMissing,1) }
            }
            let cursor := 0
            let scanned := 0
            let wrapped := 0
            for { let i := 0 } lt(i,nMissing) { i := add(i,1) } {
                let requested := mload(add(add(missing,32),mul(i,32)))
                if and(iszero(wrapped),iszero(gt(cursor,requested))) { cursor := add(requested,1) }
                for { } 1 { } {
                    if eq(cursor,10000) { cursor := 0 wrapped := 1 }
                    scanned := add(scanned,1)
                    if gt(scanned,20000) { revert(0,0) }
                    let location := add(words,mul(div(cursor,18),32))
                    let shift := mul(mod(cursor,18),14)
                    let packed := mload(location)
                    if iszero(and(shr(shift,packed),16383)) {
                        mstore(location,or(packed,shl(shift,buyerId)))
                        let bitmap := add(allocated,mul(shr(8,cursor),32))
                        mstore(bitmap,or(mload(bitmap),shl(and(cursor,255),1)))
                        cursor := add(cursor,1)
                        break
                    }
                    cursor := add(cursor,1)
                }
            }
            for { let w := 0 } lt(w,556) { w := add(w,1) } {
                mstore(0,w) mstore(32,base)
                let key := keccak256(0,64)
                let packed := mload(add(words,mul(w,32)))
                if iszero(eq(sload(key),packed)) { sstore(key,packed) }
            }
        }
        emit TicketsAllocated(roundId, msg.sender, allocated, uint32(tickets.length), tickets.length * TICKET_PRICE);
    }

    function _assignAutomaticTickets(uint256 roundId, uint32 count, uint16 buyerId) private {
        unchecked {
            uint32 cursor = automaticTicketCursor[roundId];
            uint32 assigned;
            uint256[40] memory allocated;
            while (assigned < count) {
                uint256 word = cursor / 18;
                uint256 packed = packedTicketOwners[roundId][word];
                uint256 original = packed;
                do {
                    uint256 shift = (cursor % 18) * 14;
                    if (((packed >> shift) & 16383) == 0) {
                        packed |= uint256(buyerId) << shift;
                        allocated[cursor >> 8] |= uint256(1) << (cursor & 255);
                        ++assigned;
                    }
                    ++cursor;
                } while (cursor % 18 != 0 && assigned < count);
                if (packed != original) packedTicketOwners[roundId][word] = packed;
            }
            automaticTicketCursor[roundId] = cursor;
            emit TicketsAllocated(roundId, msg.sender, allocated, count, uint256(count) * TICKET_PRICE);
        }
    }

    function fundingClosesAt(uint256 roundId) public view returns (uint64) {
        uint64 early = earlyDrawDeadline[roundId];
        return early == 0 ? rounds[roundId].fundingDeadline : early;
    }

    /// Anyone may close a due 95%-funded round; no caller can choose its winner.
    function closeRound(uint256 roundId) external nonReentrant {
        Round storage r = rounds[roundId];
        if (roundId != currentRoundId || r.status != Status.Funding || r.sold < EARLY_DRAW_THRESHOLD) revert WrongState();
        if (earlyDrawDeadline[roundId] == 0 || block.timestamp < fundingClosesAt(roundId)) revert TooEarly();
        _lockFundingRound(roundId, r);
    }

    function _lockFundingRound(uint256 roundId, Round storage r) private {
        r.status = Status.Locked;
        r.drawDeadline = uint64(block.timestamp + drawWindow);
        currentRoundId = roundId + 1;
        emit RoundLocked(roundId, r.drawDeadline);
        _afterRoundLocked(roundId);
    }

    function _finishTicketPurchase(uint256 roundId, uint32 count) private {
        Round storage r = rounds[roundId];
        uint256 amount = uint256(count) * TICKET_PRICE;
        uint256 beforeBalance = bem.balanceOf(address(this));
        _tokenCall(abi.encodeCall(IV4SelectableRaffleToken.transferFrom, (msg.sender, address(this), amount)));
        if (bem.balanceOf(address(this)) != beforeBalance + amount) revert UnexpectedTokenAmount();
        r.sold += count;
        ticketsOf[roundId][msg.sender] += count;
        totalLiability += amount;
        if (r.sold == TICKETS_PER_ROUND) {
            _lockFundingRound(roundId, r);
        } else if (r.sold >= EARLY_DRAW_THRESHOLD && earlyDrawDeadline[roundId] == 0) {
            uint64 closes = uint64(block.timestamp + EARLY_DRAW_DELAY);
            if (closes > r.fundingDeadline) closes = r.fundingDeadline;
            earlyDrawDeadline[roundId] = closes;
            emit EarlyDrawScheduled(roundId, closes, r.sold);
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
        requestId = coordinator.requestRandomWords(V4SelectableRaffleVRFClient.RandomWordsRequest({
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
            if (a.accepted && ticketOwner(roundId, a.ticket) != address(0)) {
                _payWinner(roundId, r, a.ticket);
                return;
            }
            if (a.accepted) emit UnsoldTicketSkipped(roundId, cursor, a.ticket);
            r.drawCursor = cursor + 1;
        }
        emit DrawProgress(roundId, r.drawCursor);
    }

    function _payWinner(uint256 roundId, Round storage r, uint32 ticket) private {
        address winner = ticketOwner(roundId, ticket);
        r.status = Status.Settled;
        r.winningTicket = ticket;
        r.winner = winner;
        uint256 gross = uint256(r.sold) * TICKET_PRICE;
        uint256 fee = gross / 100;
        uint256 burn = gross * BURN_PERCENT / 100;
        uint256 prize = gross - fee - burn;
        totalLiability -= gross;
        uint256 balanceBefore = bem.balanceOf(address(this));
        uint256 deadBefore = bem.balanceOf(BLACKHOLE);
        _tokenCall(abi.encodeCall(IV4SelectableRaffleToken.transfer, (BLACKHOLE, burn)));
        if (bem.balanceOf(BLACKHOLE) != deadBefore + burn) revert UnexpectedTokenAmount();
        emit BlackholeTransfer(roundId, burn);
        _tokenCall(abi.encodeCall(IV4SelectableRaffleToken.transfer, (organizer, fee)));
        _tokenCall(abi.encodeCall(IV4SelectableRaffleToken.transfer, (winner, prize)));
        if (bem.balanceOf(address(this)) + gross != balanceBefore) revert UnexpectedTokenAmount();
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
            if (r.sold >= EARLY_DRAW_THRESHOLD) revert WrongState();
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
        _tokenCall(abi.encodeCall(IV4SelectableRaffleToken.transfer, (participant, amount)));
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
        _tokenCall(abi.encodeCall(IV4SelectableRaffleToken.transfer, (BLACKHOLE, amount)));
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
        uint16 id = uint16((packedTicketOwners[roundId][ticket / 18] >> ((ticket % 18) * 14)) & 16383);
        return ticketBuyer[roundId][id];
    }

    /// @notice Up to 556 words. Each has 18 low-to-high 14-bit buyer IDs; zero=unsold.
    function ticketWords(uint256 roundId, uint16 startWord, uint16 count)
        external view returns (uint256[] memory words)
    {
        if (uint256(startWord) + count > 556) revert InvalidTicketCount();
        words = new uint256[](count);
        for (uint256 i; i < count; ++i) words[i] = packedTicketOwners[roundId][uint256(startWord) + i];
    }

    /// @notice MUST call the real circuit. Known arithmetic is a validation guard,
    /// not a substitute for the call. Inputs and outputs use little-endian bytes.
    function runCircuit2075(uint16 input) public view returns (uint16 output) {
        if (input > 4095) revert WrongCircuit();
        IV4SelectableRaffleCircuitSource source = IV4SelectableRaffleCircuitSource(CIRCUITS);
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
