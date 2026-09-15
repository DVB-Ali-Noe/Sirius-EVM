import { expect, test, type Page } from "playwright/test";
import { verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { buildDelegationMessage } from "@/lib/runner/authorization-contract";

const account = privateKeyToAccount(`0x${"11".repeat(32)}`);
const address = account.address.toLowerCase();
const walletLabel = `${address.slice(0, 6)}…${address.slice(-4)}`;

async function mockWallet(page: Page, options: {
  connected?: boolean;
  rejectFirstSignature?: boolean;
  challengeError?: string;
} = {}) {
  let authenticated = false;
  let signatures = 0;
  await page.exposeFunction("signWalletMessage", async (message: `0x${string}`) => {
    signatures += 1;
    return account.signMessage({ message: { raw: message } });
  });
  await page.addInitScript(({ walletAddress, settings }) => {
    localStorage.setItem("sirius-tour-seen", "1");
    let connected = settings.connected || localStorage.getItem("test.wallet.connected") === "1";
    let rejectedSignature = false;
    const wallet = {
      async request({ method, params }: { method: string; params?: unknown[] }) {
        if (method === "eth_chainId") return "0xb626";
        if (method === "eth_accounts") return connected ? [walletAddress] : [];
        if (method === "wallet_requestPermissions") {
          return [];
        }
        if (method === "eth_requestAccounts") {
          connected = true;
          localStorage.setItem("test.wallet.connected", "1");
          return [walletAddress];
        }
        if (method === "personal_sign") {
          if (settings.rejectFirstSignature && !rejectedSignature) {
            rejectedSignature = true;
            throw { code: 4001, message: "Signature rejected" };
          }
          return (window as unknown as { signWalletMessage: (message: unknown) => Promise<string> })
            .signWalletMessage(params?.[0]);
        }
        throw new Error(`Unexpected wallet request: ${method}`);
      },
    };
    Object.defineProperty(window, "ethereum", { configurable: true, value: wallet });
    window.addEventListener("eip6963:requestProvider", () => {
      window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
        detail: {
          info: { uuid: "test-wallet", rdns: "test.wallet", name: "Test Wallet", icon: "" },
          provider: wallet,
        },
      }));
    });
  }, { walletAddress: address, settings: options });

  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/session") {
      return route.fulfill({ json: { authenticated, address: authenticated ? address : null } });
    }
    if (path === "/api/auth/challenge") {
      if (options.challengeError) return route.fulfill({ status: 403, json: { error: options.challengeError } });
      const { runnerSessionPublicKey } = route.request().postDataJSON();
      return route.fulfill({ json: {
        challenge: buildDelegationMessage({
          address,
          origin: new URL(route.request().url()).origin,
          sessionPublicKey: runnerSessionPublicKey,
          network: "testnet",
          issuedAt: Date.now(),
          expiresAt: Date.now() + 60_000,
          challengeToken: "test.signature",
        }),
      } });
    }
    if (path === "/api/auth/verify") {
      const { message, signature } = route.request().postDataJSON();
      authenticated = await verifyMessage({ address: account.address, message, signature });
      return route.fulfill({ status: authenticated ? 200 : 401, json: { address, source: "external" } });
    }
    if (path === "/api/auth/logout") {
      authenticated = false;
      return route.fulfill({ json: {} });
    }
    if (path === "/api/account/status") return route.fulfill({ json: { known: true } });
    return route.fulfill({ json: {} });
  });
  return { signatureCount: () => signatures };
}

async function openAccount(page: Page) {
  await page.getByRole("button", { name: walletLabel, exact: true }).click();
}

test("permet de signer depuis l’accueil sans redirection automatique", async ({ page }) => {
  const wallet = await mockWallet(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: "Test Wallet", exact: true }).click();
  await openAccount(page);
  await page.getByRole("button", { name: "Sign in", exact: false }).click();
  await expect.poll(wallet.signatureCount).toBe(1);
  await expect(page.getByRole("menu")).toBeHidden();
  await openAccount(page);
  await expect(page.getByText("Authenticated", { exact: true })).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test("garde l’accueil et la session après plusieurs rechargements", async ({ page }) => {
  const wallet = await mockWallet(page, { connected: true });
  await page.goto("/docs");
  await openAccount(page);
  await page.getByRole("button", { name: "Sign in", exact: false }).click();
  await expect(page.getByRole("menu")).toBeHidden();
  await page.getByRole("link", { name: "Sirius", exact: true }).click();
  await expect(page).toHaveURL(/\/$/);
  for (let reload = 0; reload < 2; reload += 1) {
    await page.reload();
    await openAccount(page);
    await expect(page.getByText("Authenticated", { exact: true })).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  }
  expect(wallet.signatureCount()).toBe(1);
});

test("affiche la cause du refus du challenge", async ({ page }) => {
  await mockWallet(page, { connected: true, challengeError: "Origine de requête non autorisée" });
  await page.goto("/docs");
  await openAccount(page);
  await page.getByRole("button", { name: "Sign in", exact: false }).click();
  await expect(page.getByRole("menu").getByRole("alert")).toHaveText("Request origin not allowed");
});

test("permet de réessayer après une signature refusée", async ({ page }) => {
  const wallet = await mockWallet(page, { connected: true, rejectFirstSignature: true });
  await page.goto("/docs");
  await openAccount(page);
  await page.getByRole("button", { name: "Sign in", exact: false }).click();
  await expect(page.getByRole("menu").getByRole("alert")).toContainText("rejected");
  await page.getByRole("button", { name: "Sign in", exact: false }).click();
  await expect(page.getByRole("menu")).toBeHidden();
  await openAccount(page);
  await expect(page.getByText("Authenticated", { exact: true })).toBeVisible();
  expect(wallet.signatureCount()).toBe(1);
});
