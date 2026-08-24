import "server-only";
import { createWalletClient, http, parseAbiItem, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { AppError } from "@/lib/app-error";
import { deriveKey, getMasterKey } from "@/lib/crypto/encryption";
import { siriusescrowAbi } from "./abi/siriusescrow";
import { normalizeAddress, type CanonicalAddress } from "./address";
import { getPublicClient } from "./client";
import { resolveServerNetwork } from "./networks";

/**
 * Adaptateur du contrat SiriusEscrow. Remplace, à eux trois :
 *   `src/lib/xrpl/escrow.ts`, `src/lib/runner/xrpl-proof.ts` et la partie
 *   règlement de `src/lib/runner/settlement.ts`.
 *
 * La frontière exposée est volontairement identique à celle du rail XRPL
 * (`settleEscrow` → txHash, `reconcileLoanEscrow` → active|settled|cancelled),
 * pour que les orchestrateurs de `src/lib/sirius/` n'aient pas à changer de forme.
 *
 * Ce qui disparaît au passage : la pagination `account_tx` bornée à 20 pages, qui
 * levait un 503 « Historique XRPL trop volumineux » dès qu'un borrower devenait
 * actif. L'état d'un prêt se lit ici en un seul `eth_call`, sans historique.
 */

/** Marge minimale avant expiration pour qu'un calcul puisse démarrer. */
export const MIN_REMAINING_SECONDS = 30 * 60;

export type EscrowResolution =
  | { state: "active" }
  | { state: "settled"; txHash: string; preimage: Hex }
  | { state: "cancelled"; txHash: string };

const STATUS_LOCKED = 1;
const STATUS_RELEASED = 2;
const STATUS_REFUNDED = 3;

export interface OnChainLoan {
  provider: CanonicalAddress;
  borrower: CanonicalAddress;
  amountWei: string;
  deadline: number;
  status: number;
  hashlock: Hex;
  preimage: Hex;
}

function escrowAddress(): CanonicalAddress {
  const configured = process.env.NEXT_PUBLIC_SIRIUS_ESCROW_ADDRESS?.trim();
  if (!configured) throw new Error("NEXT_PUBLIC_SIRIUS_ESCROW_ADDRESS manquante");
  return normalizeAddress(configured, "adresse du contrat escrow");
}

// Les dérivations partagées avec le contrat vivent dans `loan-key.ts`, un module
// pur que la suite Hardhat importe pour croiser ces valeurs avec l'on-chain.
export { hashlockOf, loanKeyFor, LOAN_KEY_DOMAIN } from "./loan-key";

export async function readLoan(loanKey: Hex): Promise<OnChainLoan | null> {
  const loan = await getPublicClient().readContract({
    address: escrowAddress(),
    abi: siriusescrowAbi,
    functionName: "getLoan",
    args: [loanKey],
  });
  if (loan.status === 0) return null;
  return {
    provider: normalizeAddress(loan.provider),
    borrower: normalizeAddress(loan.borrower),
    amountWei: loan.amount.toString(),
    deadline: Number(loan.deadline),
    status: loan.status,
    hashlock: loan.hashlock,
    preimage: loan.preimage,
  };
}

/**
 * Contrôle de portée avant calcul. Remplace `assertLiveEscrow` +
 * `assertEscrowCreateScope`, qui exigeaient deux allers-retours RPC plus un scan
 * d'historique. Ici, un seul appel.
 */
export async function assertLoanScope(input: {
  loanKey: Hex;
  borrower: string;
  provider: string;
  amountWei: string;
  hashlock: Hex;
  minimumRemainingSeconds?: number;
}): Promise<void> {
  const ok = await getPublicClient().readContract({
    address: escrowAddress(),
    abi: siriusescrowAbi,
    functionName: "matchesScope",
    args: [
      input.loanKey,
      normalizeAddress(input.borrower),
      normalizeAddress(input.provider),
      BigInt(input.amountWei),
      input.hashlock,
      BigInt(input.minimumRemainingSeconds ?? MIN_REMAINING_SECONDS),
    ],
  });
  if (!ok) throw new AppError("Escrow on-chain inactif, hors scope ou trop proche de son expiration", 409);
}

/**
 * Compte de règlement du runner.
 *
 * La clé est **dérivée dans l'enclave** depuis la master key scellée, au lieu
 * d'être injectée par une variable d'environnement comme `XRPL_SETTLEMENT_SEED`.
 * Elle devient donc attestable : seule une enclave exécutant le code mesuré peut
 * la reconstituer, et l'opérateur ne la voit jamais.
 */
function settlementAccount() {
  const key = deriveKey(getMasterKey(), "settlement:evm:v1");
  return privateKeyToAccount(`0x${key.toString("hex")}`);
}

export function runnerSettlementAddress(): CanonicalAddress {
  return normalizeAddress(settlementAccount().address);
}

function walletClient() {
  const { chain, rpcUrl } = resolveServerNetwork();
  return createWalletClient({ account: settlementAccount(), chain, transport: http(rpcUrl) });
}

/**
 * Publie le préimage et crédite le provider. Équivalent d'`EscrowFinish`.
 *
 * Idempotent par relecture : si le prêt est déjà réglé — reprise après crash,
 * timeout réseau alors que la transaction avait été incluse — on ne resoumet pas,
 * on renvoie la résolution existante. Le contrat refuserait de toute façon, mais
 * échouer bruyamment sur une reprise légitime serait un faux négatif.
 */
export async function settleEscrow(loanKey: Hex, preimage: Hex): Promise<string> {
  const existing = await reconcileLoanEscrow(loanKey);
  if (existing.state === "settled") return existing.txHash;
  if (existing.state === "cancelled") throw new AppError("Escrow on-chain déjà remboursé", 410);

  const client = walletClient();
  const publicClient = getPublicClient();
  let txHash: Hex;
  try {
    const { request } = await publicClient.simulateContract({
      account: client.account,
      address: escrowAddress(),
      abi: siriusescrowAbi,
      functionName: "release",
      args: [loanKey, preimage],
    });
    txHash = await client.writeContract(request);
  } catch (error) {
    // Une resoumission concurrente a pu passer entre la relecture et l'envoi.
    const recovered = await reconcileLoanEscrow(loanKey).catch(() => ({ state: "active" }) as const);
    if (recovered.state === "settled") return recovered.txHash;
    if (recovered.state === "cancelled") throw new AppError("Escrow on-chain déjà remboursé", 410);
    console.error("[evm] release échouée", error);
    throw new AppError("Règlement on-chain du runner échoué", 502);
  }

  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
  if (receipt.status !== "success") throw new AppError("Règlement on-chain rejeté", 502);
  return receipt.transactionHash;
}

/** Rembourse le borrower après expiration. Équivalent d'`EscrowCancel`. */
export async function refundEscrow(loanKey: Hex): Promise<string> {
  const existing = await reconcileLoanEscrow(loanKey);
  if (existing.state === "cancelled") return existing.txHash;
  if (existing.state === "settled") throw new AppError("Escrow on-chain déjà réglé", 409);

  const client = walletClient();
  const publicClient = getPublicClient();
  const { request } = await publicClient.simulateContract({
    account: client.account,
    address: escrowAddress(),
    abi: siriusescrowAbi,
    functionName: "refund",
    args: [loanKey],
  });
  const txHash = await client.writeContract(request);
  const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, confirmations: 1 });
  if (receipt.status !== "success") throw new AppError("Remboursement on-chain rejeté", 502);
  return receipt.transactionHash;
}

/**
 * État d'un prêt on-chain, en une lecture. Remplace `findResolution`, qui paginait
 * `account_tx` sur tout l'historique du borrower avec un budget de 20 pages.
 *
 * Le hash de transaction est retrouvé par recherche du log correspondant ; l'état
 * lui-même vient du storage, donc une rétention de logs incomplète chez le
 * fournisseur RPC dégrade la traçabilité mais jamais la correction.
 */
export async function reconcileLoanEscrow(loanKey: Hex): Promise<EscrowResolution> {
  const loan = await readLoan(loanKey);
  if (!loan) throw new AppError("Prêt inconnu du contrat escrow", 409);
  if (loan.status === STATUS_LOCKED) return { state: "active" };

  const settled = loan.status === STATUS_RELEASED;
  if (!settled && loan.status !== STATUS_REFUNDED) {
    throw new AppError("État de prêt on-chain inattendu", 409);
  }

  const txHash = await findLifecycleTxHash(loanKey, settled ? "LoanReleased" : "LoanRefunded");
  return settled
    ? { state: "settled", txHash, preimage: loan.preimage }
    : { state: "cancelled", txHash };
}

// Signatures déclarées littéralement plutôt qu'extraites de l'ABI : viem ne peut
// typer `getLogs` que depuis une signature statiquement connue.
const RELEASED_EVENT = parseAbiItem(
  "event LoanReleased(bytes32 indexed loanKey, address indexed provider, address indexed caller, bytes32 preimage, uint256 amount, uint64 seq)",
);
const REFUNDED_EVENT = parseAbiItem(
  "event LoanRefunded(bytes32 indexed loanKey, address indexed borrower, uint256 amount, uint64 seq)",
);

async function findLifecycleTxHash(
  loanKey: Hex,
  eventName: "LoanReleased" | "LoanRefunded",
): Promise<string> {
  const client = getPublicClient();
  const address = escrowAddress();
  const logs =
    eventName === "LoanReleased"
      ? await client.getLogs({ address, event: RELEASED_EVENT, args: { loanKey }, fromBlock: "earliest" })
      : await client.getLogs({ address, event: REFUNDED_EVENT, args: { loanKey }, fromBlock: "earliest" });

  const last = logs.at(-1);
  if (!last?.transactionHash) {
    throw new AppError("Résolution on-chain confirmée mais transaction introuvable", 503);
  }
  return last.transactionHash;
}

/** Préimage publié, que le navigateur utilise pour ouvrir sa capsule. */
export async function publishedPreimage(loanKey: Hex): Promise<Hex> {
  const [revealed, preimage] = await getPublicClient().readContract({
    address: escrowAddress(),
    abi: siriusescrowAbi,
    functionName: "preimageOf",
    args: [loanKey],
  });
  if (!revealed) throw new AppError("Préimage pas encore publié", 409);
  return preimage;
}
