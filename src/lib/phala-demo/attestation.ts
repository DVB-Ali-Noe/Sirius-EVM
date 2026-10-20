import "server-only";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Quote } from "@phala/dcap-qvl";
import { attestedRunnerFetch, runnerAttestedAt } from "@/lib/tee/ra-tls-client";
import { runnerEndpoint } from "@/lib/runner/config";
import { parseRunnerRaTlsEvidence } from "@/lib/tee/ra-tls-evidence";
import { FixedWindowRateLimiter } from "@/lib/http/rate-limit";
import type { RunnerRaTlsEvidence } from "@/lib/tee/types";

/** Partagé par la page et l'API brute : chaque lecture ouvre ou réutilise le transport attesté. */
export const attestationLimiter = new FixedWindowRateLimiter({ windowMs: 60_000, maxPerKey: 6, maxGlobal: 60 });

const SHA256_HEX = /^[0-9a-f]{64}$/;
const RUNNER_IMAGE = /^ghcr\.io\/dvb-ali-noe\/sirius-runner@sha256:[0-9a-f]{64}$/;

/**
 * `app-compose.json` bruts, octet pour octet, nommés par leur SHA-256 : `<composeHash>.json`.
 * Source unique : `tcb_info.app_compose` de `phala cvms attestation --json`, CVM allumée. La
 * version normalisée de `phala cvms get` n'a pas le hash attesté.
 */
export const PUBLISHED_COMPOSES_DIR = join(process.cwd(), "src/lib/phala-demo/composes");

/**
 * Image et commit déclarés par la pipeline (tag `sirius-runner:staging-<commit>`) pour chaque
 * hash Compose déployé. Déclaration, pas preuve : dépôt et registre sont privés.
 */
export const DECLARED_RELEASES: Readonly<Record<string, { image: string; commit: string }>> = {
  "61581af7bf9dd54ca96e1ea829a432849ee29f89a5901acd8d3fbea3d652950a": {
    image: "ghcr.io/dvb-ali-noe/sirius-runner@sha256:78839668bde182636fec6bce77f170f315ad8295fb7d8e6c8d595a955f76eff4",
    commit: "712fbb2",
  },
  "0c3f6f87f8d972acc1abb173fe8a8b521e4773dc360afb58bfb4406804f1dcd6": {
    image: "ghcr.io/dvb-ali-noe/sirius-runner@sha256:5a63e9dd15f52cfcd00efdd1326be161f3ebdc5f1aac7b96f291555fa46e1c06",
    commit: "fdeb29f",
  },
  "2fdc091929e9080f3dba0730404858fe0fb9aa7e26c60c61c97d58b887b323d3": {
    image: "ghcr.io/dvb-ali-noe/sirius-runner@sha256:76fb0001f0a5142ad63ed23ea04823b6e627038484129e3bb1227ac57ee4c914",
    commit: "c408221",
  },
};

/**
 * - `proven` : un `app-compose.json` publié a pour SHA-256 le hash attesté ; l'image du service
 *   `runner` en est lue. Le commit n'est repris de la table que pour cette même image.
 * - `declared` : seule la table connaît ce hash.
 * - `unlisted` : version inconnue ; aucune image ni commit, qui pourraient être d'une autre version.
 */
export type CodeRelease =
  | { status: "proven"; image: string; commit: string | null; appCompose: string }
  | { status: "declared"; image: string; commit: string }
  | { status: "unlisted" };

/** Image du service `runner` du `docker_compose_file` (Compose JSON rendu par `render-phala-v7`). */
export function runnerImageFromAppCompose(bytes: Buffer): string | null {
  try {
    const app = JSON.parse(bytes.toString("utf8")) as { docker_compose_file?: unknown } | null;
    if (typeof app?.docker_compose_file !== "string") return null;
    const compose = JSON.parse(app.docker_compose_file) as { services?: { runner?: { image?: unknown } } } | null;
    const image = compose?.services?.runner?.image;
    return typeof image === "string" && RUNNER_IMAGE.test(image) ? image : null;
  } catch {
    return null;
  }
}

async function publishedCompose(dir: string, hash: string): Promise<Buffer | null> {
  try {
    return await readFile(join(dir, `${hash}.json`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function resolveCodeRelease(
  composeHash: string,
  dir: string = PUBLISHED_COMPOSES_DIR,
  declared: Readonly<Record<string, { image: string; commit: string }>> = DECLARED_RELEASES,
): Promise<CodeRelease> {
  const hash = composeHash.toLowerCase();
  if (!SHA256_HEX.test(hash)) return { status: "unlisted" };
  const entry = Object.hasOwn(declared, hash) ? declared[hash] : undefined;
  const bytes = await publishedCompose(dir, hash);
  const image = bytes && createHash("sha256").update(bytes).digest("hex") === hash ? runnerImageFromAppCompose(bytes) : null;
  if (bytes && image) {
    return { status: "proven", image, commit: entry?.image === image ? entry.commit : null, appCompose: bytes.toString("utf8") };
  }
  return entry ? { status: "declared", ...entry } : { status: "unlisted" };
}

export interface DemoAttestation {
  /** Heure de la vérification complète (quote Intel, mesures, clés) dont dépend cette lecture. */
  checkedAt: string;
  evidence: RunnerRaTlsEvidence;
  /** MRTD lu dans la quote signée (égal à la valeur épinglée, sans quoi le transport est refusé). */
  mrTd: string;
  release: CodeRelease;
}

/**
 * Preuve du runner de démonstration, lue par le transport RA-TLS. Ce transport ne s'ouvre
 * qu'après vérification complète (quote Intel et TCB UpToDate, certificat lié à la quote, MRTD
 * et hash Compose épinglés, rejeu de l'event log, clés KMS/ingestion, compte de règlement) ;
 * une réponse ici vaut donc toutes ces vérifications, faites il y a au plus 5 minutes.
 * `null` si la démonstration n'est pas configurée, si le runner est éteint ou si sa preuve est refusée.
 */
export async function readDemoAttestation(): Promise<DemoAttestation | null> {
  try {
    if (process.env.SIRIUS_PHALA_DEMO !== "true") return null;
    const endpoint = runnerEndpoint();
    if (!endpoint?.startsWith("https:")) return null;
    const url = new URL("/ra-tls", endpoint);
    const response = await attestedRunnerFetch(url, { method: "GET", timeoutMs: 10_000 });
    const attestedAt = runnerAttestedAt(url);
    if (!response.ok || attestedAt === null) return null;
    const evidence = parseRunnerRaTlsEvidence(Buffer.from(await response.arrayBuffer()));
    const report = Quote.parse(Buffer.from(evidence.quote, "hex")).report;
    const td = report.asTd10() ?? report.asTd15()?.base;
    if (!td) return null;
    const release = await resolveCodeRelease(evidence.composeHash);
    return { checkedAt: new Date(attestedAt).toISOString(), evidence, mrTd: Buffer.from(td.mrTd).toString("hex"), release };
  } catch {
    return null;
  }
}
