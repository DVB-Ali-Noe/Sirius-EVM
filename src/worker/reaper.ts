import { runLoanReaper } from "@/lib/sirius/reaper";
import { requireReaperEvmDeployment } from "@/lib/evm/deployment";
import { AppError } from "@/lib/app-error";

/**
 * Reaper autonome, destiné à tourner en conteneur sur le VPS.
 *
 * L'application Next est hébergée en serverless : elle n'a aucun processus qui vive
 * entre deux requêtes, donc nulle part où réconcilier les prêts en arrière-plan. Ce
 * point d'entrée est ce processus permanent, et il attaque la même base.
 *
 * Deux différences avec le démarrage en cours de processus utilisé en développement :
 *
 *   - La boucle est séquentielle. Un `setInterval` relance à échéance fixe même si la
 *     passe précédente n'est pas terminée ; sur une base lente ou un lot de prêts qui
 *     traîne, les exécutions se recouvrent et se disputent les mêmes lignes. Ici la
 *     pause ne commence qu'une fois la passe finie.
 *
 *   - Le processus reste vivant. En développement le timer est `unref`é pour ne pas
 *     retenir Next ; ici c'est exactement l'inverse qu'on veut.
 */

const MIN_INTERVAL_MS = 5_000;
const MAX_INTERVAL_MS = 300_000;

function resolveInterval(): number {
  const interval = Number(process.env.SIRIUS_REAPER_INTERVAL_MS ?? 30_000);
  if (!Number.isSafeInteger(interval) || interval < MIN_INTERVAL_MS || interval > MAX_INTERVAL_MS) {
    throw new AppError(
      `SIRIUS_REAPER_INTERVAL_MS invalide : attendu un entier entre ${MIN_INTERVAL_MS} et ${MAX_INTERVAL_MS} ms`,
    );
  }
  return interval;
}

let arret = false;
let reveil: (() => void) | null = null;

/** Pause interruptible : un signal d'arrêt n'attend pas la fin du délai. */
function pause(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      reveil = null;
      resolve();
    }, ms);
    reveil = () => {
      clearTimeout(timer);
      reveil = null;
      resolve();
    };
  });
}

function demanderArret(signal: string): void {
  if (arret) return;
  arret = true;
  console.log(`[reaper] ${signal} reçu — arrêt après la passe en cours`);
  reveil?.();
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => demanderArret(signal));
}

async function main(): Promise<void> {
  const interval = resolveInterval();
  await requireReaperEvmDeployment();
  console.log(`[reaper] démarré, une passe toutes les ${interval} ms`);

  while (!arret) {
    const debut = Date.now();
    try {
      await runLoanReaper();
    } catch {
      // Une passe qui échoue ne doit pas tuer le worker : la cause est presque
      // toujours transitoire — base indisponible, RPC qui refuse. La passe suivante
      // reprendra les mêmes prêts, puisque rien n'a été marqué comme traité.
      console.error("[reaper] passe échouée, reprise à la suivante");
    }
    if (arret) break;
    const reste = interval - (Date.now() - debut);
    if (reste > 0) await pause(reste);
  }

  console.log("[reaper] arrêté proprement");
}

main().catch((error) => {
  console.error(error instanceof AppError
    ? `[reaper] arrêt : ${error.message}`
    : "[reaper] arrêt sur erreur fatale : vérifier la configuration et les contrats");
  process.exitCode = 1;
});
