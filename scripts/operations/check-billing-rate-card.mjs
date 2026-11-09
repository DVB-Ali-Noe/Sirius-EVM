// Porte de déploiement D-33 (audit F-1) : lancée par le pipeline après `vercel pull`, avant
// `vercel build`. En facturation v7, une location sans `apiAccessDailyComputeAmount` ni quota
// `apiCallsPerDay` pour son profil est refusée (409) : on refuse donc de déployer un tarif
// Vercel incomplet plutôt que de le découvrir au premier emprunt.
//
// Ne s'applique pas à l'instance de démonstration Phala (`SIRIUS_PHALA_DEMO=true`, staging) :
// ses datasets restent privés, elle ne loue pas. La porte redevient active dès que la cible loue.
//
// Aucune valeur n'est jamais affichée : seuls des noms de variables et de profils apparaissent
// dans les messages. Ne vérifie que la copie Vercel du tarif ; celle du volume du runner reste
// à contrôler à la main (`update-runner-billing-policy`), le pipeline ne joint pas la CVM.
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/**
 * Lecture minimale du format écrit par `vercel pull` (vercel@59) : `KEY="valeur"` où seuls les
 * retours à la ligne sont échappés (`\n`, `\r`) ; guillemets et barres obliques inverses restent
 * bruts. La valeur va donc du premier au DERNIER guillemet de la ligne, sans autre déséchappement.
 */
export function parseEnvFile(text) {
  const env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match) continue;
    const [, key, rest] = match;
    let value = rest;
    if (rest.startsWith("\"") && rest.lastIndexOf("\"") > 0) {
      value = rest.slice(1, rest.lastIndexOf("\"")).replace(/\\n/g, "\n").replace(/\\r/g, "\r");
    } else if (rest.startsWith("'")) {
      const end = rest.indexOf("'", 1);
      value = rest.slice(1, end === -1 ? undefined : end);
    } else {
      value = rest.replace(/\s+#.*$/, "").trim();
    }
    env[key] = value;
  }
  return env;
}

/** `vercel pull` écrit `[SENSITIVE]` à la place d'une variable Sensitive : illisible, donc refusée. */
const SENSITIVE = "[SENSITIVE]";
const hidden = (key) => ({ applies: true, problems: [`${key} est marquée Sensitive sur Vercel : illisible par la porte, la repasser en non-Sensitive (ce n'est pas un secret)`] });

/**
 * Renvoie la liste des problèmes (vide = déploiement autorisé) et si la porte s'applique.
 * Chaque variable n'est exigée lisible que si la porte en a besoin : une cible v6 ou de
 * démonstration n'est jamais bloquée par un tarif Sensitive qu'elle n'utilise pas.
 */
export function checkRateCard(env) {
  if (env.SIRIUS_BILLING_VERSION === SENSITIVE) return hidden("SIRIUS_BILLING_VERSION");
  const version = env.SIRIUS_BILLING_VERSION ?? "";
  if (version !== "7") return { applies: false, reason: `facturation ${version || "v6 (défaut)"} : porte D-33 sans objet`, problems: [] };
  if (env.SIRIUS_PHALA_DEMO === SENSITIVE) return hidden("SIRIUS_PHALA_DEMO");
  if (env.SIRIUS_PHALA_DEMO === "true") return { applies: false, reason: "instance de démonstration Phala (SIRIUS_PHALA_DEMO=true) : aucune location", problems: [] };
  if (env.SIRIUS_BILLING_POLICY_JSON === SENSITIVE) return hidden("SIRIUS_BILLING_POLICY_JSON");
  const raw = env.SIRIUS_BILLING_POLICY_JSON;
  if (!raw) return { applies: true, problems: ["SIRIUS_BILLING_POLICY_JSON absent"] };
  let policy;
  try { policy = JSON.parse(raw); } catch { return { applies: true, problems: ["SIRIUS_BILLING_POLICY_JSON n'est pas du JSON valide"] }; }
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) return { applies: true, problems: ["SIRIUS_BILLING_POLICY_JSON n'est pas un objet"] };
  const problems = [];
  const fee = policy.apiAccessDailyComputeAmount;
  if (typeof fee !== "string" || !/^[1-9][0-9]{0,28}$/.test(fee)) problems.push("apiAccessDailyComputeAmount absent ou non strictement positif");
  const profiles = policy.profiles && typeof policy.profiles === "object" ? Object.keys(policy.profiles) : [];
  // Profils louables : ceux qui ont un tarif, sauf la régression linéaire, sans API (D-27, D-31).
  const rentable = profiles.filter((id) => id !== "linear_regression");
  if (rentable.length === 0) problems.push("aucun profil louable dans profiles");
  const calls = policy.apiCallsPerDay && typeof policy.apiCallsPerDay === "object" ? policy.apiCallsPerDay : {};
  for (const id of rentable) {
    const n = calls[id];
    if (!Number.isSafeInteger(n) || n < 1) problems.push(`apiCallsPerDay manquant pour le profil louable ${id}`);
  }
  return { applies: true, problems };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const file = process.argv[2] || ".vercel/.env.production.local";
  let text;
  try { text = readFileSync(file, "utf8"); } catch {
    console.error(`Fichier d'environnement illisible : ${file}`);
    process.exit(1);
  }
  const result = checkRateCard(parseEnvFile(text));
  if (!result.applies) {
    console.log(`Porte tarif D-33 ignorée — ${result.reason}.`);
  } else if (result.problems.length > 0) {
    for (const p of result.problems) console.error(`::error::Tarif v7 incomplet : ${p}`);
    console.error("Déploiement refusé (D-33) : compléter SIRIUS_BILLING_POLICY_JSON sur Vercel et la politique du volume du runner.");
    process.exitCode = 1;
  } else {
    console.log("Porte tarif D-33 : tarif v7 complet pour tous les profils louables.");
  }
}
