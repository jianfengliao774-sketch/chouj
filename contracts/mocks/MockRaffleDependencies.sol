// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../BemCircuitRaffle.sol";

/// @dev LOCAL TEST ONLY. The setters deliberately model hostile dependencies.
contract MockRaffleToken {
    uint8 public decimals;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public failedRecipient;
    uint8 public failureMode;
    bool public taxDeposits;
    event Transfer(address indexed from, address indexed to, uint256 amount);

    constructor(uint8 decimalPlaces) { decimals = decimalPlaces; }
    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }
    function setFailure(address recipient, uint8 mode) external {
        failedRecipient = recipient;
        failureMode = mode;
    }
    function setTaxDeposits(bool enabled) external { taxDeposits = enabled; }
    function transfer(address to, uint256 amount) external returns (bool) {
        if (to == failedRecipient && failureMode != 0) {
            if (failureMode == 1) return false;
            revert("mock transfer failure");
        }
        _transfer(msg.sender, to, amount, false);
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allowance");
        allowance[from][msg.sender] -= amount;
        _transfer(from, to, amount, taxDeposits);
        return true;
    }
    function _transfer(address from, address to, uint256 amount, bool tax) private {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        uint256 received = tax ? amount - 1 : amount;
        balanceOf[to] += received;
        if (tax) totalSupply -= 1;
        emit Transfer(from, to, received);
    }
}

contract MockRaffleCircuitSource {
    bytes private raw;
    uint8 public evalMode;
    bool public wrongInfo;
    function setNetlist(bytes calldata value) external { raw = value; }
    function setEvalMode(uint8 value) external { evalMode = value; }
    function setWrongInfo(bool value) external { wrongInfo = value; }
    function netlist(uint256 id) external view returns (bytes memory) {
        require(id == 2075, "wrong circuit id");
        return raw;
    }
    function circuitInfo(uint256 id) external view returns (uint32, uint32, uint32, uint32) {
        require(id == 2075, "wrong circuit id");
        return (12, 9, 0, wrongInfo ? 72 : 71);
    }
    function eval(uint256 id, bytes calldata inputs) external view returns (bytes memory) {
        require(id == 2075 && inputs.length == 2, "wrong eval call");
        require(evalMode != 1, "mock source unavailable");
        uint16 input = uint16(uint8(inputs[0])) | (uint16(uint8(inputs[1])) << 8);
        require(input < 4096, "out-of-range input");
        uint16 output = (input & 255) + (input >> 8);
        if (evalMode == 2) output += 1;
        if (evalMode == 3) return abi.encodePacked(uint8(output));
        if (evalMode == 4) output |= 512;
        return abi.encodePacked(uint8(output), uint8(output >> 8));
    }
}

contract MockRaffleCoordinator {
    uint256 public nextRequestId = 1;
    uint256 public requestCount;
    uint32 public lastNumWords;
    uint32 public lastCallbackGasLimit;
    uint16 public lastConfirmations;
    bytes32 public lastKeyHash;
    uint256 public lastSubId;
    bytes public lastExtraArgs;
    mapping(uint256 => address) public consumers;

    function setNextRequestId(uint256 value) external { nextRequestId = value; }
    function requestRandomWords(RaffleVRFClient.RandomWordsRequest calldata request)
        external returns (uint256 requestId)
    {
        requestId = nextRequestId++;
        requestCount++;
        lastNumWords = request.numWords;
        lastCallbackGasLimit = request.callbackGasLimit;
        lastConfirmations = request.requestConfirmations;
        lastKeyHash = request.keyHash;
        lastSubId = request.subId;
        lastExtraArgs = request.extraArgs;
        consumers[requestId] = msg.sender;
    }
    function fulfill(address consumer, uint256 requestId, uint256[] calldata words) external {
        BemCircuitRaffle(consumer).rawFulfillRandomWords(requestId, words);
    }
}
