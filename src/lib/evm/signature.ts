import { hashMessage, recoverAddress, type Hex } from "viem";
import { AppError } from "@/lib/app-error";
import { addressesEqual, normalizeAddress, type CanonicalAddress } from "./address";

/**
 * Vérification des signatures de wallet EVM. Remplace `src/lib/auth/verify-signature.ts`.
 *
 * Ce que le portage supprime, et pourquoi c'est important :
 *
 * Sur XRPL, prouver la possession d'une adresse demandait **trois** éléments —
 * `address`, `publicKey` et `signature` — puis deux contrôles : que l'adresse dérive
 * bien de la clé publique (`deriveAddress`), puis que la signature couvre le message.
 * Le wallet devait donc exposer sa clé publique en plus de signer.
 *
 * C'est exactement là que le code actuel a un bug fonctionnel : `signMessageExternal`
 * n'exploite que `{ signature, publicKey }`, or seul Crossmark renvoie ce couple.
 * GemWallet et WalletConnect sont proposés dans l'interface mais ne peuvent pas
 * terminer l'authentification.
 *
 * En EVM, `ecrecover` **reconstruit l'adresse depuis la seule signature**. Il n'y a
 * plus de clé publique à transporter, plus de contrôle croisé à faire, et
 * `personal_sign` (EIP-191) est universel : tous les wallets le supportent.
 */

/** Signature EIP-191 : 65 octets (r‖s‖v) en hexadécimal. */
const SIGNATURE_PATTERN = /^0x[0-9a-fA-F]{130}$/;

export interface WalletSignatureInput {
  /** Adresse revendiquée par le client. */
  address: unknown;
  /** Signature `personal_sign` du message exact. */
  signature: unknown;
  /** Message signé, littéralement celui renvoyé par `/api/auth/challenge`. */
  message: string;
}

function assertSignatureShape(signature: unknown): Hex {
  if (typeof signature !== "string" || !SIGNATURE_PATTERN.test(signature)) {
    throw new AppError("Signature invalide", 401);
  }
  return signature as Hex;
}

/**
 * Récupère l'adresse signataire d'un message EIP-191.
 * Purement local : aucun appel réseau, donc utilisable depuis l'enclave TEE
 * sans lui ouvrir d'accès sortant.
 */
export async function recoverWalletAddress(message: string, signature: unknown): Promise<CanonicalAddress> {
  const hex = assertSignatureShape(signature);
  let recovered: string;
  try {
    recovered = await recoverAddress({ hash: hashMessage(message), signature: hex });
  } catch {
    throw new AppError("Signature invalide", 401);
  }
  return normalizeAddress(recovered);
}

/**
 * Prouve que `address` a signé `message`. Lève une 401 sinon.
 * Équivalent EOA de `verifyWalletSignature`, sans clé publique à fournir.
 */
export async function verifyWalletSignature({
  address,
  signature,
  message,
}: WalletSignatureInput): Promise<CanonicalAddress> {
  const claimed = normalizeAddress(address);
  const recovered = await recoverWalletAddress(message, signature);
  if (!addressesEqual(claimed, recovered)) throw new AppError("Signature invalide", 401);
  return claimed;
}

/**
 * Variante tolérante aux comptes contractuels (Safe, ZeroDev — mis en avant par
 * Robinhood Chain, dont les trois EntryPoints ERC-4337 sont déployés).
 *
 * ⚠ Frontière d'architecture : contrairement à `verifyWalletSignature`, celle-ci
 * exige un `eth_call` vers `isValidSignature`. Elle est donc **interdite dans le
 * runner TEE** : lui ouvrir un accès réseau sortant introduirait une nouvelle racine
 * de confiance et coupleraient la disponibilité de l'enclave au séquenceur, qui est
 * unique et centralisé. Réservée aux routes Next, jamais au chemin confidentiel.
 */
export async function verifyWalletSignatureAllowingContracts(
  input: WalletSignatureInput,
): Promise<CanonicalAddress> {
  const claimed = normalizeAddress(input.address);
  const hex = assertSignatureShape(input.signature);

  try {
    const recovered = await recoverWalletAddress(input.message, hex);
    if (addressesEqual(claimed, recovered)) return claimed;
  } catch {
    // Une signature de smart account n'est pas récupérable : on bascule sur ERC-1271.
  }

  const { getPublicClient } = await import("./client");
  let valid = false;
  try {
    valid = await getPublicClient().verifyMessage({
      address: claimed,
      message: input.message,
      signature: hex,
    });
  } catch {
    throw new AppError("Signature invalide", 401);
  }
  if (!valid) throw new AppError("Signature invalide", 401);
  return claimed;
}
