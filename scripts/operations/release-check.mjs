import { parseEnv } from "node:util";
import { readPrivateFile } from "./archive.mjs";

const ADDRESS = /^0x(?!0{40}$)[a-fA-F0-9]{40}$/;
const CONTRACTS = ["ESCROW", "DATASET", "KYB", "USDC"];
const MEASURES = { SIRIUS_EXPECTED_MRTD: 96, SIRIUS_EXPECTED_RTMR3: 96,
  SIRIUS_EXPECTED_COMPOSE_HASH: 64, SIRIUS_EXPECTED_MASTER_KEY_CHAIN_SHA256: 64, NEXT_PUBLIC_SIRIUS_INGRESS_KEY_SHA256: 64 };

/** USDC ponté officiel de Robinhood Chain mainnet, 6 décimales. */
export const MAINNET_USDC = "0x80e0e24718dbfcad49ecaa6f1e6c89a190586ca8";

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
  if (network === "mainnet") {
    for (const role of Object.keys(roles)) {
      if (roles[role].SIRIUS_USDC_ADDRESS?.toLowerCase() !== MAINNET_USDC) issues.push(`${role}.SIRIUS_USDC_ADDRESS.mainnet`);
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
