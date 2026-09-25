import { execFileSync } from "node:child_process";
import { closeSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function renderPhalaV7(mode, image) {
  if (!["bootstrap", "init", "active", "wallets"].includes(mode)
    || !/^ghcr\.io\/dvb-ali-noe\/sirius-runner@sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Mode ou digest immuable invalide");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const files = ["compose.yaml", mode === "active" ? "compose.v7.yaml" : "compose.bootstrap-v7.yaml"];
  if (mode === "init") files.push("compose.init-v7.yaml");
  if (mode === "wallets") files.push("compose.trial-wallets.yaml");
  const args = ["compose", ...files.flatMap((name) => ["-f", resolve(root, "deploy/phala", name)]),
    "config", "--no-interpolate", "--no-env-resolution", "--format", "json"];
  const model = JSON.parse(execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000 }));
  // Les noms calculés sur le poste local détacheraient les volumes persistants de la CVM.
  delete model.name;
  for (const volume of Object.values(model.volumes)) delete volume.name;
  for (const network of Object.values(model.networks ?? {})) delete network.name;
  for (const service of Object.values(model.services)) {
    service.image = image;
    if (Array.isArray(service.environment)) service.environment = Object.fromEntries(service.environment.map((entry) => {
      const separator = entry.indexOf("=");
      if (separator < 1) throw new Error("Variable héritée implicitement refusée");
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }));
  }
  model.services.runner.environment.SIRIUS_APP_ORIGIN = "https://sirius-evm-staging.vercel.app";
  if (model.services.runner.environment.RUNNER_TRANSPORT_SECRET !== "${RUNNER_TRANSPORT_SECRET}"
    || model.services.runner.environment.PINATA_JWT !== "${PINATA_JWT}") throw new Error("Interpolation de secret refusée");
  return model;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [mode, image, destination, ...extra] = process.argv.slice(2);
    if (!destination || extra.length) throw new Error();
    const model = renderPhalaV7(mode, image);
    const fd = openSync(destination, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(model, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
    console.log(`Compose ${mode} de staging préparé ; image figée, variables chiffrées non interpolées.`);
  } catch {
    console.error("Préparation Compose refusée : vérifier le mode, le digest, Docker Compose et un fichier de sortie inexistant. Aucun déploiement effectué.");
    process.exitCode = 1;
  }
}
