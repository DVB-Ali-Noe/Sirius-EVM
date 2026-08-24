import { config } from "dotenv";

config({ path: [".env.local", ".env"], quiet: true });

async function main() {
  const { startRunner } = await import("./server");
  await startRunner();
}

void main().catch((error) => {
  console.error("[runner] démarrage impossible", error);
  process.exitCode = 1;
});
