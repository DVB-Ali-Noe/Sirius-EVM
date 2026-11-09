import { expect, test, type Page } from "playwright/test";
import { mockSigningWallet } from "../helpers/wallet";

const owner = `0x${"12".repeat(20)}`;

async function mock(page: Page, phase = "closed", jobs: unknown[] = []) {
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/phala-demo/session") return route.fulfill({ json: { phase, available: phase === "open", sessionRevision: 1 } });
    if (path === "/api/train") return route.fulfill({ json: jobs });
    if (path === "/api/phala-demo/operator") return route.fulfill({ status: 403, json: { error: "Commande réservée aux opérateurs Sirius" } });
    return route.fulfill({ json: { authenticated: false, known: true } });
  });
}

async function connect(page: Page) {
  await page.waitForFunction(() => !!window.__SIRIUS_E2E__);
  await page.evaluate((address) => window.__SIRIUS_E2E__!.connect(address), owner);
}

async function operatorController(page: Page, code: string, allowed = true) {
  const received: string[] = [];
  await page.route("**/api/phala-demo/operator", (route) => {
    const sent = route.request().headers()["x-sirius-operator-code"] ?? "";
    received.push(sent);
    if (!allowed) return route.fulfill({ status: 403, json: { error: "Commande réservée aux opérateurs Sirius" } });
    if (sent !== code) return route.fulfill({ status: 403, json: { error: "Code opérateur invalide" } });
    return route.fulfill({ json: { revision: 1, phase: "closed", available: false, changedAt: 0, activeOperations: 0, usedOperations: 0, funding: "credits" } });
  });
  return received;
}

test("page fermée en anglais, exemple visible et conservé à la connexion, aucun lien opérateur", async ({ page }) => {
  await mock(page);
  await page.goto("/phala");
  await expect(page.getByText("Demo closed", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Use this example" }).first().click();
  await expect(page.getByText("✓ credit.csv")).toBeVisible();
  await connect(page);
  await expect(page.getByRole("button", { name: "Example selected ✓" })).toBeVisible();
  await expect(page.getByText("✓ credit.csv")).toBeVisible();
  await expect(page.getByLabel("Target column")).toHaveValue("defaulted");
  await expect(page.getByRole("button", { name: "Train with Phala" })).toBeDisabled();
  await expect(page.getByRole("link", { name: /operator/i })).toHaveCount(0);
});

test("CSV personnel : cible explicite et interface mobile sans débordement", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mock(page, "open"); await page.goto("/phala"); await connect(page);
  await page.getByLabel("Your CSV · 3 MB maximum").setInputFiles({ name: "personal.csv", mimeType: "text/csv", buffer: Buffer.from("target,feature\n2,1\n4,2") });
  await expect(page.getByText("✓ personal.csv")).toBeVisible();
  await page.getByLabel("Target column").selectOption("target");
  await expect(page.getByRole("button", { name: "Train with Phala" })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("aucun mode livré : pas de case « privé », chaque modèle reste dans Phala et répond pendant une session ouverte", async ({ page }) => {
  const job = (id: string, overrides: Record<string, unknown> = {}) => ({
    id, status: "DONE", servedModelId: id, metrics: { heldOutAuc: 0.81 }, dataset: { name: `Demo ${id}` },
    createdAt: "2026-10-30T10:00:00.000Z", completedAt: "2026-10-30T10:05:00.000Z", ...overrides,
  });
  await mock(page, "open", [job("served"), job("legacy", { servedModelId: null })]);
  await page.goto("/phala");
  await connect(page);
  await expect(page.getByRole("combobox", { name: "Model" }).locator('option[value="linear_regression"]')).toHaveCount(0);
  for (const model of ["logistic_regression", "gradient_boosted_trees"]) {
    await page.getByRole("combobox", { name: "Model" }).selectOption(model);
    await expect(page.getByRole("checkbox")).toHaveCount(0);
  }
  const served = page.getByRole("heading", { name: "Demo served", exact: true }).locator("../../..");
  await expect(served.getByRole("button", { name: "Request a prediction" })).toBeEnabled();
  await expect(served).toContainText("Private model · no download");
  // Un ancien job livré n'est plus listé : son modèle est indisponible.
  await expect(page.getByRole("heading", { name: "Demo legacy", exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /download/i })).toHaveCount(0);
});

test("session fermée : la prédiction reste visible mais inactive", async ({ page }) => {
  await mock(page, "closed", [{ id: "served", status: "DONE", servedModelId: "served", metrics: null, dataset: { name: "Demo served" },
    createdAt: "2026-10-30T10:00:00.000Z", completedAt: null }]);
  await page.goto("/phala");
  await connect(page);
  const served = page.getByRole("heading", { name: "Demo served", exact: true }).locator("../../..");
  await expect(served.getByRole("button", { name: "Request a prediction" })).toBeDisabled();
});

test("rapport de qualité sur la cible choisie : fuite signalée, cible non numérique annoncée, bouton actif", async ({ page }) => {
  await mock(page, "open"); await page.goto("/phala"); await connect(page);
  const rows = Array.from({ length: 120 }, (_, row) => `${row % 2},${row % 2},${(row * 37) % 101},${row === 5 ? "" : (row * 53) % 97}`);
  await page.getByLabel("Your CSV · 3 MB maximum").setInputFiles({ name: "leak.csv", mimeType: "text/csv", buffer: Buffer.from(`y,copy,noise,last\n${rows.join("\n")}`) });
  await page.getByLabel("Target column").selectOption("y");
  await expect(page.getByText("Variables that seem to copy the target: please check")).toBeVisible();
  await expect(page.getByText("copy · identical")).toBeVisible();
  await expect(page.getByText("Non-numeric target column: please check")).toHaveCount(0);
  await page.getByLabel("Target column").selectOption("last");
  await expect(page.getByText("Non-numeric target column: please check")).toBeVisible();
  await expect(page.getByText("Target differs from the last column: please check")).toHaveCount(0);
  await expect(page.getByText("Columns dropped by training: please check")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Train with Phala" })).toBeEnabled();
});

test("accès opérateur non listé : visiteur refusé même avec un code", async ({ page }) => {
  await mock(page); await operatorController(page, "operator-code-123", false);
  await page.goto("/operator");
  await expect(page.getByRole("button", { name: "Connect operator wallet" })).toBeVisible();
  await connect(page);
  await page.getByLabel("Access code").fill("operator-code-123");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "This command is restricted to Sirius operators" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Activate", exact: true })).toHaveCount(0);
});

test("accès opérateur : mauvais code refusé, bon code transmis à chaque requête", async ({ page }) => {
  await mock(page); const received = await operatorController(page, "operator-code-123");
  await page.goto("/operator"); await connect(page);
  await page.getByLabel("Access code").fill("wrong-code-456");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Invalid operator code" })).toBeVisible();
  await page.getByLabel("Access code").fill("operator-code-123");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page.getByRole("button", { name: "Activate", exact: true })).toBeEnabled();
  await expect(page.getByRole("main").getByRole("alert")).toHaveCount(0);
  // Au moins un tick de polling (5 s) : le code accompagne aussi les lectures périodiques.
  await expect.poll(() => received.length, { timeout: 8000 }).toBeGreaterThanOrEqual(3);
  expect(received[0]).toBe("wrong-code-456");
  expect(received.slice(1).every((sent) => sent === "operator-code-123")).toBe(true);
  await page.getByRole("button", { name: "Lock" }).click();
  await expect(page.getByLabel("Access code")).toBeVisible();
});

test("menu de choix du wallet puis signature, sans perdre l’exemple choisi", async ({ page }) => {
  const wallet = await mockSigningWallet(page, { api: async (path, route) => {
    if (path === "/api/phala-demo/session") return route.fulfill({ json: { phase: "open", available: true, sessionRevision: 1 } });
    if (path === "/api/train") return route.fulfill({ json: [] });
    return route.fulfill({ json: {} });
  } });
  await page.goto("/phala");
  await page.getByRole("button", { name: "Use this example" }).first().click();
  await expect(page.getByText("✓ credit.csv")).toBeVisible();
  const main = page.getByRole("main");
  await main.getByRole("button", { name: "Connect", exact: true }).click();
  await main.getByRole("menu").getByRole("button", { name: "Test Wallet", exact: true }).click();
  const signIn = main.getByRole("button", { name: "Sign in", exact: true });
  await expect(signIn).toBeVisible();
  expect(wallet.signatureCount()).toBe(0);
  await signIn.click();
  await expect.poll(wallet.signatureCount).toBe(1);
  await expect(page.getByRole("button", { name: "Train with Phala" })).toBeEnabled();
  await expect(page.getByText("✓ credit.csv")).toBeVisible();
});
