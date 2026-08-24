// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title SiriusEscrow
/// @notice Single-registry hashlock escrow backing the Sirius confidential data-lending
///         protocol on Robinhood Chain (Arbitrum Nitro, chainId 4663 / 46630).
///
///         A borrower locks native ETH against a SHA-256 hashlock whose 32-byte preimage is
///         derived inside the TEE as `deriveKey(masterKey, "escrow:<borrower>:<loanId>")`.
///         `release` publishes that preimage and entitles the provider to the funds in the
///         same transaction. The borrower's browser holds a capsule that is locked under both
///         a local ECDH key and the preimage, so publishing the preimage is exactly what
///         unlocks the trained model — the XRPL `EscrowFinish` semantics, ported.
///
/// @dev INVARIANTS
///      I1  Atomicity. `release` writes the preimage and credits the provider in one
///          transaction, and makes **no external call at all**, so nothing can make it revert
///          after the point of no return. There is no code path that publishes the preimage
///          without entitling the provider, nor the reverse.
///      I2  Disjunction. `status` leaves `Locked` exactly once. Release and refund are
///          mutually exclusive by state, not by clock.
///      I3  Single use. A loan slot is never cleared, so a published preimage can never be
///          replayed against a new lock on the same key.
///      I4  Solvency. `lockedWei + owedWei <= address(this).balance`. The contract never reads
///          its own balance, so force-fed ETH is inert and cannot corrupt accounting.
///      I5  No admin. No owner, no pause, no upgrade, no fee, no external dependency. The
///          deployed bytecode is the entire trust model.
///
/// @dev ⚠ REQUIREMENT ON THE CALLER THAT THIS CONTRACT CANNOT ENFORCE.
///      The preimage must be derived with domain separation over the chain id **and** this
///      contract's address. Today the enclave derives it as
///      `deriveKey(masterKey, "escrow:<borrower>:<loanId>")` — no chain, no contract.
///      Because the same master key serves every deployment, the same `(borrower, loanId)`
///      pair yields the *same* preimage on testnet 46630 and on mainnet 4663.
///      That breaks the fair exchange: a borrower settles a throwaway loan on the cheap chain,
///      the preimage becomes public, and it opens the capsule of the expensive loan carrying
///      the same id on the other chain — after which they let that one expire and take the
///      refund. The provider delivered and is never paid.
///      Binding the *hashlock* to the chain would not help: the capsule is locked by the
///      preimage itself, not by its digest. The separation has to happen inside the enclave's
///      key derivation, which is why it is stated here rather than implemented here.
///
/// @dev WHY `release` HAS NO DEADLINE CHECK — this is the subtle part.
///      A natural design gates `release` on `block.timestamp < deadline`. That is a real
///      vulnerability here, and it lives off-chain. A late `release` reverts, but the
///      transaction is still included in a block and its **calldata stays publicly readable
///      forever** via `eth_getTransactionByHash` — no tracing required. The borrower would
///      read the preimage from that reverted transaction, unlock the model, then call
///      `refund` and take the money back. The provider delivered and is never paid.
///      A single sequencer with FCFS ordering and no fee-bump makes stalling into that
///      window easy to arrange.
///      So this contract uses classic HTLC semantics instead: `release` is accepted for as
///      long as the loan is still `Locked`, and it is the **execution** of `refund` that
///      closes the window. That restores I1, and it is the more honest rule for Sirius:
///      a valid preimage can only exist if the enclave actually produced the model, so
///      paying the provider is the correct outcome whenever one is presented.
contract SiriusEscrow {
    // ---------------------------------------------------------------------------------
    // Types
    // ---------------------------------------------------------------------------------

    /// @notice Lifecycle of a loan slot. `None` doubles as the "never used" marker.
    enum Status {
        None,
        Locked,
        Released,
        Refunded
    }

    /// @param provider    Paid on release. Fixed at lock time, never reassigned.
    /// @param amount      Locked wei. `uint96` caps a single loan at ~7.9e28 wei.
    /// @param borrower    Refunded on expiry. Always the `lock` caller.
    /// @param deadline    Unix seconds. Computed on-chain from `challengeDays`.
    /// @param status      See {Status}.
    /// @param hashlock    SHA-256 of the 32-byte TEE preimage. **Not** keccak256.
    /// @param preimage    Write-once, set by `release` only. Readable forever after.
    struct Loan {
        address provider; // 20 bytes ┐
        uint96 amount; //    12 bytes ┘ slot 0
        address borrower; // 20 bytes ┐
        uint40 deadline; //   5 bytes │
        Status status; //     1 byte  ┘ slot 1
        bytes32 hashlock; //            slot 2
        bytes32 preimage; //            slot 3, untouched until release
    }

    // ---------------------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------------------

    string public constant VERSION = "sirius-escrow-v1";

    /// @dev Domain separator so a loan key can never collide with another keccak256 usage.
    bytes32 public constant LOAN_KEY_DOMAIN = keccak256("sirius.escrow.loanKey.v1");

    /// @notice Challenge-period bounds, mirroring `Dataset.challengeDays` in the application.
    uint8 public constant MIN_CHALLENGE_DAYS = 1;
    uint8 public constant MAX_CHALLENGE_DAYS = 30;

    /// @dev Upper bound on a single loan, imposed by the `uint96` packing of `Loan.amount`.
    uint256 internal constant MAX_AMOUNT = type(uint96).max;

    /// @notice Smallest lockable amount, mirroring `MIN_PRICE_WEI` in the application.
    /// @dev Not a business rule — an anti-spam floor. `lock` is permissionless and every call
    ///      writes four storage slots and emits an event indexed by an attacker-chosen
    ///      `provider`. Without a floor, poisoning a provider's event stream and bloating
    ///      storage costs a wei apiece.
    uint256 public constant MIN_AMOUNT = 1e12;

    /// @dev SHA-256 of 32 zero bytes. Rejected as a hashlock: it is the value produced by a
    ///      caller who forgot to derive a preimage, and its preimage is public knowledge.
    bytes32 internal constant ZERO_PREIMAGE_HASH =
        0x66687aadf862bd776c8fc18b8e9f8e20089714856ee233b3902a591d0d5f2925;

    /// @dev Bytes of a failed payout's revert reason copied into the error. This chain exposes
    ///      no `debug_traceTransaction`, so without this a failed withdrawal is undiagnosable.
    uint256 internal constant MAX_REASON_BYTES = 256;

    // ---------------------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------------------

    mapping(bytes32 => Loan) private _loans;

    /// @notice Wei owed to an account. Settlement is pull-only: see {withdrawFor}.
    mapping(address => uint256) private _credit;

    /// @notice Sum of all `Locked` amounts. Half of invariant I4.
    uint256 public lockedWei;

    /// @notice Sum of all outstanding credit. Other half of invariant I4.
    uint256 public owedWei;

    /// @notice Monotonic counter stamped into every lifecycle event.
    /// @dev Without `debug_traceTransaction`, a numeric gap is the only way an indexer can
    ///      detect a log it never received or one that was reorganised away.
    uint64 public eventSeq;

    /// @dev Reentrancy sentinel. Packed beside `eventSeq`, so the guard is nearly free.
    uint8 private _guard;

    // ---------------------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------------------

    event LoanLocked(
        bytes32 indexed loanKey,
        address indexed borrower,
        address indexed provider,
        string loanId,
        uint256 amount,
        uint40 deadline,
        bytes32 hashlock,
        uint64 seq
    );

    event LoanReleased(
        bytes32 indexed loanKey,
        address indexed provider,
        address indexed caller,
        bytes32 preimage,
        uint256 amount,
        uint64 seq
    );

    /// @notice Second indexing axis on the preimage.
    /// @dev An indexer holding only the hashlock — the shape inherited from the XRPL
    ///      crypto-condition era — can find the loan without knowing its key.
    event PreimageRevealed(bytes32 indexed hashlock, bytes32 indexed loanKey, bytes32 preimage);

    event LoanRefunded(bytes32 indexed loanKey, address indexed borrower, uint256 amount, uint64 seq);

    event CreditAccrued(address indexed account, bytes32 indexed loanKey, uint256 amount, uint256 balance);

    event Withdrawn(address indexed account, uint256 amount);

    // ---------------------------------------------------------------------------------
    // Errors
    // ---------------------------------------------------------------------------------

    error Reentrancy();
    error Sha256Unavailable();
    error AmountTooSmall();
    error ZeroAmount();
    error AmountOverflow();
    error InvalidProvider();
    error SelfDealing();
    error InvalidHashlock();
    error InvalidChallengePeriod();
    error EmptyLoanId();
    error LoanExists(bytes32 loanKey);
    error LoanNotLocked(bytes32 loanKey, Status status);
    error ChallengePeriodActive(uint40 deadline, uint256 nowTs);
    error InvalidPreimage();
    error NothingToWithdraw();
    error TransferFailed(address to, uint256 amount, bytes reason);

    // ---------------------------------------------------------------------------------
    // Guard
    // ---------------------------------------------------------------------------------

    modifier nonReentrant() {
        if (_guard == 1) revert Reentrancy();
        _guard = 1;
        _;
        _guard = 0;
    }

    // ---------------------------------------------------------------------------------
    // Keys
    // ---------------------------------------------------------------------------------

    /// @notice Deterministic storage key of a loan.
    /// @dev Namespaced by borrower so no one can squat a slot another borrower will need,
    ///      and domain-separated so the digest cannot be confused with another hash usage.
    function loanKeyOf(address borrower, bytes32 loanIdHash) public pure returns (bytes32) {
        return keccak256(abi.encode(LOAN_KEY_DOMAIN, borrower, loanIdHash));
    }

    /// @notice Same key, from the raw application loan id (a cuid).
    function loanKeyOfId(address borrower, string calldata loanId) external pure returns (bytes32) {
        return loanKeyOf(borrower, keccak256(bytes(loanId)));
    }

    // ---------------------------------------------------------------------------------
    // Lock
    // ---------------------------------------------------------------------------------

    /// @notice Lock ETH for a loan. The caller is bound as the borrower.
    /// @dev `deadline` is derived on-chain from `challengeDays` rather than accepted as a
    ///      timestamp: the challenge period is the provider's term, so a borrower must not be
    ///      able to shorten it by crafting the value client-side. This is the on-chain
    ///      counterpart of the field-by-field check `finalizeLoan` performs on XRPL.
    ///
    ///      TWO THINGS THIS FUNCTION DELIBERATELY DOES NOT VERIFY, both closed off-chain:
    ///
    ///      `provider` is whatever the borrower passes. It is not checked against the actual
    ///      owner of the dataset, so a borrower could name a counterfactual CREATE2 address
    ///      they control, obtain the model, then deploy to it and take the funds back. The
    ///      runner is what closes this: it calls {matchesScope} with the provider taken from
    ///      the signed dataset receipt, and refuses to compute if they differ.
    ///
    ///      The loan key binds `msg.sender`, so locking through a shared caller — a router, a
    ///      relayer, Multicall3 — produces a key under *that* contract's address. The runner's
    ///      {matchesScope} check then fails, which is safe but breaks the flow: the borrower
    ///      must lock from the address Sirius knows as theirs.
    /// @param provider     Address entitled to the funds on release.
    /// @param hashlock     SHA-256 of the 32-byte TEE preimage.
    /// @param challengeDays Length of the challenge period, 1 to 30 days.
    /// @param loanId       Application loan id (cuid). Emitted so an indexer can rebuild state.
    /// @return loanKey     Key of the created loan, primary index of every event.
    function lock(address provider, bytes32 hashlock, uint8 challengeDays, string calldata loanId)
        external
        payable
        nonReentrant
        returns (bytes32 loanKey)
    {
        if (msg.value == 0) revert ZeroAmount();
        if (msg.value < MIN_AMOUNT) revert AmountTooSmall();
        if (msg.value > MAX_AMOUNT) revert AmountOverflow();
        if (provider == address(0)) revert InvalidProvider();
        if (provider == msg.sender) revert SelfDealing();
        if (hashlock == bytes32(0) || hashlock == ZERO_PREIMAGE_HASH) revert InvalidHashlock();
        if (challengeDays < MIN_CHALLENGE_DAYS || challengeDays > MAX_CHALLENGE_DAYS) {
            revert InvalidChallengePeriod();
        }
        bytes memory rawId = bytes(loanId);
        if (rawId.length == 0) revert EmptyLoanId();

        loanKey = loanKeyOf(msg.sender, keccak256(rawId));
        Loan storage loan = _loans[loanKey];
        if (loan.status != Status.None) revert LoanExists(loanKey);

        uint40 deadline = uint40(block.timestamp + uint256(challengeDays) * 1 days);

        loan.provider = provider;
        loan.amount = uint96(msg.value);
        loan.borrower = msg.sender;
        loan.deadline = deadline;
        loan.status = Status.Locked;
        loan.hashlock = hashlock;

        lockedWei += msg.value;

        emit LoanLocked(
            loanKey, msg.sender, provider, loanId, msg.value, deadline, hashlock, _nextSeq()
        );
    }

    // ---------------------------------------------------------------------------------
    // Release
    // ---------------------------------------------------------------------------------

    /// @notice Publish the preimage and entitle the provider to the funds, atomically.
    /// @dev Permissionless: the preimage *is* the capability. Binding a runner address would
    ///      add a permanent liveness dependency on one enclave-derived key without adding
    ///      safety, since the funds can only ever reach the provider recorded at lock time.
    ///      In practice the runner sends this transaction and pays the gas.
    ///
    ///      No deadline check — see the contract-level note. The window closes when `refund`
    ///      executes, not when the clock passes `deadline`.
    ///
    ///      Front-running is not a concern on this chain: there is no public mempool, ordering
    ///      is FCFS with `maxPriorityFeePerGas = 0` so no one can buy priority, and a
    ///      front-runner could only reproduce the exact same effects at their own expense.
    function release(bytes32 loanKey, bytes32 preimage) external nonReentrant {
        Loan storage loan = _loans[loanKey];
        if (loan.status != Status.Locked) revert LoanNotLocked(loanKey, loan.status);
        if (_sha256(preimage) != loan.hashlock) revert InvalidPreimage();

        address provider = loan.provider;
        uint256 amount = loan.amount;

        // Effects only. No interaction follows, so nothing can revert past this point.
        loan.status = Status.Released;
        loan.preimage = preimage;
        lockedWei -= amount;

        uint256 balance = _credit[provider] + amount;
        _credit[provider] = balance;
        owedWei += amount;

        emit LoanReleased(loanKey, provider, msg.sender, preimage, amount, _nextSeq());
        emit PreimageRevealed(loan.hashlock, loanKey, preimage);
        emit CreditAccrued(provider, loanKey, amount, balance);
    }

    // ---------------------------------------------------------------------------------
    // Refund
    // ---------------------------------------------------------------------------------

    /// @notice Return the funds to the borrower once the challenge period has elapsed.
    /// @dev Permissionless, so the borrower's exit never depends on Sirius' liveness, on the
    ///      runner, or on the borrower holding gas. The funds can only ever be credited to the
    ///      recorded borrower. Executing this is also what closes the release window.
    function refund(bytes32 loanKey) external nonReentrant {
        Loan storage loan = _loans[loanKey];
        if (loan.status != Status.Locked) revert LoanNotLocked(loanKey, loan.status);
        if (block.timestamp < loan.deadline) revert ChallengePeriodActive(loan.deadline, block.timestamp);

        address borrower = loan.borrower;
        uint256 amount = loan.amount;

        loan.status = Status.Refunded;
        lockedWei -= amount;

        uint256 balance = _credit[borrower] + amount;
        _credit[borrower] = balance;
        owedWei += amount;

        emit LoanRefunded(loanKey, borrower, amount, _nextSeq());
        emit CreditAccrued(borrower, loanKey, amount, balance);
    }

    // ---------------------------------------------------------------------------------
    // Withdrawal
    // ---------------------------------------------------------------------------------

    /// @notice Send an account its accrued credit. Callable by anyone, for anyone.
    /// @dev Deliberately not `msg.sender`-only. A provider that is a contract able to *receive*
    ///      ETH but unable to *send* a transaction — a vault, a multisig mid-rotation — would
    ///      otherwise never be able to claim, and there is no admin to rescue it. Since the
    ///      funds can only go to `account` itself, opening this adds no authorisation surface
    ///      and lets a relayer complete a payout for a payee holding no gas.
    function withdrawFor(address account) public nonReentrant returns (uint256 amount) {
        amount = _credit[account];
        if (amount == 0) revert NothingToWithdraw();

        _credit[account] = 0;
        owedWei -= amount;

        (bool ok, bytes memory reason) = account.call{value: amount}("");
        if (!ok) revert TransferFailed(account, amount, _bounded(reason));

        emit Withdrawn(account, amount);
    }

    /// @notice Convenience wrapper for the common case.
    function withdraw() external returns (uint256) {
        return withdrawFor(msg.sender);
    }

    // ---------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------

    function getLoan(bytes32 loanKey) external view returns (Loan memory) {
        return _loans[loanKey];
    }

    /// @notice The published preimage, if any.
    /// @dev Stored rather than left to logs on purpose. `debug_traceTransaction` is
    ///      unavailable on this chain while `eth_getProof` is, so storage is the only form of
    ///      the released secret that a borrower can prove independently — and it lets a
    ///      browser that kept nothing but its `loanId` reopen its capsule months later.
    ///      XRPL cannot offer this: it deletes the escrow object on finish, leaving the
    ///      fulfillment only in transaction history.
    function preimageOf(bytes32 loanKey) external view returns (bool revealed, bytes32 preimage) {
        Loan storage loan = _loans[loanKey];
        return (loan.status == Status.Released, loan.preimage);
    }

    function creditOf(address account) external view returns (uint256) {
        return _credit[account];
    }

    function isReleasable(bytes32 loanKey) external view returns (bool) {
        return _loans[loanKey].status == Status.Locked;
    }

    function isRefundable(bytes32 loanKey) external view returns (bool) {
        Loan storage loan = _loans[loanKey];
        return loan.status == Status.Locked && block.timestamp >= loan.deadline;
    }

    /// @notice Solvency and log-continuity in a single call.
    /// @dev `balance` should always be at least `locked + owed`; any excess is force-fed ETH,
    ///      which the accounting ignores. `seq` lets an indexer detect a missing log.
    function accounting() external view returns (uint256 locked, uint256 owed, uint256 balance, uint64 seq) {
        return (lockedWei, owedWei, address(this).balance, eventSeq);
    }

    /// @notice Verify a loan against the terms the runner holds, before it starts a job.
    /// @dev Replaces `assertLiveEscrow` + `assertEscrowCreateScope` from the XRPL rail, which
    ///      needed two RPC round-trips and a transaction-history scan. One `eth_call` here.
    /// @param minimumRemaining Seconds that must remain before expiry. The runner should pass
    ///        a margin comfortably above this chain's ~13 minute real finality.
    function matchesScope(
        bytes32 loanKey,
        address borrower,
        address provider,
        uint256 amount,
        bytes32 hashlock,
        uint256 minimumRemaining
    ) external view returns (bool) {
        Loan storage loan = _loans[loanKey];
        return loan.status == Status.Locked && loan.borrower == borrower && loan.provider == provider
            && uint256(loan.amount) == amount && loan.hashlock == hashlock
            && uint256(loan.deadline) > block.timestamp + minimumRemaining;
    }

    // ---------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------

    function _nextSeq() private returns (uint64 seq) {
        unchecked {
            seq = ++eventSeq;
        }
    }

    /// @dev SHA-256 of exactly 32 bytes, via the `0x02` precompile.
    ///      Matches `createHash("sha256").update(preimage)` in the enclave byte for byte.
    ///      The success check is not ceremony: a chain missing the precompile would make every
    ///      digest zero, and every hashlock would then open with any preimage.
    function _sha256(bytes32 input) private view returns (bytes32 digest) {
        bool ok;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, input)
            ok := staticcall(gas(), 0x02, ptr, 0x20, ptr, 0x20)
            digest := mload(ptr)
        }
        if (!ok) revert Sha256Unavailable();
    }

    /// @dev Truncate revert data so a hostile payee cannot bloat the error it triggers.
    function _bounded(bytes memory reason) private pure returns (bytes memory) {
        if (reason.length <= MAX_REASON_BYTES) return reason;
        bytes memory out = new bytes(MAX_REASON_BYTES);
        for (uint256 i = 0; i < MAX_REASON_BYTES; i++) {
            out[i] = reason[i];
        }
        return out;
    }
}
