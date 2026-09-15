import { expect, test, type Page, type Route } from "playwright/test";
import { privateKeyToAccount } from "viem/accounts";
import { buildDelegationMessage } from "../src/lib/runner/authorization-contract";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const label = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const dataset = (owner: string, provider = A) => ({ id: `dataset-${owner}`, name: `Private dataset ${owner}`, provider, status: "PRIVATE", modelId: "linear_regression", modelVersion: "1.0.0", ipfsCid: "fixture", runnerReceipt: "receipt", evmDatasetId: `0x${"12".repeat(32)}`, sizeBytes: 100 });

declare global {
  interface Window {
    auditSwitch: () => void;
    auditReleaseBalance: () => void;
    auditBalanceHeld: boolean;
    auditSign: (message: `0x${string}`) => Promise<string>;
    auditTransactions: unknown[];
  }
}

async function connect(page: Page, address = A) {
  await page.waitForFunction(() => Boolean(window.__SIRIUS_E2E__));
  await page.evaluate(a => window.__SIRIUS_E2E__?.connect(a, "provider"), address);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("sirius-tour-seen", "1"));
});

test("Entraîner ignore la réponse privée d'un compte remplacé", async ({ page }) => {
  let ownerB = false;
  const delayed: Route[] = [];
  let requested!: () => void;
  const ready = new Promise<void>(r => { requested = r; });
  await page.route("**/api/**", route => {
    const url = new URL(route.request().url());
    if (url.pathname === "/api/datasets" && !url.search) {
      if (!ownerB) { delayed.push(route); requested(); return; }
      return route.fulfill({ json: [dataset("B", B)] });
    }
    return route.fulfill({ json: ["/api/datasets", "/api/loans", "/api/train"].includes(url.pathname) ? [] : { known: true } });
  });
  await page.goto("/train");
  await connect(page);
  await ready;
  ownerB = true;
  await connect(page, B);
  await expect(page.getByText("Private dataset B", { exact: true })).toBeVisible();
  await Promise.all(delayed.map(route => route.fulfill({ json: [dataset("A")] }).catch(() => {})));
  await expect(page.getByText("Private dataset A", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Private dataset B", { exact: true })).toBeVisible();
});

test("Audit remplace l'historique lors d'un changement de compte authentifié", async ({ page }) => {
  let owner = "A";
  await page.route("**/api/**", route => {
    if (new URL(route.request().url()).pathname !== "/api/audit") return route.fulfill({ json: { known: true } });
    return route.fulfill({ json: { network: "testnet", loans: [{ id: `loan-${owner}`, borrower: A, provider: B, amountUsdcAtomic: "1000000000000000000", modelId: "linear_regression", modelVersion: "1.0.0", status: "PENDING", createdAt: new Date().toISOString(), dataset: { name: `History ${owner}` } }] } });
  });
  await page.goto("/audit");
  await connect(page);
  await expect(page.getByText("History A", { exact: true })).toBeVisible();
  owner = "B";
  await connect(page, B);
  await expect(page.getByText("History B", { exact: true })).toBeVisible();
  await expect(page.getByText("History A", { exact: true })).toHaveCount(0);
});

for (const path of ["/wallet", "/dashboard"]) {
  test(`${path} conserve le solde de B lorsqu'une lecture tardive de A arrive`, async ({ page }) => {
    await page.route("**/api/**", route => route.fulfill({ json: { authenticated: false, known: true } }));
    await page.addInitScript(({ A, B }) => {
      const listeners = new Map<string, Set<(value: unknown) => void>>();
      let account = A;
      const pending: (() => void)[] = [];
      window.auditReleaseBalance = () => pending.forEach(release => release());
      window.auditSwitch = () => { account = B; listeners.get("accountsChanged")?.forEach(fn => fn([B])); };
      Object.defineProperty(window, "ethereum", { configurable: true, value: {
        async request({ method, params }: { method: string; params: { data: string }[] }) {
          if (["eth_accounts", "eth_requestAccounts"].includes(method)) return [account];
          if (method === "eth_chainId") return "0xb626";
          if (method === "eth_getBalance") return "0x0";
          if (method === "eth_call") {
            const forA = params[0].data.toLowerCase().endsWith(A.slice(2));
            if (forA) await new Promise<void>(r => { pending.push(r); window.auditBalanceHeld = true; });
            return `0x${((forA ? BigInt(111) : BigInt(22)) * BigInt(10) ** BigInt(18)).toString(16).padStart(64, "0")}`;
          }
          return [];
        },
        on(event: string, fn: (value: unknown) => void) { const group = listeners.get(event) ?? new Set(); group.add(fn); listeners.set(event, group); },
        removeListener(event: string, fn: (value: unknown) => void) { listeners.get(event)?.delete(fn); },
      } });
    }, { A, B });
    await page.goto(path);
    await page.waitForFunction(() => window.auditBalanceHeld);
    await page.evaluate(() => window.auditSwitch());
    await expect(page.getByText("22", { exact: true })).toBeVisible();
    await page.evaluate(() => window.auditReleaseBalance());
    await expect(page.getByText("111", { exact: true })).toHaveCount(0);
    await expect(page.getByText("22", { exact: true })).toBeVisible();
  });
}

test("un login tardif est invalidé si le wallet change pendant verify", async ({ page, baseURL }) => {
  const signer = privateKeyToAccount(`0x${"11".repeat(32)}`);
  const loginA = signer.address.toLowerCase();
  let verification!: Route;
  let requested!: () => void;
  const ready = new Promise<void>(r => { requested = r; });
  let logouts = 0;
  await page.exposeFunction("auditSign", (message: `0x${string}`) => signer.signMessage({ message: { raw: message } }));
  await page.addInitScript(({ loginA, B }) => {
    let account = loginA;
    const listeners = new Map<string, Set<(value: unknown) => void>>();
    window.auditSwitch = () => { account = B; listeners.get("accountsChanged")?.forEach(fn => fn([B])); };
    Object.defineProperty(window, "ethereum", { configurable: true, value: {
      async request({ method, params }: { method: string; params: `0x${string}`[] }) {
        if (["eth_accounts", "eth_requestAccounts"].includes(method)) return [account];
        if (method === "eth_chainId") return "0xb626";
        if (method === "personal_sign") return window.auditSign(params[0]);
        return [];
      },
      on(event: string, fn: (value: unknown) => void) { const group = listeners.get(event) ?? new Set(); group.add(fn); listeners.set(event, group); },
      removeListener(event: string, fn: (value: unknown) => void) { listeners.get(event)?.delete(fn); },
    } });
  }, { loginA, B });
  await page.route("**/api/**", route => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/challenge") return route.fulfill({ json: { challenge: buildDelegationMessage({ address: loginA, origin: baseURL!, sessionPublicKey: route.request().postDataJSON().runnerSessionPublicKey, network: "testnet", issuedAt: Date.now(), expiresAt: Date.now() + 60_000, challengeToken: "test.signature" }) } });
    if (path === "/api/auth/verify") { verification = route; requested(); return; }
    if (path === "/api/auth/logout") logouts++;
    return route.fulfill({ json: { authenticated: false, known: true } });
  });
  await page.goto("/docs");
  await page.getByRole("button", { name: label(loginA), exact: true }).click();
  await page.getByRole("button", { name: "Sign in", exact: false }).click();
  await ready;
  const before = logouts;
  await page.evaluate(() => window.auditSwitch());
  await expect(page.getByRole("button", { name: label(B), exact: true })).toBeVisible();
  await verification.fulfill({ json: { address: loginA, source: "external" } });
  await expect.poll(() => logouts).toBeGreaterThan(before);
  await expect(page.getByText("Authenticated", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Sign in", exact: false })).toBeEnabled();
});

for (const catalogue of [false, true]) {
  test(`Entraîner charge les datasets après la première page (${catalogue ? "catalogue" : "privés"})`, async ({ page }) => {
    await page.route("**/api/**", route => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/datasets" && url.searchParams.has("status") === catalogue) {
        const second = url.searchParams.has("cursor");
        return route.fulfill({ json: [dataset(second ? "25" : "1", catalogue ? B : A)], headers: second ? {} : { "x-sirius-next-cursor": "page-2" } });
      }
      return route.fulfill({ json: ["/api/datasets", "/api/loans", "/api/train"].includes(url.pathname) ? [] : { known: true } });
    });
    await page.goto("/train");
    await connect(page);
    await page.getByRole("button", { name: "Show more", exact: true }).click();
    await expect(page.getByText("Private dataset 25", { exact: true })).toBeVisible();
    await expect(page.getByText("Private dataset 1", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Show more", exact: true })).toHaveCount(0);
  });
}

for (const succeeds of [true, false]) {
  test(`Wallet retire le crédit de l'ancien escrow, confirmation=${succeeds}`, async ({ page }) => {
    const oldEscrow = `0x${"33".repeat(20)}`;
    let reads = 0;
    await page.addInitScript(({ succeeds }) => {
      window.auditTransactions = [];
      Object.defineProperty(window, "ethereum", { configurable: true, value: {
        async request({ method, params }: { method: string; params?: unknown[] }) {
          if (method === "eth_accounts") return [];
          if (method === "eth_chainId") return "0xb626";
          if (method === "eth_call") return `0x${BigInt(window.auditTransactions.length && succeeds ? "117000000000000000000" : "107000000000000000000").toString(16).padStart(64, "0")}`;
          if (method === "eth_getBalance") return "0x0";
          if (method === "eth_sendTransaction") { window.auditTransactions.push(params?.[0]); return `0x${"ab".repeat(32)}`; }
          if (method === "eth_getTransactionReceipt") return { status: succeeds ? "0x1" : "0x0" };
          return [];
        },
      } });
    }, { succeeds });
    await page.route("**/api/**", route => {
      if (new URL(route.request().url()).pathname === "/api/wallet/credits") {
        const amount = reads++ > 0 && succeeds ? "0" : "10";
        return route.fulfill({ json: { subject: A, credits: [{ escrow: oldEscrow, historical: true, available: true, atomic: amount, amount, transaction: { to: oldEscrow, data: "0x1234", value: "0x0" } }] } });
      }
      return route.fulfill({ json: { known: true, authenticated: false } });
    });
    await page.goto("/wallet");
    await connect(page);
    await expect(page.getByText("10 USDC", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Withdraw", exact: true }).click();
    const transactions = await page.evaluate(() => window.auditTransactions) as { from: string; to: string }[];
    expect(transactions).toHaveLength(1);
    expect(transactions[0].from.toLowerCase()).toBe(A);
    expect(transactions[0].to).toBe(oldEscrow);
    if (succeeds) {
      await expect(page.getByText("0 USDC", { exact: true })).toBeVisible();
      await expect(page.getByText("117", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "Withdraw", exact: true })).toBeDisabled();
    } else {
      await expect(page.locator("main [role=alert]")).toBeVisible();
      await expect(page.getByText("10 USDC", { exact: true })).toBeVisible();
      expect(reads).toBe(1);
      await expect(page.getByRole("button", { name: "Withdraw", exact: true })).toBeEnabled();
    }
  });
}
