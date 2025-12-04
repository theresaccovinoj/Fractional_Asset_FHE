pragma solidity ^0.8.24;
import { FHE, euint32, ebool } from "@fhevm/solidity/lib/FHE.sol";
import { SepoliaConfig } from "@fhevm/solidity/config/ZamaConfig.sol";

contract FractionalAssetFHE is SepoliaConfig {
    using FHE for euint32;
    using FHE for ebool;

    error NotOwner();
    error NotProvider();
    error Paused();
    error InvalidState();
    error BatchClosed();
    error BatchFull();
    error CooldownActive();
    error InvalidRequest();
    error InvalidProof();
    error ReplayAttempt();
    error StaleWrite();

    event ProviderAdded(address indexed provider);
    event ProviderRemoved(address indexed provider);
    event Paused();
    event Unpaused();
    event CooldownUpdated(uint256 oldInterval, uint256 newInterval);
    event BatchOpened(uint256 indexed batchId);
    event BatchClosed(uint256 indexed batchId);
    event AssetContributionSubmitted(
        address indexed contributor,
        uint256 indexed batchId,
        bytes32 encryptedShare
    );
    event DecryptionRequested(uint256 indexed requestId, uint256 indexed batchId);
    event DecryptionCompleted(
        uint256 indexed requestId,
        uint256 indexed batchId,
        uint256 totalShares
    );

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyProvider() {
        if (!providers[msg.sender]) revert NotProvider();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert Paused();
        _;
    }

    modifier checkCooldown() {
        if (block.timestamp < lastActionAt[msg.sender] + minInterval) {
            revert CooldownActive();
        }
        _;
    }

    address public owner;
    bool public paused;
    uint256 public minInterval;
    uint256 public currentBatchId;
    uint256 public modelVersion;
    mapping(address => bool) public providers;
    mapping(address => uint256) public lastActionAt;
    mapping(uint256 => Batch) public batches;
    mapping(uint256 => DecryptionContext) public decryptionContexts;

    struct Contribution {
        euint32 encryptedShare;
        bool initialized;
    }

    struct Batch {
        uint256 batchId;
        uint256 numContributions;
        uint256 maxContributions;
        bool isOpen;
        mapping(uint256 => Contribution) contributions;
        euint32 encryptedTotalShares;
    }

    struct DecryptionContext {
        uint256 batchId;
        uint256 modelVersion;
        bytes32 stateHash;
        bool processed;
    }

    constructor() {
        owner = msg.sender;
        modelVersion = 1;
        minInterval = 30 seconds;
        _openNewBatch(10);
    }

    function _openNewBatch(uint256 maxContributions) internal {
        currentBatchId++;
        Batch storage batch = batches[currentBatchId];
        batch.batchId = currentBatchId;
        batch.maxContributions = maxContributions;
        batch.isOpen = true;
        batch.encryptedTotalShares = FHE.asEuint32(0);
        emit BatchOpened(currentBatchId);
    }

    function _hashCiphertexts(bytes32[] memory cts) internal pure returns (bytes32) {
        return keccak256(abi.encode(cts, address(this)));
    }

    function _initIfNeeded(euint32 x) internal returns (euint32) {
        if (!FHE.isInitialized(x)) {
            x = FHE.asEuint32(0);
        }
        return x;
    }

    function _requireInitialized(euint32 x, string memory tag) internal pure {
        if (!FHE.isInitialized(x)) {
            revert InvalidState();
        }
    }

    function pause() external onlyOwner {
        paused = true;
        emit Paused();
    }

    function unpause() external onlyOwner {
        paused = false;
        emit Unpaused();
    }

    function setMinInterval(uint256 newInterval) external onlyOwner {
        uint256 oldInterval = minInterval;
        minInterval = newInterval;
        emit CooldownUpdated(oldInterval, newInterval);
    }

    function addProvider(address provider) external onlyOwner {
        providers[provider] = true;
        emit ProviderAdded(provider);
    }

    function removeProvider(address provider) external onlyOwner {
        providers[provider] = false;
        emit ProviderRemoved(provider);
    }

    function openBatch(uint256 maxContributions) external onlyOwner {
        _openNewBatch(maxContributions);
    }

    function closeBatch(uint256 batchId) external onlyOwner {
        if (batchId != currentBatchId) revert InvalidState();
        batches[batchId].isOpen = false;
        emit BatchClosed(batchId);
    }

    function contributeToAsset(
        uint256 batchId,
        euint32 encryptedShare
    ) external onlyProvider whenNotPaused checkCooldown {
        lastActionAt[msg.sender] = block.timestamp;
        Batch storage batch = batches[batchId];
        if (!batch.isOpen) revert BatchClosed();
        if (batch.numContributions >= batch.maxContributions) revert BatchFull();

        uint256 contributionId = batch.numContributions;
        batch.contributions[contributionId].encryptedShare = encryptedShare;
        batch.contributions[contributionId].initialized = true;

        batch.encryptedTotalShares = _initIfNeeded(batch.encryptedTotalShares);
        batch.encryptedTotalShares = FHE.add(
            batch.encryptedTotalShares,
            encryptedShare
        );
        batch.numContributions++;

        emit AssetContributionSubmitted(
            msg.sender,
            batchId,
            FHE.toBytes32(encryptedShare)
        );
    }

    function requestBatchDecryption(uint256 batchId) external onlyOwner whenNotPaused {
        Batch storage batch = batches[batchId];
        if (batch.numContributions == 0) revert InvalidState();

        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(batch.encryptedTotalShares);

        bytes32 stateHash = _hashCiphertexts(cts);
        uint256 requestId = FHE.requestDecryption(cts, this.handleBatchDecryption.selector);

        decryptionContexts[requestId] = DecryptionContext({
        batchId: batchId,
        modelVersion: modelVersion,
        stateHash: stateHash,
        processed: false
        });

        emit DecryptionRequested(requestId, batchId);
    }

    function handleBatchDecryption(
        uint256 requestId,
        bytes memory cleartexts,
        bytes memory proof
    ) public {
        if (decryptionContexts[requestId].processed) revert ReplayAttempt();

        DecryptionContext storage context = decryptionContexts[requestId];
        Batch storage batch = batches[context.batchId];

        // Rebuild cts from current storage in the same order
        bytes32[] memory cts = new bytes32[](1);
        cts[0] = FHE.toBytes32(batch.encryptedTotalShares);
        bytes32 currHash = _hashCiphertexts(cts);

        // Verify state consistency
        if (currHash != context.stateHash) revert InvalidState();

        // Verify proof
        try FHE.checkSignatures(requestId, cleartexts, proof) {
            // Decode cleartexts in the same order
            uint32 totalShares = abi.decode(cleartexts, (uint32));

            // Mark as processed and emit event
            context.processed = true;
            emit DecryptionCompleted(requestId, context.batchId, totalShares);
        } catch {
            revert InvalidProof();
        }
    }
}