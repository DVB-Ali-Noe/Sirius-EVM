import { createPublicClient, http } from "viem";
import { robinhoodTestnet } from "../src/lib/evm/networks";
import { checkTestnetV7, testnetV7Configuration } from "./phala-v7-preflight";

async function main() {
  if (process.argv.length !== 2 || !process.env.EVM_RPC_URL?.trim()) throw new Error();
  const config = testnetV7Configuration(process.env);
  const client = createPublicClient({ chain: robinhoodTestnet, transport: http(process.env.EVM_RPC_URL, { timeout: 15000, retryCount: 1 }) });
  const report = await checkTestnetV7(client, config);
  console.log(JSON.stringify(report, null, 2));
  if (!report.chainChecksPassed) process.exitCode = 1;
}

main().catch(() => {
  console.error("Préflight Phala/v7 refusé : vérifier la configuration explicite testnet, le RPC archive et son état finalisé, les adresses, le code USDC et les contrats. Aucune transaction envoyée.");
  process.exitCode = 1;
});
