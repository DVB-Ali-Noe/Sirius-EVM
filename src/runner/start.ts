import { startRunner } from "./server";

void startRunner().catch((error) => {
  console.error("[runner] démarrage impossible", error);
  process.exitCode = 1;
});
