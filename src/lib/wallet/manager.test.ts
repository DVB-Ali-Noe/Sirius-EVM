import assert from "node:assert/strict";
import { test } from "node:test";
import { displayAddress } from "@/lib/evm/address";
import {
  disconnectWallet,
  ensureExpectedChain,
  expectedChainId,
  sendTransactionExternal,
  waitForTransactionExternal,
  type Eip1193Provider,
} from "./manager";
import { EMBEDDED_RDNS, registerEmbeddedWallet } from "./discovery";

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

/**
 * Ces deux cas gardent la frontière que la connexion sociale a introduite dans `manager.ts`.
 *
 * Un portefeuille embarqué n'a ni permissions accordées à un site, ni sélecteur de comptes,
 * et sa liste de chaînes est figée. Trois méthodes `wallet_*` n'ont donc aucun sens pour lui,
 * et les lui envoyer échouerait en silence : la session resterait ouverte après une
 * déconnexion, ou la bascule de réseau ne se ferait jamais. Aucune des deux pannes ne
 * produit d'erreur visible, d'où ces tests.
 */
function avecSessionSociale(
  provider: Eip1193Provider,
  embarque: { switchChain?: () => Promise<void>; logout?: () => Promise<void> },
): () => void {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { localStorage: { getItem: () => EMBEDDED_RDNS } },
  });
  registerEmbeddedWallet({
    provider: () => provider,
    switchChain: async () => embarque.switchChain?.(),
    logout: async () => embarque.logout?.(),
  });
  return () => {
    // Le registre est global au module : le laisser garni ferait fuiter cette session
    // sociale dans les tests suivants.
    registerEmbeddedWallet({
      provider: () => null,
      switchChain: async () => {},
      logout: async () => {},
    });
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  };
}

test("la déconnexion ferme la session sociale au lieu de révoquer des permissions", async () => {
  const requests: string[] = [];
  let ferme = 0;
  const restaurer = avecSessionSociale(
    { request: async (r) => { requests.push(r.method); return null; } },
    { logout: async () => { ferme += 1; } },
  );

  try {
    await disconnectWallet();
  } finally {
    restaurer();
  }

  assert.equal(ferme, 1);
  assert.deepEqual(requests, []);
});

test("la bascule de réseau passe par le SDK quand la session est sociale", async () => {
  const requests: string[] = [];
  const bascules: string[] = [];
  const restaurer = avecSessionSociale(
    {
      request: async (r) => {
        requests.push(r.method);
        if (r.method === "eth_chainId") return "0x1";
        throw new Error(`Méthode inattendue : ${r.method}`);
      },
    },
    { switchChain: async () => { bascules.push(expectedChainId()); } },
  );

  try {
    await ensureExpectedChain();
  } finally {
    restaurer();
  }

  assert.deepEqual(bascules, [expectedChainId()]);
  assert.deepEqual(requests, ["eth_chainId"]);
});

test("un retrait invalidé pendant la vérification du réseau n'est pas envoyé", async () => {
  let invalidated = false;
  let sends = 0;
  const wallet: Eip1193Provider = {
    request: async ({ method }) => {
      if (method === "eth_chainId") { invalidated = true; return expectedChainId(); }
      sends++;
      return `0x${"12".repeat(32)}`;
    },
  };
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
  Object.defineProperty(globalThis, "window", { configurable: true, value: { ethereum: wallet } });
  try {
    await assert.rejects(sendTransactionExternal({}, "0x1111111111111111111111111111111111111111", () => {
      if (invalidated) throw new Error("Wallet changed");
    }), /Wallet changed/);
    assert.equal(sends, 0);
  } finally {
    if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
    else Reflect.deleteProperty(globalThis, "window");
  }
});
