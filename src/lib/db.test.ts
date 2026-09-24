import assert from "node:assert/strict";
import { test } from "node:test";

test("les conflits de sérialisation et de commit sont repris, les autres erreurs ne le sont pas", async () => {
  process.env.DATABASE_URL = "postgresql://synthetic:synthetic@127.0.0.1:1/unused";
  const { prisma, serializableTransaction } = await import("./db");
  const original = prisma.$transaction;
  try {
    for (const error of [
      { code: "P2034" },
      new Error("TransactionWriteConflict", { cause: { kind: "TransactionWriteConflict" } }),
      new Error("commit", { cause: { sqlState: "40001" } }),
      { cause: { code: "40P01" } },
    ]) {
      let calls = 0;
      Reflect.set(prisma, "$transaction", async () => { if (++calls === 1) throw error; return 42; });
      assert.equal(await serializableTransaction(async () => 42), 42);
      assert.equal(calls, 2);
    }
    let calls = 0;
    const conflict = { cause: { kind: "TransactionWriteConflict" } };
    Reflect.set(prisma, "$transaction", async () => { calls++; throw conflict; });
    await assert.rejects(serializableTransaction(async () => 42), (error) => error === conflict);
    assert.equal(calls, 3);
    for (const error of [{ code: "P2002" }, new Error("TransactionWriteConflict"), { code: "08006" }]) {
      calls = 0;
      Reflect.set(prisma, "$transaction", async () => { calls++; throw error; });
      await assert.rejects(serializableTransaction(async () => 42), (thrown) => thrown === error);
      assert.equal(calls, 1);
    }
  } finally {
    Reflect.set(prisma, "$transaction", original);
    await prisma.$disconnect();
  }
});
