import { isZeroAddress, normalizeAddress } from "@/lib/evm/address";
import type { RunnerRaTlsEvidence } from "./types";

export function parseRunnerRaTlsEvidence(raw: Buffer): RunnerRaTlsEvidence {
  const evidence = JSON.parse(raw.toString("utf8")) as Partial<RunnerRaTlsEvidence> | null;
  if (!evidence || typeof evidence.quote !== "string" || typeof evidence.eventLog !== "string" ||
    typeof evidence.bootstrapOnly !== "boolean") throw new Error("Évidence RA-TLS invalide");
  for (const key of ["composeHash", "certificateSha256", "ingressKeySha256", "masterKeyChainSha256"] as const) {
    const value = evidence[key];
    if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) throw new Error("Empreinte RA-TLS invalide");
  }
  const settlementAddress = normalizeAddress(evidence.settlementAddress, "Compte de règlement");
  if (isZeroAddress(settlementAddress)) throw new Error("Compte de règlement nul");
  return { ...evidence, settlementAddress } as RunnerRaTlsEvidence;
}
