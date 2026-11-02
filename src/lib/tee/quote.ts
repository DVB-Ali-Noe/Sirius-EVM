import "server-only";
import { PHALA_PCCS_URL, Quote, getCollateral, verify, type Collateral } from "@phala/dcap-qvl";
import { isSimulator } from "./dstack";
import {
  matchesPinnedHash,
  SHA256_MEASUREMENT,
  SHA384_MEASUREMENT,
  verifyEventLogIdentity,
} from "./identity";
import type { TdxEvidence } from "./types";

const QUOTE_HEX = /^[0-9a-f]+$/i;
const PAYLOAD_HASH = /^[0-9a-f]{64}$/i;
const ACCEPTED_TCB_STATUSES = new Set(["UpToDate"]);
// Statuts d'une quote dont Intel a validé la signature mais dont le TCB a pu être déclassé
// depuis. Seul « Revoked » (ou un échec de signature) invalide une quote déjà acceptée.
const RECORDED_QUOTE_TCB_STATUSES = new Set([
  "UpToDate",
  "SWHardeningNeeded",
  "ConfigurationNeeded",
  "ConfigurationAndSWHardeningNeeded",
  "OutOfDate",
  "OutOfDateConfigurationNeeded",
]);

export function isAcceptedTcbStatus(status: string | undefined): boolean {
  return status !== undefined && ACCEPTED_TCB_STATUSES.has(status);
}

export interface QuoteVerification {
  reportDataMatches: boolean;
  hardwareVerified: boolean | null;
  baseImageMatches: boolean | null;
  eventLogMatches: boolean | null;
  composeHashMatches: boolean | null;
  /** RTMR3 de la quote authentifié par le rejeu de l'event-log (plus d'épinglage brut). */
  rtMr3Matches: boolean | null;
  /** OS dstack : RTMR0–2 (configuration virtuelle, noyau, initrd) et `os-image-hash` épinglés. */
  platformMatches: boolean | null;
  /** Application et clés : `app-id` épinglé et fournisseur de clés `kms`. */
  applicationMatches: boolean | null;
  codeIdentityMatches: boolean | null;
  measurements: TdxMeasurements;
  tcbStatus?: string;
  /**
   * Cause d'une vérification matérielle sans succès, pour le diagnostic seulement (journaux) :
   * collatérale Intel injoignable (réseau, PCCS lent) ou quote refusée par la vérification.
   */
  hardwareFailure?: HardwareFailure;
}

export type HardwareFailure = "collateral-unavailable" | "rejected";

export interface TdxMeasurements {
  mrTd: string;
  rtMr0: string;
  rtMr1: string;
  rtMr2: string;
  rtMr3: string;
  composeHash: string | null;
  appId: string | null;
  osImageHash: string | null;
}

const APP_ID = /^[0-9a-f]{40}$/i;

/** Une tentative de collatérale ne bloque jamais plus longtemps que ceci (audit ROB-11). */
export const COLLATERAL_TIMEOUT_MS = 8_000;
const COLLATERAL_ATTEMPTS = 2;
const COLLATERAL_RETRY_DELAY_MS = 250;

export interface HardwareVerifierIO {
  getCollateral(quote: Buffer): Promise<Collateral>;
  verify(quote: Buffer, collateral: Collateral, nowSecs: number): { status: string };
  now(): number;
  timeoutMs: number;
  retryDelayMs: number;
}

const defaultHardwareIO: HardwareVerifierIO = {
  getCollateral: (quote) => getCollateral(PHALA_PCCS_URL, quote),
  verify: (quote, collateral, nowSecs) => verify(quote, collateral, nowSecs),
  now: () => Date.now(),
  timeoutMs: COLLATERAL_TIMEOUT_MS,
  retryDelayMs: COLLATERAL_RETRY_DELAY_MS,
};

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Collatérale Intel hors délai")), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Vérification matérielle d'une quote TDX contre la collatérale Intel (PCCS Phala, comme
 * `getCollateralAndVerify` de dcap-qvl). `dcap-qvl` télécharge la collatérale par `fetch` sans délai
 * ni nouvel essai : un PCCS lent bloquait la requête jusqu'à l'arrêt de la fonction, et un échec
 * réseau passager devenait un « runner non authentifié » (audit ROB-11). Ici : délai borné par
 * tentative, un seul nouvel essai, et la cause distingue réseau et refus. L'appel réseau abandonné
 * ne peut pas être annulé (dcap-qvl ne prend pas de signal) ; il se termine en arrière-plan.
 */
export async function verifyQuoteHardware(
  rawQuote: Buffer,
  io: HardwareVerifierIO = defaultHardwareIO,
): Promise<{ status: string } | { failure: HardwareFailure }> {
  let collateral: Collateral | undefined;
  for (let attempt = 1; attempt <= COLLATERAL_ATTEMPTS && !collateral; attempt++) {
    try {
      collateral = await withTimeout(io.getCollateral(rawQuote), io.timeoutMs);
    } catch {
      if (attempt < COLLATERAL_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, io.retryDelayMs));
    }
  }
  if (!collateral) return { failure: "collateral-unavailable" };
  try {
    return { status: io.verify(rawQuote, collateral, Math.floor(io.now() / 1000)).status };
  } catch {
    return { failure: "rejected" };
  }
}

/**
 * Revérification d'une quote enregistrée à l'entraînement (règlement d'un prêt) : elle a
 * déjà été acceptée avec un TCB UpToDate avant d'être stockée. Une révision du TCB par
 * Intel postérieure à l'entraînement ne doit pas bloquer un règlement légitime (audit A-01).
 */
export function isRecordedQuoteHardwareValid(
  verification: Pick<QuoteVerification, "hardwareVerified" | "tcbStatus">,
): boolean {
  if (verification.hardwareVerified === true) return true;
  return verification.tcbStatus !== undefined && RECORDED_QUOTE_TCB_STATUSES.has(verification.tcbStatus);
}

interface TdReport {
  mrTd: Uint8Array;
  rtMr0: Uint8Array;
  rtMr1: Uint8Array;
  rtMr2: Uint8Array;
  rtMr3: Uint8Array;
  reportData: Uint8Array;
}

function parseTdReport(rawQuote: Buffer): TdReport {
  const report = Quote.parse(rawQuote).report;
  const td = report.asTd10() ?? report.asTd15()?.base;
  if (!td) throw new Error("Quote non-TDX : report introuvable");
  return td;
}

function allMatch(checks: Array<boolean | null>): boolean | null {
  if (checks.some((check) => check === false)) return false;
  return checks.every((check) => check === true) ? true : null;
}

/** Comme `matchesPinnedHash`, mais un événement absent (`null`) face à une valeur épinglée échoue. */
function matchesPinnedEvent(actual: string | null, expected: string | undefined, pattern: RegExp): boolean | null {
  if (!expected) return null;
  return actual === null ? false : matchesPinnedHash(actual, expected, pattern);
}

type CodeIdentity = Pick<
  QuoteVerification,
  "baseImageMatches" | "eventLogMatches" | "composeHashMatches" | "rtMr3Matches" | "platformMatches"
  | "applicationMatches" | "codeIdentityMatches"
> & Pick<TdxMeasurements, "appId" | "osImageHash">;

/**
 * Identité du code mesuré. RTMR3 change à chaque redémarrage de la CVM Phala alors que
 * MRTD et compose ne bougent pas : l'épingler brut bloquait le runner après chaque
 * redémarrage et rendait irréglables les prêts entraînés avant (audit A-01). RTMR3 est
 * désormais authentifié par le rejeu de l'event-log, et le compose qu'il porte (événement
 * unique, mesuré au démarrage) est comparé à la valeur épinglée. SIRIUS_EXPECTED_RTMR3
 * n'est plus lu.
 *
 * MRTD ne couvre que le firmware virtuel (#112) : l'OS dstack est lié par RTMR0–2 et
 * l'événement `os-image-hash`, l'application par `app-id`, et le fournisseur de clés doit être
 * le KMS (dont la chaîne est épinglée à part). Une valeur épinglée absente laisse l'identité
 * indéterminée (`null`), donc refusée.
 */
export function evaluateCodeIdentity(
  td: { mrTd: string; rtMr0: string; rtMr1: string; rtMr2: string; rtMr3: string },
  evidence: Pick<TdxEvidence, "eventLog" | "composeHash"> | undefined,
  env: Record<string, string | undefined> = process.env,
): CodeIdentity {
  const baseImageMatches = matchesPinnedHash(td.mrTd, env.SIRIUS_EXPECTED_MRTD, SHA384_MEASUREMENT);
  const rtmrs = [
    matchesPinnedHash(td.rtMr0, env.SIRIUS_EXPECTED_RTMR0, SHA384_MEASUREMENT),
    matchesPinnedHash(td.rtMr1, env.SIRIUS_EXPECTED_RTMR1, SHA384_MEASUREMENT),
    matchesPinnedHash(td.rtMr2, env.SIRIUS_EXPECTED_RTMR2, SHA384_MEASUREMENT),
  ];
  let eventLogMatches: boolean | null = null;
  let composeHashMatches: boolean | null = null;
  let rtMr3Matches: boolean | null = null;
  let platformMatches = allMatch([...rtmrs, null]);
  let applicationMatches: boolean | null = null;
  let appId: string | null = null;
  let osImageHash: string | null = null;
  if (evidence) {
    const identity = verifyEventLogIdentity(evidence.eventLog, td.rtMr3, evidence.composeHash);
    rtMr3Matches = identity.eventLogMatches;
    eventLogMatches = identity.eventLogMatches && identity.composeEventMatches;
    composeHashMatches = matchesPinnedHash(evidence.composeHash, env.SIRIUS_EXPECTED_COMPOSE_HASH, SHA256_MEASUREMENT);
    ({ appId, osImageHash } = identity);
    platformMatches = allMatch([...rtmrs, matchesPinnedEvent(osImageHash, env.SIRIUS_EXPECTED_OS_IMAGE_HASH, SHA256_MEASUREMENT)]);
    applicationMatches = allMatch([
      matchesPinnedEvent(appId, env.SIRIUS_EXPECTED_APP_ID, APP_ID),
      identity.keyProviderName === "kms",
    ]);
  }
  return {
    baseImageMatches,
    eventLogMatches,
    composeHashMatches,
    rtMr3Matches,
    platformMatches,
    applicationMatches,
    codeIdentityMatches: allMatch([baseImageMatches, eventLogMatches, composeHashMatches, platformMatches, applicationMatches]),
    appId,
    osImageHash,
  };
}

export async function verifyTdxQuote(
  quoteHex: string,
  expectedPayloadHash: string,
  evidence?: Pick<TdxEvidence, "eventLog" | "composeHash">,
  opts: { skipHardware?: boolean } = {},
): Promise<QuoteVerification> {
  if (!QUOTE_HEX.test(quoteHex) || quoteHex.length % 2 !== 0 || !PAYLOAD_HASH.test(expectedPayloadHash)) {
    throw new Error("Quote TDX ou payload hash invalide");
  }

  const rawQuote = Buffer.from(quoteHex, "hex");
  const expected = Buffer.from(expectedPayloadHash, "hex");
  const td = parseTdReport(rawQuote);
  const reportData = Buffer.from(td.reportData);
  const reportDataMatches =
    reportData.subarray(0, expected.length).equals(expected) &&
    reportData.subarray(expected.length).every((byte) => byte === 0);
  const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString("hex");
  const report = { mrTd: hex(td.mrTd), rtMr0: hex(td.rtMr0), rtMr1: hex(td.rtMr1), rtMr2: hex(td.rtMr2), rtMr3: hex(td.rtMr3) };
  const { appId, osImageHash, ...identity } = evaluateCodeIdentity(report, evidence);
  const measurements: TdxMeasurements = { ...report, composeHash: evidence?.composeHash ?? null, appId, osImageHash };

  if (opts.skipHardware ?? isSimulator()) {
    return { reportDataMatches, hardwareVerified: null, ...identity, measurements };
  }
  const verified = await verifyQuoteHardware(rawQuote);
  if ("failure" in verified) {
    return { reportDataMatches, hardwareVerified: false, ...identity, measurements, hardwareFailure: verified.failure };
  }
  return {
    reportDataMatches,
    hardwareVerified: isAcceptedTcbStatus(verified.status),
    ...identity,
    measurements,
    tcbStatus: verified.status,
  };
}
