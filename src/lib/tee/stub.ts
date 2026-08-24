import "server-only";
import { runLoanJob } from "./core";
import type { LoanJobInput } from "./contract";
import type { LoanJobResult, TeeRunner } from "./types";

/**
 * Runner in-process (dev) : simule l'enclave côté serveur. Exécute le job confidentiel avec la
 * master key SERVEUR (trou non-custodial assumé). En mode phala, PhalaTeeRunner exécute le MÊME
 * cœur (`runLoanJob`) mais avec une master key scellée à l'enclave (cf D-13/D-17, inc.3d).
 */
export class StubTeeRunner implements TeeRunner {
  run(input: LoanJobInput): Promise<LoanJobResult> {
    return runLoanJob(input);
  }
}
