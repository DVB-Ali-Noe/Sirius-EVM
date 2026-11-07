// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SiriusKybRegistry} from "./SiriusKybRegistry.sol";

interface ISiriusDatasetEscrow {
    function activeLoansForDataset(bytes32 datasetId) external view returns (uint256);
}

/// @notice The previous registry (v5) whose titles the admin may copy over, never invent.
interface ISiriusPreviousDatasetRegistry {
    function VERSION() external view returns (string memory);
    function getDataset(bytes32 id) external view returns (SiriusDatasetRegistry.Dataset memory);
}

/// @title SiriusDatasetRegistry
/// @notice On-chain title of a dataset.
///
///         A provider mints a non-transferable title carrying the dataset's identity: its
///         CID hash, its Merkle root and its size. Deleting it — the crypto-shredding step,
///         where the decryption key is destroyed and the data becomes unrecoverable — leaves
///         a tombstone rather than erasing the record, because the audit trail is the point.
///
/// @dev A PURE REGISTRY, NOT AN ERC-721
///      A soulbound ERC-721 was the obvious candidate, but every one of its interfaces would
///      be a lie here: no `transferFrom`, no `approve`, no `setApprovalForAll`, and wallets
///      would still display the title as a tradable collectible. ERC-5192 exists precisely to
///      announce that the transfer half of the standard is disabled. Rather than ship a
///      standard whose main verb is forbidden, this is a registry that says what it is.
///
/// @dev DETERMINISTIC IDENTIFIER
///      `datasetIdOf` derives the on-chain id from the application's cuid, so the id is known
///      before the transaction is sent.
///
/// @dev ⚠ GDPR — WHAT MUST NEVER BE WRITTEN HERE
///      Events on this chain are permanent and end up posted as blobs on Ethereum L1. The
///      dataset *name* and *description* are therefore deliberately absent from this contract:
///      they are free-form fields a provider could fill with personal data, and no erasure
///      would ever be possible. Only the CID, the Merkle root and the size are recorded — all
///      three opaque digests of already-encrypted content. The CID itself stays off-chain.
///      The right to erasure remains served by crypto-shredding: destroying the per-dataset
///      key makes the data unrecoverable. It is never served by an on-chain operation, and the
///      product copy must keep saying so — the title's trace survives, by design.
///
/// @dev V6 — LARGE DATASETS AND MIGRATION WITHOUT LOSS
///      - The size ceiling is no longer a constant: the admin (a Safe) may set `maxSizeBytes`,
///        never above the engraved `MAX_SIZE_CEILING` (1 GiB). It only gates future mints.
///      - The admin may copy live titles from the previous registry, fixed at construction
///        (`previousRegistry`), so a redeployment no longer strands published datasets. A copy
///        keeps the original provider, digests, size, profile and mint time: the admin can
///        move titles, never create or alter one.
///      - A chunked upload's `cidHash` commits to its manifest, which commits to every stored
///        chunk (ciphertext root) and to the plaintext root: no extra field is needed.
contract SiriusDatasetRegistry {
    // ---------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------

    struct Dataset {
        address provider; // 20 bytes ┐
        uint40 mintedAt; //   5 bytes │
        uint40 destroyedAt; // 5 bytes ┘ slot 0 — zero while live
        uint64 sizeBytes; //            slot 1
        bytes32 merkleRoot; //          slot 2
        bytes32 cidHash; //             slot 3
        bytes32 trainingProfile; //     slot 4
    }

    // ---------------------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------------------

    string public constant VERSION = "sirius-dataset-v6";
    string public constant PREVIOUS_VERSION = "sirius-dataset-v5";

    bytes32 public constant DATASET_ID_DOMAIN = keccak256("sirius.dataset.id.v1");
    bytes32 public constant LINEAR_REGRESSION_V1_PROFILE =
        keccak256("sirius.training-profile.v1:linear_regression:1.0.0");
    bytes32 public constant LOGISTIC_REGRESSION_V1_PROFILE =
        keccak256("sirius.training-profile.v1:logistic_regression:1.0.0");

    /// @notice Initial size limit (16 MiB, the v5 ceiling), raised by the admin for large uploads.
    uint64 public constant INITIAL_MAX_SIZE_BYTES = 16 * 1024 * 1024;
    /// @notice Engraved ceiling of `maxSizeBytes`: 1 GiB, the application's chunked-upload limit.
    uint64 public constant MAX_SIZE_CEILING = 1024 * 1024 * 1024;
    /// @notice Largest batch accepted by `importTitles`, to stay well inside a block.
    uint256 public constant MAX_IMPORT_BATCH = 100;

    // ---------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------

    /// @notice KYB gate. Immutable: repointing it would silently redefine who may publish.
    SiriusKybRegistry public immutable kyb;
    address public immutable admin;
    ISiriusDatasetEscrow public escrow;
    /// @notice Registry whose titles may be imported. Zero for a first deployment.
    ISiriusPreviousDatasetRegistry public immutable previousRegistry;
    /// @notice Current size limit at mint, between 1 and `MAX_SIZE_CEILING`.
    uint64 public maxSizeBytes;

    mapping(bytes32 => Dataset) private _datasets;

    /// @notice Training profiles accepted at mint. Append-only, see `addTrainingProfile`.
    mapping(bytes32 => bool) private _supportedTrainingProfiles;

    /// @notice Number of live titles per provider, for cheap dashboard reads.
    mapping(address => uint256) public liveCount;

    // ---------------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------------

    event DatasetMinted(
        bytes32 indexed datasetId,
        address indexed provider,
        bytes32 cidHash,
        bytes32 merkleRoot,
        uint64 sizeBytes,
        bytes32 trainingProfile
    );

    /// @notice The title was tombstoned after crypto-shredding.
    event DatasetDestroyed(bytes32 indexed datasetId, address indexed provider, uint40 destroyedAt);
    event EscrowBound(address indexed escrow);
    event TrainingProfileAdded(bytes32 indexed profile);
    event MaxSizeChanged(uint64 previousMaxSizeBytes, uint64 maxSizeBytes);
    /// @notice A live title copied from `previousRegistry`, unchanged.
    event DatasetImported(
        bytes32 indexed datasetId,
        address indexed provider,
        bytes32 cidHash,
        bytes32 merkleRoot,
        uint64 sizeBytes,
        bytes32 trainingProfile,
        uint40 mintedAt
    );

    // ---------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------

    error KybRequired();
    error DatasetExists(bytes32 datasetId);
    error UnknownDataset(bytes32 datasetId);
    error NotProvider();
    error AlreadyDestroyed();
    error EmptyDatasetId();
    error InvalidCid();
    error InvalidMerkleRoot();
    error InvalidSize();
    error InvalidTrainingProfile();
    error ZeroAddress();
    error NotAdmin();
    error EscrowAlreadyBound();
    error DatasetInUse(bytes32 datasetId, uint256 activeLoans);
    error InvalidPreviousRegistry();
    error NoPreviousRegistry();
    error NotImportable(bytes32 datasetId);
    error InvalidBatch();

    // ---------------------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------------------

    /// @param previousRegistry_ The v5 registry to import titles from, or zero.
    constructor(SiriusKybRegistry kyb_, address admin_, ISiriusPreviousDatasetRegistry previousRegistry_) {
        if (address(kyb_) == address(0)) revert KybRequired();
        if (admin_ == address(0)) revert ZeroAddress();
        if (address(previousRegistry_) != address(0)) {
            if (address(previousRegistry_).code.length == 0
                || keccak256(bytes(previousRegistry_.VERSION())) != keccak256(bytes(PREVIOUS_VERSION))) {
                revert InvalidPreviousRegistry();
            }
        }
        kyb = kyb_;
        admin = admin_;
        previousRegistry = previousRegistry_;
        maxSizeBytes = INITIAL_MAX_SIZE_BYTES;
        emit MaxSizeChanged(0, INITIAL_MAX_SIZE_BYTES);
        _addTrainingProfile(LINEAR_REGRESSION_V1_PROFILE);
        _addTrainingProfile(LOGISTIC_REGRESSION_V1_PROFILE);
    }

    // ---------------------------------------------------------------------------------
    // Size limit
    // ---------------------------------------------------------------------------------

    /// @notice Set the size limit for future mints. Admin only, at most `MAX_SIZE_CEILING`.
    /// @dev Lowering it never affects existing titles: the size is only checked at mint.
    function setMaxSizeBytes(uint64 maxSizeBytes_) external {
        if (msg.sender != admin) revert NotAdmin();
        if (maxSizeBytes_ == 0 || maxSizeBytes_ > MAX_SIZE_CEILING) revert InvalidSize();
        emit MaxSizeChanged(maxSizeBytes, maxSizeBytes_);
        maxSizeBytes = maxSizeBytes_;
    }

    // ---------------------------------------------------------------------------------
    // Import
    // ---------------------------------------------------------------------------------

    /// @notice Copy live titles from `previousRegistry`. Admin only.
    /// @dev The ids are identical across registries (`datasetIdOf` is unchanged), so a provider's
    ///      existing title keeps its id. Each copy is checked against the source at call time:
    ///      it must exist there, be live, and not exist here yet. The training profile is copied
    ///      as is, even if this registry does not list it: support only gates new mints.
    ///      No KYB check: the title was gated when it was minted. Reverts as a whole on any
    ///      invalid id, so a batch is either fully applied or not at all.
    function importTitles(bytes32[] calldata ids) external {
        if (msg.sender != admin) revert NotAdmin();
        if (address(previousRegistry) == address(0)) revert NoPreviousRegistry();
        if (ids.length == 0 || ids.length > MAX_IMPORT_BATCH) revert InvalidBatch();
        for (uint256 i = 0; i < ids.length; i++) {
            bytes32 id = ids[i];
            Dataset memory source = previousRegistry.getDataset(id);
            if (source.provider == address(0) || source.destroyedAt != 0 || source.mintedAt == 0) revert NotImportable(id);
            Dataset storage dataset = _datasets[id];
            if (dataset.provider != address(0)) revert DatasetExists(id);

            dataset.provider = source.provider;
            dataset.mintedAt = source.mintedAt;
            dataset.sizeBytes = source.sizeBytes;
            dataset.merkleRoot = source.merkleRoot;
            dataset.cidHash = source.cidHash;
            dataset.trainingProfile = source.trainingProfile;
            unchecked {
                liveCount[source.provider] += 1;
            }
            emit DatasetImported(
                id, source.provider, source.cidHash, source.merkleRoot, source.sizeBytes, source.trainingProfile, source.mintedAt
            );
        }
    }

    function bindEscrow(ISiriusDatasetEscrow escrow_) external {
        if (msg.sender != admin) revert NotAdmin();
        if (address(escrow) != address(0)) revert EscrowAlreadyBound();
        if (address(escrow_) == address(0) || address(escrow_).code.length == 0) revert ZeroAddress();
        escrow = escrow_;
        emit EscrowBound(address(escrow_));
    }

    // ---------------------------------------------------------------------------------
    // Training profiles
    // ---------------------------------------------------------------------------------

    /// @notice Allow new titles to be minted under `profile`. Admin only, idempotent.
    /// @dev Append-only: there is no removal, so an existing title is never made unmintable
    ///      or unusable — `isLiveForProviderAndProfile` and `matchesScope` ignore support.
    ///      Adding a profile on-chain does not make it executable: the runner checks the
    ///      profile itself.
    function addTrainingProfile(bytes32 profile) external {
        if (msg.sender != admin) revert NotAdmin();
        if (profile == bytes32(0)) revert InvalidTrainingProfile();
        _addTrainingProfile(profile);
    }

    function _addTrainingProfile(bytes32 profile) private {
        if (_supportedTrainingProfiles[profile]) return;
        _supportedTrainingProfiles[profile] = true;
        emit TrainingProfileAdded(profile);
    }

    // ---------------------------------------------------------------------------------
    // Identity
    // ---------------------------------------------------------------------------------

    /// @notice Deterministic on-chain id of a dataset.
    /// @dev Namespaced by provider so two providers can never collide on the same cuid, and
    ///      so nobody can pre-empt an id another provider will need.
    function datasetIdOf(address provider, bytes32 datasetIdHash) public pure returns (bytes32) {
        return keccak256(abi.encode(DATASET_ID_DOMAIN, provider, datasetIdHash));
    }

    // ---------------------------------------------------------------------------------
    // Mint
    // ---------------------------------------------------------------------------------

    /// @notice Publish a dataset title. Requires a valid KYB — the gate is blocking.
    function mint(bytes32 datasetIdHash, bytes32 cidHash, bytes32 merkleRoot, uint64 sizeBytes, bytes32 trainingProfile)
        external
        returns (bytes32 id)
    {
        if (!kyb.isKybValid(msg.sender)) revert KybRequired();
        if (datasetIdHash == bytes32(0)) revert EmptyDatasetId();
        if (cidHash == bytes32(0)) revert InvalidCid();
        if (merkleRoot == bytes32(0)) revert InvalidMerkleRoot();
        if (sizeBytes == 0 || sizeBytes > maxSizeBytes) revert InvalidSize();
        if (!isSupportedTrainingProfile(trainingProfile)) revert InvalidTrainingProfile();

        id = datasetIdOf(msg.sender, datasetIdHash);
        Dataset storage dataset = _datasets[id];
        if (dataset.provider != address(0)) revert DatasetExists(id);

        dataset.provider = msg.sender;
        dataset.mintedAt = uint40(block.timestamp);
        dataset.sizeBytes = sizeBytes;
        dataset.merkleRoot = merkleRoot;
        dataset.cidHash = cidHash;
        dataset.trainingProfile = trainingProfile;

        unchecked {
            liveCount[msg.sender] += 1;
        }

        emit DatasetMinted(id, msg.sender, cidHash, merkleRoot, sizeBytes, trainingProfile);
    }

    // ---------------------------------------------------------------------------------
    // Destroy
    // ---------------------------------------------------------------------------------

    /// @notice Tombstone a title after crypto-shredding. Provider only.
    /// @dev No KYB check on the way out. A provider whose credential expired or was revoked
    ///      must still be able to destroy its own titles — tying erasure to a live credential
    ///      would turn a compliance lapse into an inability to comply.
    ///
    ///      The record is kept, not deleted. That is the audit feature the product already
    ///      promises: the data becomes unrecoverable, the trace remains.
    function destroy(bytes32 datasetIdHash) external returns (bytes32 id) {
        id = datasetIdOf(msg.sender, datasetIdHash);
        Dataset storage dataset = _datasets[id];
        if (dataset.provider == address(0)) revert UnknownDataset(id);
        if (dataset.provider != msg.sender) revert NotProvider();
        if (dataset.destroyedAt != 0) revert AlreadyDestroyed();
        uint256 activeLoans = address(escrow) == address(0) ? 0 : escrow.activeLoansForDataset(id);
        if (activeLoans != 0) revert DatasetInUse(id, activeLoans);

        dataset.destroyedAt = uint40(block.timestamp);
        unchecked {
            liveCount[msg.sender] -= 1;
        }

        emit DatasetDestroyed(id, msg.sender, dataset.destroyedAt);
    }

    // ---------------------------------------------------------------------------------
    // Reads
    // ---------------------------------------------------------------------------------

    function getDataset(bytes32 id) external view returns (Dataset memory) {
        return _datasets[id];
    }

    /// @notice True while the title exists and has not been tombstoned.
    function isLive(bytes32 id) external view returns (bool) {
        Dataset storage dataset = _datasets[id];
        return dataset.provider != address(0) && dataset.destroyedAt == 0;
    }

    function isLiveForProvider(bytes32 id, address provider) external view returns (bool) {
        Dataset storage dataset = _datasets[id];
        return dataset.provider == provider && dataset.destroyedAt == 0;
    }

    function isSupportedTrainingProfile(bytes32 trainingProfile) public view returns (bool) {
        return _supportedTrainingProfiles[trainingProfile];
    }

    function isLiveForProviderAndProfile(bytes32 id, address provider, bytes32 trainingProfile)
        external
        view
        returns (bool)
    {
        Dataset storage dataset = _datasets[id];
        return dataset.provider == provider && dataset.destroyedAt == 0 && dataset.trainingProfile == trainingProfile;
    }

    /// @notice Confirm a title matches what the runner holds, before it decrypts anything.
    /// @dev The counterpart of `matchesScope` on the escrow: one call, no history scan.
    function matchesScope(bytes32 id, address provider, bytes32 merkleRoot, bytes32 cidHash, bytes32 trainingProfile)
        external
        view
        returns (bool)
    {
        Dataset storage dataset = _datasets[id];
        return dataset.provider == provider && dataset.destroyedAt == 0
            && dataset.merkleRoot == merkleRoot && dataset.cidHash == cidHash
            && dataset.trainingProfile == trainingProfile;
    }
}
