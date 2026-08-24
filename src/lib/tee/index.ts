import "server-only";
import type { TeeRunner } from "./types";
import { StubTeeRunner } from "./stub";
import { PhalaTeeRunner } from "./phala";

/** Sélectionne l'exécuteur TEE selon TEE_MODE (stub | phala). */
export function getTeeRunner(): TeeRunner {
  const mode = process.env.TEE_MODE ?? "stub";
  if (mode === "phala") return new PhalaTeeRunner();
  return new StubTeeRunner();
}

export type { TeeResult, TeeRunner, Attestation } from "./types";
export type { LoanJobInput, TrainingInput, DatasetRef } from "./contract";
