// N4 — page Train : catalogue retiré, self training réservé à l'équipe, états des emprunts,
// ré-entraînement et remboursement des échecs. L'API est simulée : aucun appel n'atteint la base.
import { generateKeyPairSync } from "node:crypto";
import { expect, test, type Page, type Route } from "playwright/test";
import { privateKeyToAccount } from "viem/accounts";
import { encodeAbiParameters, toFunctionSelector, type Hex } from "viem";
import { quoteAuthorizationTypedData, type ComputeQuote } from "@/lib/billing/quote";
import { mockSigningWallet, walletAddress } from "./helpers/wallet";

declare global {
  interface Window {
    trainSentTransactions: unknown[];
  }
}

const ME = "0x37f98be7c9d48b5d39e449616e7c70e37e29db13";
const OTHER = "0x2222222222222222222222222222222222222222";
const KEY = `0x${"9".repeat(64)}`;
const TX = `0x${"e".repeat(64)}`;

const ownDataset = {
  id: "own-dataset", name: "Équipe dataset", provider: ME, status: "PRIVATE", modelId: "logistic_regression", modelVersion: "1.0.0",
  ipfsCid: "bafy-fixture", runnerReceipt: "receipt", evmDatasetId: `0x${"12".repeat(32)}`, sizeBytes: 100, metrics: { rowCount: 200, columnCount: 4 },
};

function loan(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id, datasetId: `dataset-${id}`, borrower: ME, provider: OTHER, amountUsdcAtomic: "1000000000000000000",
    modelId: "logistic_regression", modelVersion: "1.0.0", status: "ESCROWED", evmLockTxHash: TX, evmLoanKey: KEY,
    settleTxHash: null, cancelTxHash: null, modelCid: null, runnerReceipt: null, evmDeadline: "2026-10-01T10:00:00.000Z",
    createdAt: "2026-09-25T10:00:00.000Z", dataset: { name: `Dataset ${id}`, runnerReceipt: null }, refundable: false, ...overrides,
  };
}

interface Options { admin?: boolean; loans?: unknown[]; jobs?: unknown[]; handle?: (route: Route, url: URL) => Promise<void> | undefined }

async function install(page: Page, { admin = false, loans = [], jobs = [], handle }: Options = {}) {
  const calls: string[] = [];
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url());
    calls.push(`${route.request().method()} ${url.pathname}${url.search}`);
    const custom = handle?.(route, url);
    if (custom) return custom;
    switch (url.pathname) {
      case "/api/admin/me": return route.fulfill({ json: { admin } });
      case "/api/loans": return route.fulfill({ json: loans });
      case "/api/datasets": return route.fulfill({ json: [ownDataset] });
      case "/api/train": return route.fulfill({ json: jobs });
      case "/api/auth/session": return route.fulfill({ json: { authenticated: false } });
      default: return route.fulfill({ json: { known: true } });
    }
  });
  return calls;
}

async function connect(page: Page) {
  await page.waitForFunction(() => Boolean(window.__SIRIUS_E2E__));
  await page.evaluate((address) => window.__SIRIUS_E2E__?.connect(address, "borrower"), ME);
}

const card = (page: Page, name: string) => page.getByRole("heading", { name, exact: true }).locator("../../../..");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.removeItem("sirius-ui"));
});

test("un non-admin ne voit ni catalogue ni self training, et lit l'encart de contact", async ({ page }) => {
  const calls = await install(page, { admin: false });
  await page.goto("/train");
  await connect(page);
  const contact = page.getByTestId("own-data-contact");
  await expect(contact).toHaveText("Want to train on your own data? Contact us at sirius.data.contact@gmail.com.", { timeout: 30_000 });
  await expect(contact.getByRole("link", { name: "sirius.data.contact@gmail.com" })).toHaveAttribute("href", "mailto:sirius.data.contact@gmail.com");
  await expect(page.getByTestId("self-training")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Catalog", exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "My data", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Borrow", exact: true })).toHaveCount(0);
  await expect(page.getByText("Équipe dataset")).toHaveCount(0);
  // Aucun appel de self training ni de catalogue n'est émis pour un non-admin.
  expect(calls.filter((call) => /\/api\/(datasets|train)/.test(call))).toEqual([]);
});

test("une réponse d'administration en erreur masque le self training et l'encart", async ({ page }) => {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/admin/me") return route.fulfill({ status: 500, json: { error: "boom" } });
    return route.fulfill({ json: path === "/api/loans" ? [] : { known: true } });
  });
  await page.goto("/train");
  await connect(page);
  await expect(page.getByText("No training run yet.")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("self-training")).toHaveCount(0);
  await expect(page.getByTestId("own-data-contact")).toHaveCount(0);
});

test("un admin garde le self training et ne voit pas l'encart de contact", async ({ page }) => {
  await install(page, { admin: true });
  await page.goto("/train");
  await connect(page);
  await expect(page.getByTestId("self-training")).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole("heading", { name: "Équipe dataset", exact: true })).toBeVisible();
  await expect(page.getByTestId("own-data-contact")).toHaveCount(0);
});

test("les emprunts affichent leur état lisible", async ({ page }) => {
  await install(page, {
    loans: [
      loan("a", { status: "SUBMITTING" }),
      loan("b", { status: "ESCROWED" }),
      loan("c", { status: "SETTLED", settleTxHash: TX, modelCid: "bafy" }),
      loan("d", { status: "ESCROWED", refundable: true }),
      loan("e", { status: "CANCELLED", cancelTxHash: TX }),
      loan("f", { status: "SETTLING", settleTxHash: TX, modelCid: "bafy", runnerReceipt: "receipt" }),
    ],
  });
  await page.goto("/train");
  await connect(page);
  await expect(card(page, "Dataset a")).toContainText("Payment awaiting finality", { timeout: 30_000 });
  await expect(card(page, "Dataset b")).toContainText("In progress");
  await expect(card(page, "Dataset c")).toContainText("Completed");
  await expect(card(page, "Dataset d")).toContainText("Failed");
  await expect(card(page, "Dataset e")).toContainText("Refunded");
  await expect(card(page, "Dataset f")).toContainText("Payment awaiting finality");
});

test("Retrain n'apparaît que sur un emprunt terminé de l'emprunteur, avec l'avertissement à côté", async ({ page }) => {
  await install(page, {
    loans: [
      loan("done", { status: "SETTLED", settleTxHash: TX, modelCid: "bafy" }),
      loan("running", { status: "TRAINING" }),
      loan("failed", { status: "ESCROWED", refundable: true }),
      loan("refunded", { status: "CANCELLED", cancelTxHash: TX }),
      loan("provider-view", { status: "SETTLED", settleTxHash: TX, modelCid: "bafy", borrower: OTHER, provider: ME }),
    ],
  });
  await page.goto("/train");
  await connect(page);
  const done = card(page, "Dataset done");
  await expect(done.getByRole("button", { name: "Retrain", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(done.getByTestId("retrain-panel")).toContainText("Training is deterministic: retraining on the same data gives the same model.");
  await expect(done.getByTestId("retrain-panel")).toContainText("Retrain only if the dataset has changed.");
  for (const name of ["running", "failed", "refunded", "provider-view"]) {
    await expect(card(page, `Dataset ${name}`).getByRole("button", { name: "Retrain", exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole("button", { name: "Retrain", exact: true })).toHaveCount(1);
});

test("la prédiction privée remplace la livraison : jobs servis et prêts réglés de l'emprunteur, sans téléchargement", async ({ page }) => {
  const job = (id: string, overrides: Record<string, unknown> = {}) => ({
    id, status: "DONE", servedModelId: id, metrics: { r2: 0.91 }, modelId: "linear_regression", modelVersion: "1.0.0",
    createdAt: "2026-09-25T10:00:00.000Z", dataset: { name: `Job ${id}` }, ...overrides,
  });
  const calls = await install(page, {
    admin: true,
    jobs: [job("served"), job("fields", { modelFeatures: ["surface_m2", "rooms"] }), job("legacy", { servedModelId: null }),
      job("running", { status: "RUNNING", servedModelId: null })],
    loans: [
      loan("done", { status: "SETTLED", settleTxHash: TX, modelCid: "sm1fixture", runnerReceipt: "receipt" }),
      loan("provider-view", { status: "SETTLED", settleTxHash: TX, modelCid: "sm1fixture", runnerReceipt: "receipt", borrower: OTHER, provider: ME }),
    ],
  });
  await page.goto("/train");
  await connect(page);
  const jobCard = (name: string) => page.getByRole("heading", { name, exact: true }).locator("../..");
  await expect(jobCard("Job served").getByRole("button", { name: "Request a prediction" })).toBeVisible({ timeout: 30_000 });
  await expect(jobCard("Job served").getByLabel("Numeric features (JSON, use the training column names)")).toHaveValue("{}");
  await expect(jobCard("Job legacy")).toContainText("Model unavailable: trained before private prediction.");
  await expect(jobCard("Job legacy").getByRole("button", { name: "Request a prediction" })).toHaveCount(0);
  await expect(jobCard("Job running").getByTestId("prediction-box")).toHaveCount(0);
  await expect(card(page, "Dataset done").getByRole("button", { name: "Request a prediction" })).toBeVisible();
  await expect(card(page, "Dataset done")).toContainText("Model fingerprint");
  await expect(card(page, "Dataset provider-view").getByTestId("prediction-box")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /download|verify/i })).toHaveCount(0);

  // Saisie invalide : refusée dans le navigateur, sans appel au serveur.
  await jobCard("Job served").getByLabel("Numeric features (JSON, use the training column names)").fill("[1, 2]");
  await jobCard("Job served").getByRole("button", { name: "Request a prediction" }).click();
  await expect(jobCard("Job served").getByRole("alert")).toHaveText("Enter a JSON object of numeric features");
  // Colonnes connues : une case par variable, et une case vide est refusée sans appel au serveur.
  const fields = jobCard("Job fields");
  await expect(fields.getByLabel("surface_m2")).toHaveValue("");
  await expect(fields.getByLabel("rooms")).toBeVisible();
  await fields.getByLabel("surface_m2").fill("84");
  await fields.getByRole("button", { name: "Request a prediction" }).click();
  await expect(fields.getByRole("alert")).toHaveText("Enter a numeric value for each feature");
  // Aucun appel de livraison : ni clé, ni modèle, ni prédiction au chargement.
  expect(calls.filter((call) => /\/key\b|\/api\/models\/|\/predict/.test(call))).toEqual([]);
});

test("location (D-29) : accès jusqu'à l'échéance, puis prédiction masquée et Prolonger tant que le modèle existe", async ({ page }) => {
  const DAY = 86_400_000;
  const at = (offset: number) => new Date(Date.now() + offset).toISOString();
  const settled = { status: "SETTLED", settleTxHash: TX, modelCid: "sm1fixture", runnerReceipt: "receipt" };
  const dataset = (id: string) => ({ name: `Dataset ${id}`, runnerReceipt: "receipt", maxRentalDays: 14, priceUsdcAtomic: "1000000" });
  await install(page, {
    loans: [
      loan("active", { ...settled, rentalDays: 7, rentalExpiresAt: at(3 * DAY), dataset: dataset("active") }),
      loan("expired", { ...settled, rentalDays: 7, rentalExpiresAt: at(-2 * DAY), dataset: dataset("expired") }),
      loan("deleted", { ...settled, rentalDays: 7, rentalExpiresAt: at(-31 * DAY), dataset: dataset("deleted") }),
      loan("legacy", { ...settled, rentalDays: null, rentalExpiresAt: null }),
      loan("extension", { ...settled, rentalDays: 3, rentalExpiresAt: null, extendsLoanId: "expired", dataset: dataset("extension") }),
    ],
  });
  await page.goto("/train");
  await connect(page);

  const active = card(page, "Dataset active");
  await expect(active.getByTestId("rental-access-until")).toContainText("Access to predictions until", { timeout: 30_000 });
  await expect(active).toContainText("Rented for");
  await expect(active.getByRole("button", { name: "Request a prediction" })).toBeVisible();
  await expect(active.getByTestId("rental-expired")).toHaveCount(0);

  const expired = card(page, "Dataset expired");
  await expect(expired.getByTestId("rental-expired")).toContainText("Predictions are stopped");
  await expect(expired.getByTestId("prediction-box")).toHaveCount(0);
  await expired.getByRole("button", { name: "Extend", exact: true }).click();
  const days = expired.getByLabel("Days to add");
  await expect(days).toHaveValue("1");
  await expect(days).toHaveAttribute("max", "14");
  await expect(expired.getByRole("button", { name: "See the quote and extend" })).toBeEnabled();

  const deleted = card(page, "Dataset deleted");
  await expect(deleted.getByTestId("rental-expired")).toContainText("the model was deleted from the enclave");
  await expect(deleted.getByRole("button", { name: "Extend", exact: true })).toHaveCount(0);
  await expect(deleted.getByTestId("prediction-box")).toHaveCount(0);

  // Prêt antérieur à D-29 : aucune échéance, prédiction toujours ouverte.
  const legacy = card(page, "Dataset legacy");
  await expect(legacy.getByRole("button", { name: "Request a prediction" })).toBeVisible();
  await expect(legacy.getByTestId("rental-access-until")).toHaveCount(0);

  // Ligne de prolongation : ni prédiction, ni réentraînement, ni lancement de job.
  const extension = card(page, "Dataset extension");
  await expect(extension).toContainText("Extension settled");
  await expect(extension.getByTestId("prediction-box")).toHaveCount(0);
  await expect(extension.getByRole("button", { name: "Retrain", exact: true })).toHaveCount(0);
});

test("Refund n'apparaît que pour un échec sans modèle utilisable, avec l'explication", async ({ page }) => {
  await install(page, {
    loans: [
      loan("failed", { status: "ESCROWED", refundable: true }),
      loan("in-time", { status: "ESCROWED", refundable: false }),
      loan("settled", { status: "SETTLED", settleTxHash: TX, modelCid: "bafy", refundable: true }),
      loan("prepared", { status: "TRAINING", modelCid: "bafy", runnerReceipt: "receipt", refundable: true }),
      loan("rescue", { status: "TRAINING", modelCid: "bafy", runnerReceipt: null, refundable: true }),
      loan("settling", { status: "SETTLING", settleTxHash: TX, modelCid: "bafy", runnerReceipt: "receipt", refundable: true }),
      loan("refunded", { status: "CANCELLED", cancelTxHash: TX, refundable: true }),
      loan("provider-view", { status: "ESCROWED", refundable: true, borrower: OTHER, provider: ME }),
    ],
  });
  await page.goto("/train");
  await connect(page);
  const failed = card(page, "Dataset failed");
  await expect(failed.getByRole("button", { name: "Refund", exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(failed.getByTestId("refund-explanation")).toContainText("no model was produced");
  await expect(failed.getByTestId("refund-explanation")).toContainText("everything you paid except, where applicable, the compute actually consumed, as measured by the enclave");
  // Échu avec modèle scellé (avec ou sans reçu) et sans release diffusé : le contrat refuse désormais le
  // règlement, remboursement de secours et plus de bouton « Finalize settlement » (audit A-05, A-10).
  for (const name of ["rescue", "prepared"]) {
    const stuck = card(page, `Dataset ${name}`);
    await expect(stuck.getByRole("button", { name: "Refund", exact: true })).toBeVisible();
    await expect(stuck.getByTestId("refund-explanation")).toContainText("settlement can no longer be completed");
    await expect(stuck).toContainText("Failed");
    await expect(stuck.getByRole("button", { name: "Finalize settlement", exact: true })).toHaveCount(0);
  }
  // Release déjà diffusé : réconciliation seulement, jamais de remboursement.
  await expect(card(page, "Dataset settling").getByRole("button", { name: "Reconcile settlement", exact: true })).toBeVisible();
  for (const name of ["in-time", "settled", "settling", "refunded", "provider-view"]) {
    await expect(card(page, `Dataset ${name}`).getByRole("button", { name: "Refund", exact: true })).toHaveCount(0);
  }
  await expect(page.getByRole("button", { name: "Refund", exact: true })).toHaveCount(3);
  await expect(page.getByTestId("refund-explanation")).toHaveCount(3);
});

// ——— API développeurs (D-30) : panneau API d'un prêt réglé ———

const DAY_MS = 86_400_000;
const settledApiLoan = (id: string, overrides: Record<string, unknown> = {}) => loan(id, {
  status: "SETTLED", settleTxHash: TX, modelCid: "sm1fixture", runnerReceipt: "receipt", modelId: "logistic_regression",
  rentalDays: 7, rentalExpiresAt: new Date(Date.now() + 3 * DAY_MS).toISOString(), apiEnabled: true, callsPerDay: 50,
  dataset: { name: `Dataset ${id}`, runnerReceipt: "receipt", maxRentalDays: 14, priceUsdcAtomic: "1750000000000000000" },
  usdcDecimals: 18, ...overrides,
});

const keysOverview = (overrides: Record<string, unknown> = {}) => ({
  keys: [], callsPerDay: 50, usage: { apiCallsToday: 3, creditsPurchased: 0 }, enclave: "running", ...overrides,
});

test("API : panneau absent pour la régression linéaire, avec l'explication ; absent sans quota d'API", async ({ page }) => {
  const calls = await install(page, {
    loans: [
      settledApiLoan("linear", { modelId: "linear_regression", apiEnabled: false, callsPerDay: null }),
      settledApiLoan("no-quota", { apiEnabled: false, callsPerDay: null }),
    ],
  });
  await page.goto("/train");
  await connect(page);
  const linear = card(page, "Dataset linear");
  await expect(linear.getByTestId("api-unavailable-linear")).toHaveText("API unavailable for linear regression (the model could be reconstructed).", { timeout: 30_000 });
  await expect(linear.getByTestId("api-panel")).toHaveCount(0);
  await expect(linear.getByRole("button", { name: "Create an API key" })).toHaveCount(0);
  // La prédiction depuis le site reste ouverte pour la linéaire.
  await expect(linear.getByRole("button", { name: "Request a prediction" })).toBeVisible();
  await expect(card(page, "Dataset no-quota").getByTestId("api-panel")).toHaveCount(0);
  expect(calls.filter((call) => call.includes("/api-keys"))).toEqual([]);
});

test("API : enclave en démarrage expliquée par étapes ; animation coupée sous prefers-reduced-motion", async ({ page }) => {
  await install(page, {
    loans: [settledApiLoan("starting")],
    handle: (route, url) => url.pathname === "/api/loans/starting/api-keys"
      ? route.fulfill({ json: keysOverview({ enclave: "starting", keys: [{ keyId: "k".repeat(22), name: "prod", createdAt: "2026-11-01T10:00:00.000Z", revokedAt: null, lastUsedAt: null, calls30d: 0 }] }) })
      : undefined,
  });
  await page.goto("/train");
  await connect(page);
  const panel = card(page, "Dataset starting").getByTestId("api-panel");
  const wait = panel.getByTestId("enclave-starting");
  await expect(wait).toContainText("Starting the secure enclave — about 2 minutes", { timeout: 30_000 });
  await expect(wait.locator('[data-step="requested"]')).toHaveAttribute("data-status", "done");
  await expect(wait.locator('[data-step="booting"]')).toHaveAttribute("data-status", "active");
  await expect(panel.getByTestId("enclave-starting-progress")).toContainText(/^Waiting: /);
  await expect(panel.getByTestId("enclave-starting-close-note")).toContainText("the SDK retries on its own");
  const spinner = wait.locator('[data-motion="spin"]');
  await expect.poll(() => spinner.evaluate((element) => getComputedStyle(element).animationName)).not.toBe("none");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect.poll(() => spinner.evaluate((element) => getComputedStyle(element).animationName)).toBe("none");
});

function ingressPublicKey(): string {
  const { publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return publicKey.export({ type: "spki", format: "der" }).subarray(-65).toString("base64url");
}

async function signIn(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("button", { name: "Test Wallet", exact: true }).click();
  await page.getByRole("button", { name: `${walletAddress.slice(0, 6)}…${walletAddress.slice(-4)}`, exact: true }).click();
  await page.getByRole("button", { name: "Sign in", exact: false }).click();
  await expect(page.getByRole("menu")).toBeHidden();
}

test("API : créer une clé (enclave qui démarre puis scellement), secret affiché une seule fois, puis révocation", async ({ page }) => {
  const LOAN = "keys";
  const keys: Array<Record<string, unknown>> = [];
  const posts: Array<Record<string, unknown>> = [];
  let deletes = 0;
  let prepares = 0;
  await mockSigningWallet(page, {
    api: async (path, route) => {
      const request = route.request();
      if (path === "/api/loans") return route.fulfill({ json: [settledApiLoan("keys", { borrower: walletAddress })] });
      if (path === `/api/loans/${LOAN}/api-keys` && request.method() === "GET") return route.fulfill({ json: keysOverview({ keys }) });
      if (path === `/api/loans/${LOAN}/api-keys` && request.method() === "POST") {
        const body = request.postDataJSON() as Record<string, unknown>;
        if (!body.keyId) {
          // Premier essai : l'enclave démarre ; le navigateur attend Retry-After puis relance.
          if (prepares++ === 0) {
            return route.fulfill({
              status: 503,
              headers: { "Retry-After": "2" },
              json: { error: { code: "enclave_starting", message: "L’enclave démarre" }, code: "enclave_starting", status: "starting", retryAfterSeconds: 2 },
            });
          }
          return route.fulfill({ json: { ingressKey: { version: 1, publicKey: ingressPublicKey(), origin: new URL(request.url()).origin } } });
        }
        posts.push(body);
        const created = { keyId: body.keyId, name: body.name, createdAt: new Date().toISOString(), revokedAt: null, lastUsedAt: null, calls30d: 0 };
        keys.push(created);
        return route.fulfill({ status: 201, json: { keyId: body.keyId, name: body.name, createdAt: created.createdAt } });
      }
      if (path.startsWith(`/api/loans/${LOAN}/api-keys/`) && request.method() === "DELETE") {
        deletes++;
        const keyId = decodeURIComponent(path.split("/").pop()!);
        const revokedAt = new Date().toISOString();
        for (const key of keys) if (key.keyId === keyId) key.revokedAt = revokedAt;
        return route.fulfill({ json: { keyId, revokedAt } });
      }
      if (path === "/api/admin/me") return route.fulfill({ json: { admin: false } });
      return route.fulfill({ json: {} });
    },
  });
  await signIn(page);
  await page.goto("/train");
  const panel = card(page, "Dataset keys").getByTestId("api-panel");
  await expect(panel).toContainText("No API key for this loan.", { timeout: 30_000 });
  await expect(panel.getByTestId("api-usage")).toContainText("3 / 50");
  await expect(panel.getByRole("link", { name: "API documentation" })).toHaveAttribute("href", "/docs/api");

  await panel.getByRole("button", { name: "Create an API key" }).click();
  const dialog = page.getByTestId("create-api-key-dialog");
  await dialog.getByLabel("Key name").fill("production server");
  await dialog.getByRole("button", { name: "Create key" }).click();
  await expect(dialog.getByTestId("api-key-enclave-starting")).toContainText("Starting the secure enclave");
  await expect(dialog.getByTestId("api-key-steps").locator('[data-step="preparing"]')).toHaveAttribute("data-status", "active");

  const secret = dialog.getByTestId("api-key-secret");
  await expect(secret).toHaveText(/^sk_live_[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}$/, { timeout: 30_000 });
  await expect(dialog.getByRole("alert")).toContainText("it will never be shown again");
  const token = (await secret.textContent())!;
  const [keyId, plain] = token.slice("sk_live_".length).split(".");
  expect(prepares).toBe(2);
  expect(posts).toHaveLength(1);
  expect(posts[0].keyId).toBe(keyId);
  expect(posts[0].name).toBe("production server");
  expect(Object.keys(posts[0].envelope as object).sort()).toEqual(["ciphertext", "ephemeralPublicKey", "iv", "salt", "version"]);
  expect((posts[0].authorization as { payload: { operation: string; loanId: string } }).payload).toMatchObject({ operation: "register-api-key", loanId: LOAN });
  // Le secret ne part jamais en clair : seulement chiffré pour l'enclave.
  expect(JSON.stringify(posts[0])).not.toContain(plain);

  await dialog.getByRole("button", { name: "I copied the key" }).click();
  await expect(page.getByTestId("create-api-key-dialog")).toHaveCount(0);
  await expect(page.getByText(token)).toHaveCount(0);
  const row = panel.getByTestId("api-key-row");
  await expect(row).toContainText("production server");
  await expect(row).toContainText("Never used");
  await expect(row).toContainText(`sk_live_${keyId}.…`);
  await expect(row).not.toContainText(plain);

  await row.getByRole("button", { name: "Revoke", exact: true }).click();
  await row.getByRole("button", { name: "Confirm revocation" }).click();
  await expect(row).toContainText("Revoked", { timeout: 30_000 });
  expect(deletes).toBe(1);
  await expect(row.getByRole("button", { name: "Revoke", exact: true })).toHaveCount(0);
});

const runner = privateKeyToAccount(`0x${"22".repeat(32)}`);
const ESCROW = "0x6666666666666666666666666666666666666666";
const USDC = "0x5555555555555555555555555555555555555555";
const hash32 = (n: number) => `0x${n.toString(16).padStart(64, "0")}` as Hex;

/** Faux wallet v7 : lectures de contrat encodées côté Node, transactions enregistrées (comme billing-v7.spec.ts). */
async function installV7Wallet(page: Page) {
  const reads: Record<string, Hex> = {
    [toFunctionSelector("function VERSION() view returns (string)")]: encodeAbiParameters([{ type: "string" }], ["sirius-escrow-usdc-v7"]),
    [toFunctionSelector("function lockAuthorizer() view returns (address)")]: encodeAbiParameters([{ type: "address" }], [runner.address]),
    [toFunctionSelector("function decimals() view returns (uint8)")]: encodeAbiParameters([{ type: "uint8" }], [18]),
  };
  await page.addInitScript(({ account, reads }) => {
    window.trainSentTransactions = [];
    Object.defineProperty(window, "ethereum", { configurable: true, value: {
      async request({ method, params }: { method: string; params?: unknown[] }) {
        if (["eth_accounts", "eth_requestAccounts"].includes(method)) return [account];
        if (method === "eth_chainId") return "0xb626";
        if (method === "eth_getBalance") return "0x0";
        if (method === "eth_blockNumber") return "0x10";
        if (method === "eth_call") {
          const data = String((params?.[0] as { data?: string })?.data ?? "0x").toLowerCase();
          return reads[data.slice(0, 10)] ?? `0x${"0".repeat(64)}`;
        }
        if (method === "eth_sendTransaction") {
          window.trainSentTransactions.push(params?.[0]);
          return `0x${"ab".repeat(32)}`;
        }
        throw new Error(`Requête wallet inattendue : ${method}`);
      },
      on() {},
      removeListener() {},
    } });
  }, { account: ME, reads });
}

test("API : acheter des appels — prix par pack, devis du pack, étapes d'attente ; pack payé suivi jusqu'au crédit", async ({ page }) => {
  const ORIGIN = "buyer";
  const PACK = "loan-pack-1000";
  const quote = {
    version: 7, chainId: 46630, escrow: ESCROW, usdc: USDC, usdcDecimals: 18, runner: runner.address.toLowerCase() as Hex,
    loanId: PACK, datasetId: `dataset-buyer`, onChainDatasetId: hash32(1), datasetReceiptHash: hash32(2), borrower: ME, provider: OTHER,
    computeRecipient: "0x7777777777777777777777777777777777777777", datasetAmount: "35000000000000000000", computeAmount: "100000000000000000",
    maxFailureFee: "0", executionRateAtomicPerMs: "16111111111", maxExecutionMs: 30000, maxDatasetBytes: 1_000_000, hashlock: hash32(3),
    challengeDays: 7, tariffVersion: "tarif-test", expiresAt: Math.floor(Date.now() / 1000) + 300, failurePolicy: "consumed-execution-only",
    modelId: "logistic_regression", modelVersion: "1.0.0", rentalDays: 7, callPack: 1000, packForLoanId: ORIGIN,
  } as unknown as ComputeQuote;
  const billingQuote = { quote, authorization: { deadline: quote.expiresAt, signature: await runner.signTypedData(quoteAuthorizationTypedData(quote)) } };
  const prepared: unknown[] = [];
  await installV7Wallet(page);
  await install(page, {
    loans: [
      settledApiLoan("buyer"),
      // Pack de 100 déjà payé, lock en attente de finalité : suivi sous le prêt d'origine.
      loan("pack-100", { status: "ESCROWED", packForLoanId: ORIGIN, callPack: 100, modelId: "logistic_regression", usdcDecimals: 18 }),
    ],
    handle: (route, url) => {
      if (url.pathname === `/api/loans/${ORIGIN}/api-keys`) return route.fulfill({ json: keysOverview() });
      if (url.pathname === `/api/loans/${ORIGIN}/calls`) {
        prepared.push(route.request().postDataJSON());
        return route.fulfill({ status: 201, json: { loanId: PACK, approveTransaction: { to: USDC, data: "0x" }, lockTransaction: { to: ESCROW, data: "0x" }, billingQuote } });
      }
      if (url.pathname === "/api/reputation") return route.fulfill({ json: {} });
      return undefined;
    },
  });
  await page.goto("/train");
  await connect(page);
  const origin = card(page, "Dataset buyer");
  const pending = origin.getByTestId("call-pack-pending");
  await expect(pending).toContainText("Pack of 100 calls in progress", { timeout: 30_000 });
  await expect(pending.locator('[data-step="payment"]')).toHaveAttribute("data-status", "done");
  await expect(pending.locator('[data-step="finality"]')).toHaveAttribute("data-status", "active");
  await expect(pending).toContainText("You can close this page");
  // La ligne du pack n'entraîne rien : ni lancement de job, ni réentraînement.
  const packCard = card(page, "Dataset pack-100");
  await expect(packCard).toContainText("Call pack");
  await expect(packCard.getByRole("button", { name: "Run job (TEE)" })).toHaveCount(0);

  await origin.getByRole("button", { name: "Buy calls" }).click();
  const buy = origin.getByTestId("buy-calls");
  // ceil(1,75 / 50) = 0,035 par appel : 3,5 / 35 / 350 test USDC.
  await expect(buy.getByText("3.5 test USDC", { exact: true })).toBeVisible();
  await expect(buy.getByText("35 test USDC", { exact: true })).toBeVisible();
  await expect(buy.getByText("350 test USDC", { exact: true })).toBeVisible();
  await buy.getByText("1,000 calls", { exact: true }).click();
  await buy.getByRole("button", { name: "See the quote and buy" }).click();

  const dialog = page.getByRole("dialog", { name: "Call pack quote" });
  await expect(dialog).toBeVisible({ timeout: 30_000 });
  await expect(dialog).toContainText("Calls purchased");
  await expect(dialog).toContainText("1,000");
  await expect(dialog.getByText("35 test USDC", { exact: true })).toBeVisible();
  await expect(dialog).toContainText("expire with the rental and are not refundable");
  expect(prepared).toEqual([{ size: 1000 }]);
  const steps = buy.getByTestId("buy-calls-steps");
  await expect(steps.locator('[data-step="quote"]')).toHaveAttribute("data-status", "done");
  await expect(steps.locator('[data-step="accept"]')).toHaveAttribute("data-status", "active");
  await expect(steps.locator('[data-step="payment"]')).toHaveAttribute("data-status", "pending");

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(buy.getByTestId("buy-calls-steps")).toHaveCount(0);
  expect(await page.evaluate(() => window.trainSentTransactions)).toHaveLength(0);
});
