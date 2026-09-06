// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IRaffleToken {
    function decimals() external view returns (uint8);
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IRaffleCircuitSource {
    function netlist(uint256 id) external view returns (bytes memory);
    function circuitInfo(uint256 id) external view returns (uint32, uint32, uint32, uint32);
    function eval(uint256 id, bytes calldata inputs) external view returns (bytes memory);
}

library RaffleVRFClient {
    struct RandomWordsRequest {
        bytes32 keyHash;
        uint256 subId;
        uint16 requestConfirmations;
        uint32 callbackGasLimit;
        uint32 numWords;
        bytes extraArgs;
    }
}

interface IRaffleVRFCoordinator {
    function requestRandomWords(RaffleVRFClient.RandomWordsRequest calldata request)
        external returns (uint256 requestId);
}

/// @notice Fixed 100-BEM, 10,000-ticket raffle. No administrator or upgrade entry point.
/// @dev Winning bytes MUST be obtained from live Behemoth #2075 eval calls. The
/// verified arithmetic is used only to reject incorrect upstream outputs; never
/// as a fallback. Upstream failure can block settlement. Randomness comes from VRF,
/// NOT from the deterministic circuit. A requested draw cannot be cancelled or rerolled.
/// The token constructor argument permits testing; mainnet deployment MUST use official BEM.
contract BemCircuitRaffle {
    uint256 public constant TICKET_PRICE = 1_000_000; // 0.01 BEM, 8 decimals
    uint32 public constant TICKETS_PER_ROUND = 10_000;
    uint256 public constant ROUND_POOL = 10_000_000_000;
    uint256 public constant ORGANIZER_AMOUNT = 100_000_000;
    uint256 public constant BLACKHOLE_AMOUNT = 400_000_000;
    uint256 public constant WINNER_AMOUNT = 9_500_000_000;
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
    struct Entry { address buyer; uint32 endExclusive; }
    struct Attempt {
        uint16 input0;
        uint16 input1;
        uint16 output0;
        uint16 output1;
        uint16 candidate;
        bool accepted;
        uint32 ticket;
    }

    IRaffleToken public immutable bem;
    IRaffleVRFCoordinator public immutable coordinator;
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
    mapping(uint256 => Entry[]) private entries;
    mapping(uint256 => mapping(address => uint32)) public ticketsOf;
    mapping(uint256 => uint256) public requestRound;

    error BadConfiguration();
    error WrongCircuit();
    error WrongState();
    error DeadlinePassed();
    error TooEarly();
    error InvalidTicketCount();
    error TokenTransferFailed();
    error UnexpectedTokenAmount();
    error UnauthorizedCoordinator();
    error ReentrantCall();
    error NothingToRefund();
    error InvalidRandomness();
    error Insolvent();
    error WrongRound(uint256 expectedRoundId, uint256 actualRoundId);

    event RoundStarted(uint256 indexed roundId, uint64 fundingDeadline);
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
        if (token.code.length == 0 || vrfCoordinator.code.length == 0 || organizerAddress == address(0)
            || organizerAddress == BLACKHOLE || organizerAddress == address(this)
            || vrfSubscriptionId == 0 || vrfKeyHash == bytes32(0)
            || confirmations < 3 || confirmations > 200
            || vrfCallbackGasLimit < 150_000 || vrfCallbackGasLimit > 2_000_000
            || fundingWindowSeconds < 1 hours || fundingWindowSeconds > 30 days
            || drawWindowSeconds < 1 hours || drawWindowSeconds > 30 days) revert BadConfiguration();
        if (IRaffleToken(token).decimals() != 8) revert BadConfiguration();
        if (keccak256(CIRCUIT_RAW) != CIRCUIT_HASH) revert WrongCircuit();
        IRaffleCircuitSource source = IRaffleCircuitSource(CIRCUITS);
        if (keccak256(source.netlist(CIRCUIT_ID)) != CIRCUIT_HASH) revert WrongCircuit();
        (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount) = source.circuitInfo(CIRCUIT_ID);
        if (nIn != 12 || nOut != 9 || nState != 0 || gateCount != 71) revert WrongCircuit();
        bem = IRaffleToken(token);
        coordinator = IRaffleVRFCoordinator(vrfCoordinator);
        organizer = organizerAddress;
        subscriptionId = vrfSubscriptionId;
        keyHash = vrfKeyHash;
        requestConfirmations = confirmations;
        callbackGasLimit = vrfCallbackGasLimit;
        fundingWindow = fundingWindowSeconds;
        drawWindow = drawWindowSeconds;
        sourceVerifiedAtBlock = block.number;
    }

    /// @notice Buy integral 0.01-BEM tickets in the explicitly chosen round.
    /// A stale round or over-cap purchase reverts in full; never rolls into a new round.
    /// @dev Direct BEM transfers do not buy tickets or count toward any round.
    function buy(uint256 expectedRoundId, uint32 count) external nonReentrant returns (uint256 roundId) {
        if (count == 0 || count > TICKETS_PER_ROUND) revert InvalidTicketCount();
        roundId = currentRoundId;
        if (expectedRoundId != roundId) revert WrongRound(expectedRoundId, roundId);
        _requireRoundAuthorization(roundId);
        Round storage r = rounds[roundId];
        if (r.status == Status.Unstarted) {
            r.status = Status.Funding;
            r.fundingDeadline = uint64(block.timestamp + fundingWindow);
            emit RoundStarted(roundId, r.fundingDeadline);
        }
        if (r.status != Status.Funding) revert WrongState();
        if (block.timestamp >= r.fundingDeadline) revert DeadlinePassed();
        uint32 first = r.sold;
        if (count > TICKETS_PER_ROUND - first) revert InvalidTicketCount();
        uint256 amount = uint256(count) * TICKET_PRICE;
        uint256 beforeBalance = bem.balanceOf(address(this));
        _tokenCall(abi.encodeCall(IRaffleToken.transferFrom, (msg.sender, address(this), amount)));
        if (bem.balanceOf(address(this)) != beforeBalance + amount) revert UnexpectedTokenAmount();
        r.sold = first + count;
        ticketsOf[roundId][msg.sender] += count;
        Entry[] storage es = entries[roundId];
        if (es.length != 0 && es[es.length - 1].buyer == msg.sender) es[es.length - 1].endExclusive = r.sold;
        else es.push(Entry(msg.sender, r.sold));
        totalLiability += amount;
        emit TicketsPurchased(roundId, msg.sender, first, r.sold, amount);
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
        requestId = coordinator.requestRandomWords(RaffleVRFClient.RandomWordsRequest({
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
        _tokenCall(abi.encodeCall(IRaffleToken.transfer, (BLACKHOLE, BLACKHOLE_AMOUNT)));
        if (bem.balanceOf(BLACKHOLE) != deadBefore + BLACKHOLE_AMOUNT) revert UnexpectedTokenAmount();
        emit BlackholeTransfer(roundId, BLACKHOLE_AMOUNT);
        _tokenCall(abi.encodeCall(IRaffleToken.transfer, (organizer, ORGANIZER_AMOUNT)));
        _tokenCall(abi.encodeCall(IRaffleToken.transfer, (winner, WINNER_AMOUNT)));
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
        } else if (r.status == Status.Locked) {
            if (block.timestamp < r.drawDeadline) revert TooEarly();
        } else revert WrongState();
        r.status = Status.Refunding;
        emit RefundsOpened(roundId);
        _afterRefundsOpened(roundId);
    }

    /// @notice Anyone can pay gas to refund a participant; money always goes to that participant.
    function refund(uint256 roundId, address participant) external nonReentrant {
        openRefunds(roundId);
        uint256 amount = uint256(ticketsOf[roundId][participant]) * TICKET_PRICE;
        if (amount == 0) revert NothingToRefund();
        ticketsOf[roundId][participant] = 0;
        totalLiability -= amount;
        _tokenCall(abi.encodeCall(IRaffleToken.transfer, (participant, amount)));
        _assertSolvent();
        emit Refunded(roundId, participant, amount);
    }

    function entryCount(uint256 roundId) external view returns (uint256) { return entries[roundId].length; }
    function entryAt(uint256 roundId, uint256 index) external view returns (Entry memory) { return entries[roundId][index]; }
    function circuitNetlist() external pure returns (bytes memory) { return CIRCUIT_RAW; }

    /// @notice Ticket IDs are 0..9999; UI may display them as 1..10000.
    function ticketOwner(uint256 roundId, uint32 ticket) public view returns (address) {
        if (ticket >= rounds[roundId].sold) revert InvalidTicketCount();
        Entry[] storage es = entries[roundId];
        uint256 low;
        uint256 high = es.length;
        while (low < high) {
            uint256 mid = (low + high) / 2;
            if (ticket < es[mid].endExclusive) high = mid;
            else low = mid + 1;
        }
        return es[low].buyer;
    }

    /// @notice MUST call the real circuit. Known arithmetic is a validation guard,
    /// not a substitute for the call. Inputs and outputs use little-endian bytes.
    function runCircuit2075(uint16 input) public view returns (uint16 output) {
        if (input > 4095) revert WrongCircuit();
        IRaffleCircuitSource source = IRaffleCircuitSource(CIRCUITS);
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
