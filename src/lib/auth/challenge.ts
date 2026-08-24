import "server-only";
import { randomBytes } from "node:crypto";
import { signToken, verifyToken } from "./hmac";
import { AppError } from "@/lib/errors";
import { prisma } from "@/lib/db";
import { buildDelegationMessage, parseDelegationMessage } from "@/lib/runner/authorization-contract";

const CTX = "sirius-auth-challenge";
const TTL_MS = 5 * 60 * 1000;
const DELEGATION_TTL_MS = 60 * 60 * 1000;
const MAX_ACTIVE_PER_ADDRESS = 5;
const MAX_ACTIVE_GLOBAL = 1_000;

interface ChallengePayload {
  a: string;
  o: string;
  k: string;
  net: string;
  diat: number;
  dexp: number;
  n: string;
  iat: number;
  exp: number;
}

/**
 * Challenge signé, associé à un nonce persistant consommé à la vérification.
 */
export async function createChallenge(
  address: string,
  origin: string,
  sessionPublicKey: string,
  network: string,
): Promise<{ challenge: string; delegationExpiresAt: number }> {
  const now = Date.now();
  const nonce = randomBytes(16).toString("hex");
  const delegationExpiresAt = now + DELEGATION_TTL_MS;
  await prisma.$transaction(async (tx) => {
    await tx.authChallenge.deleteMany({ where: { expiresAt: { lte: new Date(now) } } });
    const [forAddress, global] = await Promise.all([
      tx.authChallenge.count({ where: { address } }),
      tx.authChallenge.count(),
    ]);
    if (forAddress >= MAX_ACTIVE_PER_ADDRESS || global >= MAX_ACTIVE_GLOBAL) {
      throw new AppError("Trop de challenges actifs — réessaie plus tard", 429);
    }
    await tx.authChallenge.create({ data: { nonce, address, expiresAt: new Date(now + TTL_MS) } });
  });
  const token = signToken(
    {
      a: address,
      o: origin,
      k: sessionPublicKey,
      net: network,
      diat: now,
      dexp: delegationExpiresAt,
      n: nonce,
      iat: now,
      exp: now + TTL_MS,
    },
    CTX,
  );
  return {
    challenge: buildDelegationMessage({
      origin,
      address,
      sessionPublicKey,
      network,
      issuedAt: now,
      expiresAt: delegationExpiresAt,
      challengeToken: token,
    }),
    delegationExpiresAt,
  };
}

export async function verifyChallenge(challenge: string, address: string, origin: string): Promise<void> {
  const fields = parseDelegationMessage(challenge);
  if (!fields || fields.origin !== origin || fields.address !== address) throw new AppError("Challenge invalide", 401);
  const p = verifyToken<ChallengePayload>(fields.challengeToken, CTX);
  if (
    !p ||
    p.a !== address ||
    p.o !== origin ||
    p.k !== fields.sessionPublicKey ||
    p.net !== fields.network ||
    p.diat !== fields.issuedAt ||
    p.dexp !== fields.expiresAt
  ) {
    throw new AppError("Challenge invalide", 401);
  }
  if (Date.now() > p.exp) throw new AppError("Challenge expiré", 401);
  const consumed = await prisma.authChallenge.deleteMany({
    where: { nonce: p.n, address, expiresAt: { gt: new Date() } },
  });
  if (consumed.count !== 1) throw new AppError("Challenge invalide ou déjà utilisé", 401);
}
