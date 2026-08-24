import "server-only";
import { initEnclave, getEnclaveQuote } from "./dstack";
import { runLoanJob } from "./core";
import type { LoanJobInput } from "./contract";
import type { LoanJobResult, TeeRunner } from "./types";

/**
 * Runner réel (Phala dstack). Même cœur confidentiel que le stub (`runLoanJob`), mais la master
 * key est dérivée DANS l'enclave (getKey) avant tout calcul → ni le host ni l'opérateur ne
 * peuvent déchiffrer le dataset ni forger l'attestation. Ferme le trou non-custodial (D-13/D-17).
 * Filet idempotent : initEnclave est déjà appelé au boot (instrumentation) en mode phala.
 * En +, produit une quote TDX matérielle liée au modèle (report_data = payloadHash) pour la
 * vérif externe — le HMAC reste le verrou de release inline (déjà lié-enclave via getKey).
 */
export class PhalaTeeRunner implements TeeRunner {
  async run(input: LoanJobInput): Promise<LoanJobResult> {
    await initEnclave();
    const result = await runLoanJob(input);
    const evidence = await getEnclaveQuote(result.attestation.payloadHash);
    return {
      ...result,
      quote: evidence.quote,
      quoteEventLog: evidence.eventLog,
      composeHash: evidence.composeHash,
    };
  }
}
