import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });
process.env.RUNNER_URL ||= "http://localhost:4100";

async function main() {
  const baseUrl = `${process.env.RUNNER_URL!.replace(/\/+$/, "")}/`;
  if (new URL(baseUrl).protocol === "http:") {
    const health = await fetch(new URL("health", baseUrl), { signal: AbortSignal.timeout(5_000) });
    if (!health.ok) throw new Error(`Healthcheck runner en échec (${health.status})`);
  }

  const { datasetIngressKeyInRunner } = await import("@/lib/tee/runner-client");
  const ingressKey = await datasetIngressKeyInRunner();
  if (Buffer.from(ingressKey.publicKey, "base64url").length !== 65) {
    throw new Error("Clé d’ingestion runner invalide");
  }
  if (ingressKey.origin !== (process.env.SIRIUS_APP_ORIGIN ?? "http://localhost:3000")) {
    throw new Error("Origine de la clé d’ingestion runner invalide");
  }

  console.log(`[runner:smoke] OK — ${process.env.RUNNER_URL}`);
}

void main().catch((error) => {
  console.error("[runner:smoke] échec", error);
  process.exitCode = 1;
});
