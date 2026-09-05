import "dotenv/config";
import { prisma } from "../src/lib/db";
import { checkEvmMigration } from "../src/lib/sirius/migration-check";
import { AppError } from "../src/lib/app-error";

async function main() {
  try {
    await checkEvmMigration();
    console.log("Préflight EVM validé");
  } catch (error) {
    console.error(error instanceof AppError ? error.message : "Préflight EVM impossible : vérifier la base et le RPC");
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

void main();
