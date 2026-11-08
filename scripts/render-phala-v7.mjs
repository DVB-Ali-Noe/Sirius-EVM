import { execFileSync } from "node:child_process";
import { closeSync, fsyncSync, openSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Origine HTTPS nue, sans chemin, requête ni port : celle que le runner compare aux délégations. */
export function appOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Origine de l'application invalide"); }
  if (url.protocol !== "https:" || url.origin !== value || url.port) throw new Error("Origine de l'application invalide");
  return url.origin;
}

/**
 * Profils facultatifs que l'image peut proposer. Écrits en clair dans le Compose actif, donc
 * couverts par le hash attesté ; aligné sur `optIn` de src/lib/models/registry.ts (test).
 */
export const OPT_IN_MODELS = ["linear_regression", "gradient_boosted_trees"];

function optInModels(value) {
  const ids = value.split(",").map((id) => id.trim());
  if (!ids.length || ids.some((id) => !OPT_IN_MODELS.includes(id)) || new Set(ids).size !== ids.length) {
    throw new Error("Profil facultatif inconnu");
  }
  return ids.join(",");
}

export function renderPhalaV7(mode, image, origin, optIn) {
  if (!["bootstrap", "init", "active", "wallets", "billing", "demo-init", "demo-active", "demo-billing", "demo-budget", "demo-renewal"].includes(mode)
    || !/^ghcr\.io\/dvb-ali-noe\/sirius-runner@sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Mode ou digest immuable invalide");
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const demo = mode.startsWith("demo-");
  const active = ["active", "demo-active"].includes(mode);
  // L'interrupteur ne concerne que le runner qui sert : jamais un rendu de maintenance.
  if (optIn !== undefined && !active) throw new Error("Profils facultatifs réservés au Compose actif");
  // La démonstration lit son origine dans l'environnement chiffré. Toute autre instance la
  // reçoit explicitement : plus aucune origine staging imposée par défaut.
  if (demo ? origin !== undefined : !origin) throw new Error("Origine de l'application requise hors démonstration");
  const runnerOrigin = demo ? "${SIRIUS_APP_ORIGIN}" : appOrigin(origin);
  const files = ["compose.yaml", active ? "compose.v7.yaml" : "compose.bootstrap-v7.yaml"];
  if (mode === "init" || mode === "demo-init") files.push("compose.init-v7.yaml");
  if (mode === "wallets") files.push("compose.trial-wallets.yaml");
  if (["billing", "demo-billing", "demo-renewal"].includes(mode)) files.push("compose.billing-update.yaml");
  // Prolongation du budget sponsorisé : démonstration seulement. `demo-renewal` enchaîne le tarif
  // après une prolongation réussie, le tarif ne pouvant survivre au budget.
  if (mode === "demo-budget" || mode === "demo-renewal") files.push("compose.budget-renewal.yaml");
  if (mode === "demo-renewal") files.push("compose.renewal-order.yaml");
  if (demo) files.push("compose.demo.yaml");
  const args = ["compose", ...files.flatMap((name) => ["-f", resolve(root, "deploy/phala", name)]),
    "config", "--no-interpolate", "--no-env-resolution", "--format", "json"];
  const model = JSON.parse(execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000 }));
  // Les noms calculés sur le poste local détacheraient les volumes persistants de la CVM.
  delete model.name;
  for (const [name, volume] of Object.entries(model.volumes)) {
    if (!demo) delete volume.name;
    else if (volume.name !== ({ runner_budget: "sirius_phala_demo_budget", runner_replay: "sirius_phala_demo_replay" })[name]) throw new Error("Volume de démonstration inattendu");
  }
  for (const network of Object.values(model.networks ?? {})) delete network.name;
  for (const service of Object.values(model.services)) {
    service.image = image;
    if (Array.isArray(service.environment)) service.environment = Object.fromEntries(service.environment.map((entry) => {
      const separator = entry.indexOf("=");
      if (separator < 1) throw new Error("Variable héritée implicitement refusée");
      return [entry.slice(0, separator), entry.slice(separator + 1)];
    }));
  }
  model.services.runner.environment.SIRIUS_APP_ORIGIN = runnerOrigin;
  if (optIn !== undefined) model.services.runner.environment.NEXT_PUBLIC_SIRIUS_OPT_IN_MODELS = optInModels(optIn);
  if (model.services.runner.environment.RUNNER_TRANSPORT_SECRET !== "${RUNNER_TRANSPORT_SECRET}"
    || model.services.runner.environment.PINATA_JWT !== "${PINATA_JWT}") throw new Error("Interpolation de secret refusée");
  return model;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    const flags = args.filter((arg) => arg.startsWith("--"));
    const [mode, image, destination, ...extra] = args.filter((arg) => !arg.startsWith("--"));
    const flag = (name) => flags.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
    const origin = flag("origin");
    const optIn = flag("opt-in-models");
    if (!destination || extra.length || flags.length !== [origin, optIn].filter((value) => value !== undefined).length) throw new Error();
    const model = renderPhalaV7(mode, image, origin, optIn);
    const fd = openSync(destination, "wx", 0o600);
    try { writeFileSync(fd, JSON.stringify(model, null, 2) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
    console.log(`Compose ${mode} préparé pour ${model.services.runner.environment.SIRIUS_APP_ORIGIN} ; image figée, variables chiffrées non interpolées.`);
  } catch {
    console.error("Préparation Compose refusée : vérifier le mode, le digest, --origin=https://… (obligatoire hors démonstration), --opt-in-models=… (Compose actif seulement), Docker Compose et un fichier de sortie inexistant. Aucun déploiement effectué.");
    process.exitCode = 1;
  }
}
