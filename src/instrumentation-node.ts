export async function registerNode() {
  if (process.env.NODE_ENV === "production") {
    if (process.env.NEXT_PUBLIC_SIRIUS_E2E === "1") {
      throw new Error("NEXT_PUBLIC_SIRIUS_E2E interdit en production");
    }
    for (const name of ["XRPL_PROVIDER_SEED", "XRPL_BORROWER_SEED", "XRPL_VERIFIER_SEED"]) {
      if (process.env[name]) throw new Error(`${name} interdit dans l’application de production`);
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
      "NEXT_PUBLIC_SIRIUS_INGRESS_KEY_SHA256",
      "SIRIUS_APP_ORIGIN",
      "SIRIUS_VERIFIER_ADDRESS",
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
    if (process.env.XRPL_NETWORK !== "mainnet" || process.env.NEXT_PUBLIC_XRPL_NETWORK !== "mainnet") {
      throw new Error("XRPL_NETWORK et NEXT_PUBLIC_XRPL_NETWORK doivent être mainnet en production");
    }
    if (process.env.NEXT_PUBLIC_WEB3AUTH_NETWORK !== "sapphire_mainnet") {
      throw new Error("NEXT_PUBLIC_WEB3AUTH_NETWORK=sapphire_mainnet obligatoire en production");
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
