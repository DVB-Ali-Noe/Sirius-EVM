import "server-only";
import type { Hex } from "viem";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import { addressesEqual, normalizeAddress } from "@/lib/evm/address";
import { kybRegistryAddress } from "@/lib/evm/addresses";
import { siriuskybregistryAbi } from "@/lib/evm/abi/siriuskybregistry";
import { getPublicClient } from "@/lib/evm/client";

const KYB_CREDENTIAL_TYPE = "KYB";

async function persistAccepted(subject: string, txHash?: string) {
  const address = normalizeAddress(subject);
  const registry = kybRegistryAddress();
  const attestation = await getPublicClient().readContract({
    address: registry,
    abi: siriuskybregistryAbi,
    functionName: "attestationOf",
    args: [address],
  });
  return prisma.credential.upsert({
    where: { subject_credType: { subject: address, credType: KYB_CREDENTIAL_TYPE } },
    create: {
      subject: address,
      credType: KYB_CREDENTIAL_TYPE,
      issuer: normalizeAddress(attestation.verifier),
      status: "ACCEPTED",
      txHash,
      acceptedAt: new Date(),
      evmVerifier: normalizeAddress(attestation.verifier),
      evmExpiresAt: new Date(attestation.expiresAt * 1000),
      evmAttestationTxHash: txHash,
    },
    update: {
      issuer: normalizeAddress(attestation.verifier),
      status: "ACCEPTED",
      txHash,
      acceptedAt: new Date(),
      evmVerifier: normalizeAddress(attestation.verifier),
      evmExpiresAt: new Date(attestation.expiresAt * 1000),
      evmAttestationTxHash: txHash,
    },
  });
}

export async function prepareKybAcceptance(subject: string) {
  const address = normalizeAddress(subject);
  const registry = kybRegistryAddress();
  const publicClient = getPublicClient();
  const alreadyValid = await publicClient.readContract({
    address: registry,
    abi: siriuskybregistryAbi,
    functionName: "isKybValid",
    args: [address],
  });
  if (alreadyValid) {
    await persistAccepted(address);
    return { subject: address, status: "ACCEPTED" as const, transaction: null };
  }
  throw new AppError("KYB externe requis avant toute attestation on-chain", 503);
}

export async function finalizeKybAcceptance(subject: string, txHash?: string, transactionSender = subject) {
  const address = normalizeAddress(subject);
  const registry = kybRegistryAddress();
  const publicClient = getPublicClient();
  if (txHash) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) throw new AppError("Hash de transaction KYB invalide", 400);
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash as Hex, confirmations: 1 });
    if (receipt.status !== "success") throw new AppError("Transaction KYB rejetée", 409);
    const transaction = await publicClient.getTransaction({ hash: txHash as Hex });
    if (!addressesEqual(transaction.from, normalizeAddress(transactionSender)) || !addressesEqual(transaction.to ?? "", registry)) {
      throw new AppError("Transaction KYB non émise par le wallet connecté", 403);
    }
  }
  const valid = await publicClient.readContract({
    address: registry,
    abi: siriuskybregistryAbi,
    functionName: "isKybValid",
    args: [address],
  });
  if (!valid) throw new AppError("Attestation KYB EVM non confirmée", 409);
  await persistAccepted(address, txHash);
  return { subject: address, status: "ACCEPTED" as const, txHash };
}
