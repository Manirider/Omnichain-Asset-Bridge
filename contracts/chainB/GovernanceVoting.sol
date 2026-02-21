// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title GovernanceVoting - Token-weighted governance for cross-chain decisions
/// @notice Allows wVLT holders to create proposals and vote. When a proposal passes,
///         the relayer detects the event and executes the action on Chain A.
contract GovernanceVoting {
    IERC20 public votingToken;

    struct Proposal {
        string description;
        bytes data;           // Encoded action (e.g., pauseBridge selector)
        uint256 votesFor;
        uint256 votesAgainst;
        uint256 deadline;
        bool executed;
        address proposer;
    }

    uint256 public proposalCount;
    mapping(uint256 => Proposal) public proposals;
    mapping(uint256 => mapping(address => bool)) public hasVoted;

    /// @notice Quorum: minimum total votes required for a proposal to be valid
    uint256 public constant QUORUM = 1;

    /// @notice Voting period in blocks
    uint256 public constant VOTING_PERIOD = 10;

    event ProposalCreated(uint256 indexed proposalId, string description, bytes data);
    event Voted(uint256 indexed proposalId, address indexed voter, bool support, uint256 weight);
    event ProposalPassed(uint256 indexed proposalId, bytes data);

    error ProposalNotActive(uint256 proposalId);
    error AlreadyVoted(uint256 proposalId);
    error ProposalAlreadyExecuted(uint256 proposalId);
    error ProposalNotPassed(uint256 proposalId);
    error VotingNotEnded(uint256 proposalId);
    error NoVotingPower();

    constructor(address _votingToken) {
        votingToken = IERC20(_votingToken);
    }

    /// @notice Create a new governance proposal
    /// @param description Human-readable description
    /// @param data Encoded action data (e.g., abi.encodeWithSignature("pauseBridge()"))
    function createProposal(
        string calldata description,
        bytes calldata data
    ) external returns (uint256) {
        uint256 proposalId = proposalCount++;
        proposals[proposalId] = Proposal({
            description: description,
            data: data,
            votesFor: 0,
            votesAgainst: 0,
            deadline: block.number + VOTING_PERIOD,
            executed: false,
            proposer: msg.sender
        });

        emit ProposalCreated(proposalId, description, data);
        return proposalId;
    }

    /// @notice Vote on a proposal using token-weighted voting
    /// @param proposalId The proposal to vote on
    /// @param support True for yes, false for no
    function vote(uint256 proposalId, bool support) external {
        Proposal storage proposal = proposals[proposalId];

        if (block.number > proposal.deadline) revert ProposalNotActive(proposalId);
        if (hasVoted[proposalId][msg.sender]) revert AlreadyVoted(proposalId);

        uint256 weight = votingToken.balanceOf(msg.sender);
        if (weight == 0) revert NoVotingPower();

        hasVoted[proposalId][msg.sender] = true;

        if (support) {
            proposal.votesFor += weight;
        } else {
            proposal.votesAgainst += weight;
        }

        emit Voted(proposalId, msg.sender, support, weight);
    }

    /// @notice Execute a passed proposal (emits event for relayer)
    /// @param proposalId The proposal to execute
    function executeProposal(uint256 proposalId) external {
        Proposal storage proposal = proposals[proposalId];

        if (proposal.executed) revert ProposalAlreadyExecuted(proposalId);
        if (block.number <= proposal.deadline) revert VotingNotEnded(proposalId);
        if (proposal.votesFor <= proposal.votesAgainst) revert ProposalNotPassed(proposalId);
        if (proposal.votesFor < QUORUM) revert ProposalNotPassed(proposalId);

        proposal.executed = true;

        emit ProposalPassed(proposalId, proposal.data);
    }
}
