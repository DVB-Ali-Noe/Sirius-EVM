import "server-only";
import { Quote, getCollateralAndVerify } from "@phala/dcap-qvl";
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

export function isAcceptedTcbStatus(status: string | undefined): boolean {
  return status !== undefined && ACCEPTED_TCB_STATUSES.has(status);
}

export interface QuoteVerification {
  reportDataMatches: boolean;
  hardwareVerified: boolean | null;
  baseImageMatches: boolean | null;
  eventLogMatches: boolean | null;
  composeHashMatches: boolean | null;
  rtMr3Matches: boolean | null;
  codeIdentityMatches: boolean | null;
  measurements: { mrTd: string; rtMr3: string; composeHash: string | null };
  tcbStatus?: string;
}

interface TdReport {
  mrTd: Uint8Array;
  rtMr3: Uint8Array;
  reportData: Uint8Array;
}

function parseTdReport(rawQuote: Buffer): TdReport {
  const report = Quote.parse(rawQuote).report;
  const td = report.asTd10() ?? report.asTd15()?.base;
  if (!td) throw new Error("Quote non-TDX : report introuvable");
  return td;
}

function fullCodeIdentity(checks: Array<boolean | null>): boolean | null {
  if (checks.some((check) => check === false)) return false;
  return checks.every((check) => check === true) ? true : null;
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
  const mrTd = Buffer.from(td.mrTd).toString("hex");
  const rtMr3 = Buffer.from(td.rtMr3).toString("hex");
  const baseImageMatches = matchesPinnedHash(mrTd, process.env.SIRIUS_EXPECTED_MRTD, SHA384_MEASUREMENT);
  const rtMr3Matches = matchesPinnedHash(rtMr3, process.env.SIRIUS_EXPECTED_RTMR3, SHA384_MEASUREMENT);

  let eventLogMatches: boolean | null = null;
  let composeHashMatches: boolean | null = null;
  if (evidence) {
    const identity = verifyEventLogIdentity(evidence.eventLog, rtMr3, evidence.composeHash);
    eventLogMatches = identity.eventLogMatches && identity.composeEventMatches;
    composeHashMatches = matchesPinnedHash(
      evidence.composeHash,
      process.env.SIRIUS_EXPECTED_COMPOSE_HASH,
      SHA256_MEASUREMENT,
    );
  }
  const codeIdentityMatches = fullCodeIdentity([
    baseImageMatches,
    eventLogMatches,
    composeHashMatches,
    rtMr3Matches,
  ]);
  const measurements = { mrTd, rtMr3, composeHash: evidence?.composeHash ?? null };

  if (opts.skipHardware ?? isSimulator()) {
    return {
      reportDataMatches,
      hardwareVerified: null,
      baseImageMatches,
      eventLogMatches,
      composeHashMatches,
      rtMr3Matches,
      codeIdentityMatches,
      measurements,
    };
  }
  try {
    const verified = await getCollateralAndVerify(rawQuote);
    return {
      reportDataMatches,
      hardwareVerified: isAcceptedTcbStatus(verified.status),
      baseImageMatches,
      eventLogMatches,
      composeHashMatches,
      rtMr3Matches,
      codeIdentityMatches,
      measurements,
      tcbStatus: verified.status,
    };
  } catch {
    return {
      reportDataMatches,
      hardwareVerified: false,
      baseImageMatches,
      eventLogMatches,
      composeHashMatches,
      rtMr3Matches,
      codeIdentityMatches,
      measurements,
    };
  }
}
