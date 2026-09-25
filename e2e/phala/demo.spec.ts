import { expect, test, type Page } from "playwright/test";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { createCipheriv, createECDH, hkdfSync, randomBytes } from "node:crypto";

const owner = `0x${"12".repeat(20)}`;
const context = `self-train:${owner}:demo-job`;
let deliveryScript = "";

test.beforeAll(async () => {
  const require = createRequire(resolve(process.cwd(), "package.json"));
  const { build } = createRequire(require.resolve("tsx"))("esbuild");
  const result = await build({ entryPoints: ["src/lib/phala-demo/delivery-client.ts"], bundle: true, write: false, format: "esm", platform: "browser" });
  deliveryScript = result.outputFiles[0].text;
});

async function mock(page: Page, phase = "closed") {
  await page.addInitScript(() => localStorage.setItem("sirius-tour-seen", "1"));
  await page.route("**/__delivery-test.js", (route) => route.fulfill({ contentType: "application/javascript", body: deliveryScript }));
  await page.route("**/api/**", (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/phala-demo/session") return route.fulfill({ json: { phase, available: phase === "open", sessionRevision: 1 } });
    if (path === "/api/train") return route.fulfill({ json: [] });
    if (path === "/api/phala-demo/operator") return route.fulfill({ status: 403, json: { error: "Commande réservée aux opérateurs Sirius" } });
    return route.fulfill({ json: { authenticated: false, known: true } });
  });
}

async function connect(page: Page) {
  await page.waitForFunction(() => !!window.__SIRIUS_E2E__);
  await page.evaluate((address) => window.__SIRIUS_E2E__!.connect(address), owner);
}

test("page fermée, exemple présélectionné, visiteur refusé par l’opérateur", async ({ page }) => {
  await mock(page);
  await page.goto("/phala"); await connect(page);
  await expect(page.getByText("Démonstration fermée", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Utiliser cet exemple" }).first().click();
  await expect(page.getByLabel("Colonne à prédire")).toHaveValue("price_eur");
  await expect(page.getByRole("button", { name: "Entraîner avec Phala" })).toBeDisabled();
  await page.getByRole("link", { name: "Accès opérateurs" }).click();
  await expect(page.getByRole("alert").filter({ hasText: "Commande réservée aux opérateurs Sirius" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Activer", exact: true })).toHaveCount(0);
});

test("CSV personnel : cible explicite et interface mobile sans débordement", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mock(page, "open"); await page.goto("/phala"); await connect(page);
  await page.getByLabel("Ton CSV · 3 Mo maximum").setInputFiles({ name: "personal.csv", mimeType: "text/csv", buffer: Buffer.from("target,feature\n2,1\n4,2") });
  await page.getByLabel("Colonne à prédire").selectOption("target");
  await expect(page.getByRole("button", { name: "Entraîner avec Phala" })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("IndexedDB conserve la vraie clé non exportable après rechargement, Phala fermé", async ({ page }) => {
  await mock(page); await page.goto("/phala");
  const publicKey = await page.evaluate(async (address) => {
    const path = "/__delivery-test.js";
    const { prepareDemoDelivery } = await import(path);
    return (await prepareDemoDelivery("demo-job", address)).publicKey as string;
  }, owner);
  const ephemeral = createECDH("prime256v1"); ephemeral.generateKeys();
  const shared = ephemeral.computeSecret(Buffer.from(publicKey, "base64url"));
  const salt = randomBytes(16); const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(hkdfSync("sha256", shared, salt, Buffer.from(`sirius-runner-delivery-v1:${context}`), 32)), iv);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update("synthetic-model-key"), cipher.final(), cipher.getAuthTag()]);
  const envelope = { version: 1, ephemeralPublicKey: ephemeral.getPublicKey().toString("base64url"), salt: salt.toString("base64url"), iv: iv.toString("base64url"), ciphertext: ciphertext.toString("base64url") };
  await page.reload();
  const result = await page.evaluate(async ({ owner, publicKey, envelope }) => {
    const path = "/__delivery-test.js";
    const { openDemoDelivery } = await import(path);
    const value = await openDemoDelivery("demo-job", owner, publicKey, envelope);
    let denied = false;
    try { await openDemoDelivery("demo-job", `0x${"34".repeat(20)}`, publicKey, envelope); } catch { denied = true; }
    return { value, denied };
  }, { owner, publicKey, envelope });
  expect(result).toEqual({ value: "synthetic-model-key", denied: true });
});
