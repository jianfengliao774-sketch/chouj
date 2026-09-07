// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
import {BemDrandRaffleCandidate} from "./BemDrandRaffleCandidate.sol";
import {DrandEvmnetVerifier} from "./DrandEvmnetVerifier.sol";
interface ISparkDrawContainer { function token() external view returns(uint256,address,uint256); }
interface ISparkDrawNft { function ownerOf(uint256) external view returns(address); }
interface ISparkDrawOpener {
    function accountOf(address,uint256) external view returns(address);
    function isOpened(address,uint256) external view returns(bool);
}

/// @notice BNB release with immutable official token, revenue and verifier bindings.
/// Deployment activates purchases. The first actual purchase starts each 24h funding clock.
/// No further container execution, token custody permission or owner intervention is needed.
contract TapeoutSparkDrawBSC is BemDrandRaffleCandidate {
    address public constant DEPLOYER = 0x7674fa446D42b1f7f150DC5e678cc525d275Ea53;
    address public constant REVENUE_CONTAINER = 0x001f110422F04a90bF7D6eC96714f75046BD7126;
    address public constant REVENUE_NFT = 0xb1024b89886B9a34Aa4ff5F31C411D708b20a14C;
    uint256 public constant REVENUE_TOKEN_ID = 13061;
    address public constant OPENER = 0x021745DE2f42A7839d96f2d3634d0294487D81F1;
    bool public constant seriesAuthorized = true;
    uint256 public constant CONTRACT_VERSION = 5;
    event RevenueBindingFixed(address indexed container,address indexed nft,uint256 tokenId);

    constructor(uint256 poolBaseUnits,address drandVerifier)
        BemDrandRaffleCandidate(poolBaseUnits,OFFICIAL_BEM,drandVerifier,REVENUE_CONTAINER)
    {
        if(block.chainid!=56 || msg.sender!=DEPLOYER) revert BadConfiguration();
        if(drandVerifier.codehash!=keccak256(type(DrandEvmnetVerifier).runtimeCode)) revert BadConfiguration();
        if(ISparkDrawNft(REVENUE_NFT).ownerOf(REVENUE_TOKEN_ID)!=DEPLOYER
            || ISparkDrawOpener(OPENER).accountOf(REVENUE_NFT,REVENUE_TOKEN_ID)!=REVENUE_CONTAINER
            || !ISparkDrawOpener(OPENER).isOpened(REVENUE_NFT,REVENUE_TOKEN_ID)) revert BadConfiguration();
        (uint256 chain,address nft,uint256 id)=ISparkDrawContainer(REVENUE_CONTAINER).token();
        if(chain!=56 || nft!=REVENUE_NFT || id!=REVENUE_TOKEN_ID) revert BadConfiguration();
        emit RevenueBindingFixed(REVENUE_CONTAINER,REVENUE_NFT,REVENUE_TOKEN_ID);
    }
}
