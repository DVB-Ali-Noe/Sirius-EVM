import "server-only";
import { attestedRunnerFetch } from "@/lib/tee/ra-tls-client";
import { runnerEndpoint } from "@/lib/runner/config";
import { parseRunnerRaTlsEvidence } from "@/lib/tee/ra-tls-evidence";
import { FixedWindowRateLimiter } from "@/lib/http/rate-limit";
import type { RunnerRaTlsEvidence } from "@/lib/tee/types";

/** Partagé par la page et l'API brute : chaque lecture ouvre ou réutilise le transport attesté. */
export const attestationLimiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 6, maxGlobal: 60 });

export interface DemoAttestation {
  checkedAt: string;
  evidence: RunnerRaTlsEvidence;
}

/**
 * Preuve du runner de démonstration, lue par le transport RA-TLS. Ce transport ne s'ouvre
 * qu'après vérification complète (quote Intel et TCB, certificat lié à la quote, MRTD et
 * hash Compose épinglés, rejeu de l'event log, clés KMS/ingestion, compte de règlement) ;
 * une réponse ici vaut donc toutes ces vérifications, renouvelées au plus toutes les 5 min.
 * `null` si la démonstration n'est pas configurée ou si le runner est éteint ou refusé.
 */
export async function readDemoAttestation(): Promise<DemoAttestation | null> {
  try {
    if (process.env.SIRIUS_PHALA_DEMO !== "true") return null;
    const endpoint = runnerEndpoint();
    if (!endpoint?.startsWith("https:")) return null;
    const response = await attestedRunnerFetch(new URL("/ra-tls", endpoint), { method: "GET", timeoutMs: 10_000 });
    if (!response.ok) return null;
    const evidence = parseRunnerRaTlsEvidence(Buffer.from(await response.arrayBuffer()));
    return { checkedAt: new Date().toISOString(), evidence };
  } catch {
    return null;
  }
}
