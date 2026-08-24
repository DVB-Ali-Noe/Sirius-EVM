// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {SiriusEscrow} from "../SiriusEscrow.sol";

/// @notice Payee contract that refuses every incoming transfer.
/// @dev The canonical grief on EVM, and the risk that does not exist on XRPL where a Payment
///      to a Destination cannot fail. Used to prove that a provider like this can neither
///      block the publication of the preimage nor strand the protocol.
contract RevertingPayee {
    error Nope();

    receive() external payable {
        revert Nope();
    }
}

/// @notice Payee that burns all forwarded gas instead of reverting cleanly.
/// @dev Distinct failure mode from {RevertingPayee}: proves the outcome does not depend on
///      *how* the payee fails.
contract GasBurningPayee {
    receive() external payable {
        // solhint-disable-next-line no-empty-blocks
        while (true) {}
    }
}

/// @notice Payee that accepts ETH but only after enough gas, used to check normal contracts pass.
contract StoringPayee {
    uint256 public received;

    receive() external payable {
        received += msg.value;
    }
}

/// @notice Payee that re-enters the escrow during its payout.
/// @dev Targets the only external call in the contract (`withdrawFor`) to prove the guard
///      holds and that credit cannot be drained twice.
contract ReentrantPayee {
    SiriusEscrow public immutable escrow;
    bool public attempted;
    bool public reentryReverted;

    constructor(SiriusEscrow escrow_) {
        escrow = escrow_;
    }

    receive() external payable {
        if (attempted) return;
        attempted = true;
        try escrow.withdrawFor(address(this)) returns (uint256) {
            reentryReverted = false;
        } catch {
            reentryReverted = true;
        }
    }
}

/// @notice Attacker that tries to re-enter `release` from a payout.
/// @dev `release` makes no external call, so this can never actually fire — the test asserts
///      that property rather than assuming it.
contract ReleaseReentrantPayee {
    SiriusEscrow public immutable escrow;
    bytes32 public loanKey;
    bytes32 public preimage;
    bool public attempted;

    constructor(SiriusEscrow escrow_) {
        escrow = escrow_;
    }

    function arm(bytes32 loanKey_, bytes32 preimage_) external {
        loanKey = loanKey_;
        preimage = preimage_;
    }

    receive() external payable {
        if (attempted) return;
        attempted = true;
        try escrow.release(loanKey, preimage) {} catch {}
    }
}
