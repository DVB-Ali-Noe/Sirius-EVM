export async function registerNode() {
  if (process.env.NODE_ENV === "production") {
    if (process.env.NEXT_PUBLIC_SIRIUS_E2E === "1") {
      throw new Error("NEXT_PUBLIC_SIRIUS_E2E interdit en production");
    }
    if (process.env.TEE_MODE !== "phala") throw new Error("TEE_MODE=phala obligatoire en production");
    if (process.env.DSTACK_SIMULATOR_ENDPOINT) throw new Error("Simulateur dstack interdit en production");
    for (const name of [
      "RUNNER_URL",
      "RUNNER_TRANSPORT_SECRET",
      "SIRIUS_SESSION_SECRET",
      "SIRIUS_EXPECTED_MRTD",
      "SIRIUS_EXPECTED_RTMR3",
      "SIRIUS_EXPECTED_COMPOSE_HASH",
      "SIRIUS_EXPECTED_MASTER_KEY_CHAIN_SHA256",
      "NEXT_PUBLIC_SIRIUS_INGRESS_KEY_SHA256",
      "SIRIUS_APP_ORIGIN",
      "SIRIUS_ESCROW_ADDRESS",
      "SIRIUS_USDC_ADDRESS",
      "SIRIUS_KYB_ADDRESS",
      "SIRIUS_DATASET_ADDRESS",
      "NEXT_PUBLIC_SIRIUS_ESCROW_ADDRESS",
      "NEXT_PUBLIC_SIRIUS_USDC_ADDRESS",
      "NEXT_PUBLIC_SIRIUS_KYB_ADDRESS",
      "NEXT_PUBLIC_SIRIUS_DATASET_ADDRESS",
    ]) {
      if (!process.env[name]) throw new Error(`${name} obligatoire en production`);
    }
    if (process.env.SIRIUS_REAPER_ENABLED !== "true") {
      throw new Error("SIRIUS_REAPER_ENABLED=true obligatoire en production");
    }
    if (process.env.SIRIUS_TRUST_PROXY_HEADERS !== "true") {
      throw new Error("SIRIUS_TRUST_PROXY_HEADERS=true obligatoire en production");
    }
    if (process.env.SIRIUS_INGRESS_RATE_LIMITED !== "true") {
      throw new Error("SIRIUS_INGRESS_RATE_LIMITED=true obligatoire en production");
    }
    if (process.env.EVM_NETWORK !== "mainnet" || process.env.NEXT_PUBLIC_EVM_NETWORK !== "mainnet") {
      throw new Error("EVM_NETWORK et NEXT_PUBLIC_EVM_NETWORK doivent être mainnet en production");
    }
    for (const [privateName, publicName] of [
      ["SIRIUS_ESCROW_ADDRESS", "NEXT_PUBLIC_SIRIUS_ESCROW_ADDRESS"],
      ["SIRIUS_USDC_ADDRESS", "NEXT_PUBLIC_SIRIUS_USDC_ADDRESS"],
      ["SIRIUS_KYB_ADDRESS", "NEXT_PUBLIC_SIRIUS_KYB_ADDRESS"],
      ["SIRIUS_DATASET_ADDRESS", "NEXT_PUBLIC_SIRIUS_DATASET_ADDRESS"],
    ]) {
      if (process.env[privateName]?.toLowerCase() !== process.env[publicName]?.toLowerCase()) {
        throw new Error(`${privateName} et ${publicName} doivent désigner le même contrat`);
      }
    }
  }

  if (
    process.env.NODE_ENV !== "production" &&
    process.env.TEE_MODE === "phala" &&
    !process.env.RUNNER_URL
  ) {
    const { initEnclave } = await import("@/lib/tee/dstack");
    await initEnclave();
  }

  if (process.env.SIRIUS_REAPER_ENABLED === "true") {
    const { startLoanReaper } = await import("@/lib/sirius/reaper");
    startLoanReaper();
  }
}
