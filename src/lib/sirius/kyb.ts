import "server-only";
import { decode, hashes, type CredentialAccept } from "xrpl";
import { prisma } from "@/lib/db";
import { AppError } from "@/lib/errors";
import {
  assertKybAcceptScope,
  buildKybAccept,
  issueKyb,
  KYB_CREDENTIAL_TYPE,
  kybCredentialState,
  submitSignedKybAccept,
} from "@/lib/xrpl/credentials";
import { getClient } from "@/lib/xrpl/client";
import { resolveServerNetwork } from "@/lib/xrpl/networks";
import { getServerWallet } from "@/lib/xrpl/server-wallets";
import { reconcileTransaction } from "@/lib/xrpl/tx";
import { siriusVerifierAddress } from "@/lib/xrpl/verifier";

async function persistAccepted(subject: string, issuer: string, txHash?: string) {
  return prisma.credential.upsert({
    where: { subject_credType: { subject, credType: KYB_CREDENTIAL_TYPE } },
    create: {
      subject,
      credType: KYB_CREDENTIAL_TYPE,
      issuer,
      status: "ACCEPTED",
      txHash,
      acceptedAt: new Date(),
    },
    update: {
      issuer,
      status: "ACCEPTED",
      txHash,
      acceptTxBlob: null,
      acceptLastLedger: null,
      acceptedAt: new Date(),
    },
  });
}

async function ensurePendingCredential(subject: string, issuer: string): Promise<"pending" | "accepted"> {
  let state = await kybCredentialState(subject, issuer);
  if (state === "accepted") {
    await persistAccepted(subject, issuer);
    return state;
  }
  if (state === "absent") {
    if (process.env.NODE_ENV === "production" || resolveServerNetwork().network === "mainnet") {
      throw new AppError("Credential KYB non émis par le vérificateur", 403);
    }
    const verifier = getServerWallet("verifier");
    if (verifier.address !== issuer) {
      throw new AppError("Le vérificateur de développement ne correspond pas à l’issuer KYB", 503);
    }
    try {
      await issueKyb(verifier, subject);
    } catch (error) {
      state = await kybCredentialState(subject, issuer);
      if (state === "absent") throw error;
    }
    state = await kybCredentialState(subject, issuer);
    if (state === "absent") throw new AppError("Émission KYB non confirmée", 503);
    if (state === "accepted") {
      await persistAccepted(subject, issuer);
      return state;
    }
  }

  await prisma.credential.upsert({
    where: { subject_credType: { subject, credType: KYB_CREDENTIAL_TYPE } },
    create: { subject, credType: KYB_CREDENTIAL_TYPE, issuer, status: "PENDING" },
    update: { issuer, status: "PENDING", acceptedAt: null },
  });
  return "pending";
}

export async function prepareKybAcceptance(subject: string) {
  const issuer = siriusVerifierAddress();
  const state = await ensurePendingCredential(subject, issuer);
  if (state === "accepted") return { subject, status: "ACCEPTED" as const, transaction: null };

  const credential = await prisma.credential.findUniqueOrThrow({
    where: { subject_credType: { subject, credType: KYB_CREDENTIAL_TYPE } },
  });
  if (credential.acceptTxBlob) {
    const accepted = await finalizeKybAcceptance(subject);
    return { ...accepted, transaction: null };
  }

  return {
    subject,
    status: "PENDING" as const,
    transaction: await buildKybAccept(subject, issuer),
  };
}

export async function finalizeKybAcceptance(subject: string, submittedBlob?: string) {
  const issuer = siriusVerifierAddress();
  const state = await ensurePendingCredential(subject, issuer);
  if (state === "accepted") return { subject, status: "ACCEPTED" as const };

  const credential = await prisma.credential.findUniqueOrThrow({
    where: { subject_credType: { subject, credType: KYB_CREDENTIAL_TYPE } },
  });
  const txBlob = submittedBlob ?? credential.acceptTxBlob;
  if (!txBlob) throw new AppError("Transaction CredentialAccept signée manquante", 400);
  if (credential.acceptTxBlob && submittedBlob && credential.acceptTxBlob !== submittedBlob) {
    throw new AppError("Une autre acceptation KYB est déjà en réconciliation", 409);
  }

  let transaction: CredentialAccept;
  try {
    transaction = decode(txBlob) as CredentialAccept;
  } catch {
    throw new AppError("Transaction CredentialAccept signée illisible", 400);
  }
  assertKybAcceptScope(transaction, subject, issuer);
  const txHash = hashes.hashSignedTx(txBlob);
  const lastLedgerSequence = transaction.LastLedgerSequence as number;

  if (!credential.acceptTxBlob) {
    const claim = await prisma.credential.updateMany({
      where: { id: credential.id, status: "PENDING", acceptTxBlob: null },
      data: { txHash, acceptTxBlob: txBlob, acceptLastLedger: lastLedgerSequence },
    });
    if (claim.count !== 1) {
      throw new AppError("Une autre acceptation KYB est déjà en réconciliation", 409);
    }
  } else if (
    credential.txHash !== txHash ||
    credential.acceptLastLedger !== lastLedgerSequence
  ) {
    throw new AppError("État local CredentialAccept incohérent", 409);
  }

  try {
    await submitSignedKybAccept(txBlob);
  } catch {
    const reconciliation = await reconcileTransaction(
      await getClient(),
      txHash,
      lastLedgerSequence,
    );
    if (reconciliation === "pending") {
      throw new AppError("CredentialAccept soumis, confirmation XRPL en attente", 503);
    }
    if (reconciliation === "failed") {
      if ((await kybCredentialState(subject, issuer)) !== "accepted") {
        await prisma.credential.updateMany({
          where: { id: credential.id, status: "PENDING", txHash },
          data: { txHash: null, acceptTxBlob: null, acceptLastLedger: null },
        });
        throw new AppError("CredentialAccept rejeté ou expiré — recommence", 409);
      }
    }
  }

  if ((await kybCredentialState(subject, issuer)) !== "accepted") {
    throw new AppError("CredentialAccept confirmé mais credential KYB absent", 502);
  }
  await persistAccepted(subject, issuer, txHash);
  return { subject, status: "ACCEPTED" as const, txHash };
}
