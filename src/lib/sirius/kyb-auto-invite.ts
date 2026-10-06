import "server-only";
import type { Address } from "viem";
import { prisma } from "@/lib/db";
import { kybRegistryAddress } from "@/lib/evm/addresses";
import { siriuskybregistryAbi } from "@/lib/evm/abi/siriuskybregistry";
import { getPublicClient } from "@/lib/evm/client";
import { resolveServerNetwork } from "@/lib/evm/networks";
import { issueAutoInvitation, readAutoInviteConfig, type AutoInviteIssuances, type AutoInviteRegistry, type AutoInviteResult } from "@/lib/kyb/auto-invite";

/** Branchement de l'accès instantané sur la chaîne et la base ; la logique vit dans `@/lib/kyb/auto-invite`. */

function chainRegistry(): AutoInviteRegistry {
  const client = getPublicClient();
  const address = kybRegistryAddress();
  return {
    version: () => client.readContract({ address, abi: siriuskybregistryAbi, functionName: "VERSION" }),
    isVerifier: (verifier) => client.readContract({ address, abi: siriuskybregistryAbi, functionName: "isVerifier", args: [verifier] }),
    verifierEpoch: (verifier) => client.readContract({ address, abi: siriuskybregistryAbi, functionName: "verifierEpoch", args: [verifier] }),
    nonces: (subject) => client.readContract({ address, abi: siriuskybregistryAbi, functionName: "nonces", args: [subject] }),
    isKybValid: (subject) => client.readContract({ address, abi: siriuskybregistryAbi, functionName: "isKybValid", args: [subject] }),
    attestationOf: async (subject) => {
      const attestation = await client.readContract({ address, abi: siriuskybregistryAbi, functionName: "attestationOf", args: [subject] });
      return { expiresAt: Number(attestation.expiresAt) };
    },
  };
}

const databaseIssuances: AutoInviteIssuances = {
  record: async (subject, code, issuedAt, expiresAt) =>
    (await prisma.kybAutoInvite.create({ data: { subject, code, createdAt: issuedAt, expiresAt }, select: { id: true } })).id,
  latestForSubjectSince: (subject, since) =>
    prisma.kybAutoInvite.findFirst({ where: { subject, createdAt: { gt: since } }, orderBy: { createdAt: "desc" }, select: { code: true } }),
  countForSubjectSince: (subject, since) => prisma.kybAutoInvite.count({ where: { subject, createdAt: { gt: since } } }),
  countSince: (since) => prisma.kybAutoInvite.count({ where: { createdAt: { gt: since } } }),
  remove: async (id) => { await prisma.kybAutoInvite.deleteMany({ where: { id } }); },
};

/** Invitation pour le wallet de la session : l'adresse ne vient jamais de la requête. */
export function issueSessionAutoInvitation(subject: string): Promise<AutoInviteResult> {
  const { chain } = resolveServerNetwork();
  return issueAutoInvitation(subject, {
    config: readAutoInviteConfig(),
    registry: chainRegistry(),
    issuances: databaseIssuances,
    chainId: chain.id,
    registryAddress: kybRegistryAddress() as Address,
  });
}
