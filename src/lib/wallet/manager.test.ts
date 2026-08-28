import assert from "node:assert/strict";
import { test } from "node:test";
import { displayAddress } from "@/lib/evm/address";
import { expectedChainId, sendTransactionExternal, waitForTransactionExternal, type Eip1193Provider } from "./manager";

test("eth_sendTransaction reçoit explicitement le compte actif", async () => {
  const requests: Array<{ method: string; params?: unknown[] | object }> = [];
  const wallet: Eip1193Provider = {
    request: async (request) => {
      requests.push(request);
      if (request.method === "eth_chainId") return expectedChainId();
      if (request.method === "eth_sendTransaction") return `0x${"12".repeat(32)}`;
      throw new Error(`Méthode inattendue : ${request.method}`);
    },
  };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { ethereum: wallet } });
  const address = "0x2f9b9a9eb5fef4f4a2218984a6f27d9f4174d13d";

  try {
    await sendTransactionExternal({ to: "0x1111111111111111111111111111111111111111", data: "0x1234" }, address);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }

  assert.deepEqual(requests.at(-1), {
    method: "eth_sendTransaction",
    params: [{ to: "0x1111111111111111111111111111111111111111", data: "0x1234", from: displayAddress(address) }],
  });
});

test("la confirmation wallet attend un reçu miné", async () => {
  let reads = 0;
  const wallet: Eip1193Provider = {
    request: async (request) => {
      if (request.method !== "eth_getTransactionReceipt") throw new Error(`Méthode inattendue : ${request.method}`);
      reads += 1;
      return reads === 1 ? null : { status: "0x1" };
    },
  };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { ethereum: wallet } });

  try {
    await waitForTransactionExternal(`0x${"34".repeat(32)}`, 0);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }

  assert.equal(reads, 2);
});

test("une transaction en attente trop longue reste récupérable", async () => {
  const wallet: Eip1193Provider = {
    request: async () => null,
  };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { ethereum: wallet } });

  try {
    await assert.rejects(
      () => waitForTransactionExternal(`0x${"56".repeat(32)}`, 0, 0),
      /toujours en attente/,
    );
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
