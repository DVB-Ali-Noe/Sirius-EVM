import { mock, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { borrowDataset } from "./client";
import { useWalletStore } from "@/stores/wallet";

const SOURCE = readFileSync(join(process.cwd(), "src", "lib", "loans", "client.ts"), "utf8");

test("le lock est réautorisé après confirmation de l'approbation USDC", async () => {
  const events: string[] = [];
  const stored = new Map<string, string>();
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: {
    ethereum: { request: async ({ method, params }: { method: string; params?: { data?: string }[] }) => {
      if (method === "eth_chainId") return "0xb626";
      if (method === "eth_getTransactionReceipt") { events.push("confirmed"); return { status: "0x1" }; }
      if (method === "eth_sendTransaction") { events.push(params?.[0].data ?? ""); return `0x${"11".repeat(32)}`; }
      throw new Error(method);
    } },
    sessionStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value); },
      removeItem: (key: string) => { stored.delete(key); },
    },
  } });
  useWalletStore.getState().setConnected("0x1111111111111111111111111111111111111111", "testnet", "external");
  useWalletStore.getState().setAuthenticated(true);
  mock.method(globalThis, "fetch", async (input: string) => {
    if (input === "/api/loans") return Response.json({ loanId: "loan-renew", approveTransaction: { data: "approve" }, lockTransaction: { data: "old-lock" } });
    if (input.endsWith("/authorize")) {
      events.push("renewed");
      return Response.json({ lockTransaction: { data: "fresh-lock" }, authorizationDeadline: Math.floor(Date.now() / 1_000) + 300 });
    }
    if (input.endsWith("/submit")) { events.push("submitted"); return Response.json({}); }
    throw new Error(input);
  });
  try {
    await borrowDataset({ datasetId: "dataset-renew" });
    assert.deepEqual(events, ["approve", "confirmed", "renewed", "fresh-lock", "submitted"]);
    assert.equal(stored.size, 0);
  } finally {
    mock.restoreAll();
    useWalletStore.getState().setDisconnected();
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});

test("le hash de lock est persisté et soumis immédiatement au serveur", () => {
  const borrow = SOURCE.slice(SOURCE.indexOf("export async function borrowDataset"), SOURCE.indexOf("export async function resumeLoanSubmission"));

  assert.ok(
    borrow.indexOf("window.sessionStorage.setItem") < borrow.indexOf("await submitLoanLock"),
    "un hash déjà signé doit rester récupérable si la confirmation tarde",
  );
  assert.doesNotMatch(borrow, /await waitForTransactionExternal/);
});

test("le règlement reprend après rechargement sans dépendre de la capsule locale", () => {
  const resumption = SOURCE.slice(SOURCE.indexOf("export async function resumeLoanSettlement"));

  assert.doesNotMatch(resumption, /hasAtomicLoanEnvelope|Capsule locale absente/);
  assert.match(resumption, /await settleLoan\(loanId, runnerReceipt\)/);
});
