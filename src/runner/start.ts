import { startRunner } from "./server";

void startRunner().catch(() => {
  console.error("[runner] démarrage impossible : vérifier la configuration et l'identité TEE");
  process.exitCode = 1;
});
