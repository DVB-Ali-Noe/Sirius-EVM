import { parseEnv } from "node:util";
import { readPrivateFile } from "./archive.mjs";

const ADDRESS = /^0x(?!0{40}$)[a-fA-F0-9]{40}$/;
const CONTRACTS = ["ESCROW", "DATASET", "KYB", "USDC"];
// RTMR3 n'est plus épinglé brut : il change à chaque redémarrage de la CVM (audit A-01).
const MEASURES = { SIRIUS_EXPECTED_MRTD: 96,
  SIRIUS_EXPECTED_COMPOSE_HASH: 64, SIRIUS_EXPECTED_MASTER_KEY_CHAIN_SHA256: 64, NEXT_PUBLIC_SIRIUS_INGRESS_KEY_SHA256: 64 };

/**
 * USDG (Paxos) sur Robinhood Chain mainnet, 6 décimales, en minuscules pour les comparaisons.
 * Ce module reste du JavaScript sans chargeur TypeScript : la valeur est recopiée depuis
 * src/lib/evm/stablecoin.ts, et src/lib/evm/stablecoin.test.ts vérifie qu'elles restent égales.
 */
export const MAINNET_STABLECOIN = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";
/** @deprecated Nom historique gardé par compatibilité (cahier des charges A8) : vaut l'USDG, pas l'USDC. Aucun importateur hors tests. */
export const MAINNET_USDC = MAINNET_STABLECOIN;

export function checkReleaseEnvironments(next, reaper, runner, network = "testnet") {
  if (network !== "testnet" && network !== "mainnet") throw new Error("Réseau attendu : testnet ou mainnet");
  const issues = [];
  const roles = { next, reaper, runner };
  const requireValue = (role, name, pattern) => {
    if (!pattern.test(roles[role][name] || "")) issues.push(`${role}.${name}`);
  };
  for (const role of Object.keys(roles)) {
    requireValue(role, "EVM_NETWORK", new RegExp(`^${network}$`));
    requireValue(role, "SIRIUS_BILLING_VERSION", /^7$/);
    requireValue(role, "SIRIUS_EVM_FINALITY", /^finalized$/);
    requireValue(role, "SIRIUS_EVM_CONFIRMATIONS", /^(?:[1-9]|[1-9][0-9]|100)$/);
    requireValue(role, "TEE_MODE", /^phala$/);
    requireValue(role, "SIRIUS_LOCK_AUTHORIZER", ADDRESS);
    for (const suffix of CONTRACTS) requireValue(role, `SIRIUS_${suffix}_ADDRESS`, ADDRESS);
    if (roles[role].SIRIUS_MASTER_KEY || roles[role].ROBINHOOD_DEPLOYER_KEY || roles[role].SIRIUS_KYB_VERIFIER_KEY
      || roles[role].DSTACK_SIMULATOR_ENDPOINT) issues.push(`${role}.forbidden-secret-or-simulator`);
  }
  for (const key of ["EVM_NETWORK", "SIRIUS_BILLING_VERSION", "SIRIUS_EVM_FINALITY", "SIRIUS_EVM_CONFIRMATIONS",
    "SIRIUS_LOCK_AUTHORIZER", ...CONTRACTS.map((suffix) => `SIRIUS_${suffix}_ADDRESS`)]) {
    if (new Set(Object.values(roles).map((env) => env[key]?.toLowerCase())).size !== 1) issues.push(`divergence.${key}`);
  }
  for (const role of ["next", "reaper"]) {
    requireValue(role, "SIRIUS_REQUIRE_PHALA", /^true$/);
    for (const [key, size] of Object.entries(MEASURES)) requireValue(role, key, new RegExp(`^[a-f0-9]{${size}}$`, "i"));
    try {
      const url = new URL(roles[role].RUNNER_URL);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error();
    } catch { issues.push(`${role}.RUNNER_URL`); }
    if (!roles[role].DATABASE_URL || roles[role].DATABASE_URL.includes("[SENSITIVE]")) issues.push(`${role}.DATABASE_URL`);
  }
  for (const key of [...Object.keys(MEASURES), "RUNNER_URL", "DATABASE_URL", "SIRIUS_LEGACY_ESCROW_ADDRESSES"]) {
    if (next[key] !== reaper[key]) issues.push(`divergence.${key}`);
  }
  if (Object.values(roles).some((env) => !env.RUNNER_TRANSPORT_SECRET || env.RUNNER_TRANSPORT_SECRET.length < 32)
    || new Set(Object.values(roles).map((env) => env.RUNNER_TRANSPORT_SECRET)).size !== 1) issues.push("transport-secret");
  for (const suffix of CONTRACTS) if (next[`NEXT_PUBLIC_SIRIUS_${suffix}_ADDRESS`]?.toLowerCase() !== next[`SIRIUS_${suffix}_ADDRESS`]?.toLowerCase()) {
    issues.push(`next.public.${suffix}`);
  }
  if (next.NEXT_PUBLIC_EVM_NETWORK !== network) issues.push("next.NEXT_PUBLIC_EVM_NETWORK");
  // Accès instantané KYB : la clé du vérificateur automatique ne vit que sur Next, et seulement
  // avec le drapeau (sans lui, c'est un secret exposé pour rien). Le vérificateur humain reste
  // interdit partout, ci-dessus. Drapeau et clé absents = configuration sans la fonction, valide.
  for (const role of ["reaper", "runner"]) if (roles[role].SIRIUS_KYB_AUTO_INVITE_KEY) issues.push(`${role}.forbidden-secret-or-simulator`);
  // Même lecture qu'à l'exécution (`auto-invite.ts`) : valeurs débarrassées de leurs espaces.
  const autoInviteFlag = next.SIRIUS_KYB_AUTO_INVITE?.trim() ?? "";
  const autoInviteKey = next.SIRIUS_KYB_AUTO_INVITE_KEY?.trim() ?? "";
  if (autoInviteFlag && autoInviteFlag !== "true" && autoInviteFlag !== "false") issues.push("next.SIRIUS_KYB_AUTO_INVITE");
  if (autoInviteFlag === "true") {
    if (!/^0x[a-fA-F0-9]{64}$/.test(autoInviteKey)) issues.push("next.SIRIUS_KYB_AUTO_INVITE_KEY");
  } else if (autoInviteKey) issues.push("next.SIRIUS_KYB_AUTO_INVITE_KEY.without-flag");
  if (network === "mainnet") {
    for (const role of Object.keys(roles)) {
      if (roles[role].SIRIUS_USDC_ADDRESS?.trim().toLowerCase() !== MAINNET_STABLECOIN) issues.push(`${role}.SIRIUS_USDC_ADDRESS.mainnet`);
      if (roles[role].SIRIUS_KYB_MODE === "open") issues.push(`${role}.SIRIUS_KYB_MODE.open`);
      if (roles[role].SIRIUS_LEGACY_ESCROW_ADDRESSES?.trim()) issues.push(`${role}.SIRIUS_LEGACY_ESCROW_ADDRESSES.inherited`);
    }
    if (next.SIRIUS_DEPLOYMENT_MODE === "demo" || next.NEXT_PUBLIC_SIRIUS_DEPLOYMENT_MODE === "demo") issues.push("next.demo-mode");
    if (next.SIRIUS_FAUCET_KEY) issues.push("next.faucet-key");
    if (next.NEXT_PUBLIC_WEB3AUTH_NETWORK && next.NEXT_PUBLIC_WEB3AUTH_NETWORK !== "sapphire_mainnet") issues.push("next.NEXT_PUBLIC_WEB3AUTH_NETWORK");
    for (const key of ["SIRIUS_MAX_LOAN_USDC", "SIRIUS_MAX_EXPOSURE_USDC"]) {
      if (!/^[0-9]+(\.[0-9]+)?$/.test(next[key] ?? "")) issues.push(`next.${key}`);
    }
  }
  if (!runner.RUNNER_BUDGET_FILE?.startsWith("/") || !runner.RUNNER_BILLING_POLICY_FILE?.startsWith("/")) issues.push("runner.policy-paths");
  if (runner.DATABASE_URL || reaper.PINATA_JWT) issues.push("unexpected-database-or-storage-secret");
  return { configurationReady: !issues.length, issues, activeAttestationVerified: false, contractsVerified: false, policiesVerified: false };
}

if (process.argv[1]?.endsWith("/release-check.mjs")) {
  try {
    const args = process.argv.slice(2);
    const network = args.find((arg) => arg.startsWith("--network="))?.slice("--network=".length) ?? "testnet";
    const paths = args.filter((arg) => !arg.startsWith("--network="));
    if (paths.length !== 3) throw new Error();
    const [next, reaper, runner] = paths.map((path) => parseEnv(readPrivateFile(path).toString()));
    const report = { network, ...checkReleaseEnvironments(next, reaper, runner, network) };
    console.log(JSON.stringify(report, null, 2));
    if (!report.configurationReady) process.exitCode = 1;
  } catch { console.error("Trois fichiers privés explicites requis : Next, reaper, runner, et --network=mainnet pour le mainnet. Aucune valeur de secret affichée."); process.exitCode = 1; }
}
