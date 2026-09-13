import "dotenv/config";
import { prisma } from "../src/lib/db";
import { checkEvmMigration } from "../src/lib/sirius/migration-check";
import { preflightErrorMessage } from "./preflight-diagnostics";

async function main() {
  try {
    await checkEvmMigration((step) => console.log(`[préflight EVM] ${step}`));
    console.log("Préflight EVM validé");
  } catch (error) {
    console.error(preflightErrorMessage(error));
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
