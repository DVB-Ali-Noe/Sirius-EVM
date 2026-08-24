import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";

const SHA384_BYTES = 48;
const SHA384_HEX = /^[0-9a-f]{96}$/i;
const SHA256_HEX = /^[0-9a-f]{64}$/i;
const MAX_EVENT_LOG_BYTES = 2 * 1024 * 1024;
const MAX_EVENT_COUNT = 10_000;

interface DstackEvent {
  imr: number;
  digest: string;
  event: string;
  event_payload: string;
}

export interface EventLogIdentity {
  replayedRtMr3: string;
  eventLogMatches: boolean;
  composeEventMatches: boolean;
}

function equalHex(left: string, right: string): boolean {
  if (left.length !== right.length || left.length % 2 !== 0) return false;
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseEventLog(raw: string): DstackEvent[] {
  if (Buffer.byteLength(raw) > MAX_EVENT_LOG_BYTES) throw new Error("Event-log TDX trop volumineux");
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length > MAX_EVENT_COUNT) throw new Error("Event-log TDX invalide");

  return parsed.map((event) => {
    if (
      !event ||
      typeof event !== "object" ||
      !Number.isInteger(Reflect.get(event, "imr")) ||
      typeof Reflect.get(event, "digest") !== "string" ||
      typeof Reflect.get(event, "event") !== "string" ||
      typeof Reflect.get(event, "event_payload") !== "string"
    ) {
      throw new Error("Entrée d’event-log TDX invalide");
    }
    const digest = Reflect.get(event, "digest") as string;
    if (!SHA384_HEX.test(digest)) throw new Error("Digest d’event-log TDX invalide");
    return {
      imr: Reflect.get(event, "imr") as number,
      digest: digest.toLowerCase(),
      event: Reflect.get(event, "event") as string,
      event_payload: Reflect.get(event, "event_payload") as string,
    };
  });
}

export function replayRtMr3(eventLog: string): string {
  let measurement = Buffer.alloc(SHA384_BYTES);
  for (const event of parseEventLog(eventLog)) {
    if (event.imr !== 3) continue;
    measurement = createHash("sha384").update(measurement).update(Buffer.from(event.digest, "hex")).digest();
  }
  return measurement.toString("hex");
}

export function verifyEventLogIdentity(
  eventLog: string,
  measuredRtMr3: string,
  composeHash: string,
): EventLogIdentity {
  if (!SHA384_HEX.test(measuredRtMr3) || !SHA256_HEX.test(composeHash)) {
    throw new Error("Mesure d’identité TEE invalide");
  }
  const events = parseEventLog(eventLog);
  const replayedRtMr3 = replayRtMr3(eventLog);
  return {
    replayedRtMr3,
    eventLogMatches: equalHex(replayedRtMr3, measuredRtMr3.toLowerCase()),
    composeEventMatches: events.some(
      (event) => event.imr === 3 && event.event === "compose-hash" && equalHex(event.event_payload, composeHash),
    ),
  };
}

export function hashSignatureChain(chain: Uint8Array[]): string {
  const hash = createHash("sha256");
  for (const item of chain) {
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(item.length);
    hash.update(length).update(item);
  }
  return hash.digest("hex");
}

export function matchesPinnedHash(actual: string, expected: string | undefined, pattern: RegExp): boolean | null {
  if (!expected) return null;
  const normalized = expected.trim().toLowerCase();
  if (!pattern.test(normalized)) throw new Error("Mesure TEE épinglée invalide");
  return equalHex(actual.toLowerCase(), normalized);
}

export const SHA256_MEASUREMENT = SHA256_HEX;
export const SHA384_MEASUREMENT = SHA384_HEX;
