import { expect, test, type Page } from "playwright/test";
import { openLayoutPage } from "./helpers/layout";

const PROVIDER = "0x930f5a13d65b3e7e07431a38da30229562e3318b";
const dataset = {
  id: "dataset-valid-draft",
  name: "Valid draft",
  description: null,
  provider: PROVIDER,
  status: "DRAFT",
  ipfsCid: "bafy-fixture",
  evmDatasetId: null,
  sizeBytes: 15_000,
  metrics: { rowCount: 480, columnCount: 7 },
  modelId: "logistic_regression",
  modelVersion: "1.0.0",
};

const fixtures = [
  dataset,
  { ...dataset, id: "dataset-legacy-draft", name: "Legacy draft", modelId: null, modelVersion: null },
  { ...dataset, id: "dataset-invalid-version", name: "Invalid profile version", modelVersion: "0.1.0" },
  {
    ...dataset, id: "dataset-legacy-deleted", name: "Deleted legacy dataset", status: "DELETED",
    evmDatasetId: `0x${"a".repeat(64)}`, modelId: null, modelVersion: null,
  },
  {
    ...dataset, id: "dataset-legacy-suspended", name: "Suspended legacy dataset", status: "SUSPENDED",
    evmDatasetId: `0x${"b".repeat(64)}`, modelId: null, modelVersion: null,
  },
];

function card(page: Page, name: string) {
  return page.getByRole("heading", { name, exact: true }).locator("../../..");
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("sirius-tour-seen", "1");
    localStorage.setItem("sirius.locale", "fr");
    localStorage.removeItem("sirius-ui");
  });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/datasets") {
      await route.fulfill({ json: fixtures });
    } else if (path === "/api/account/status") {
      await route.fulfill({ json: { known: true } });
    } else {
      await route.abort();
    }
  });
  await openLayoutPage(page, "/datasets", 16);
  await page.evaluate((address) => window.__SIRIUS_E2E__?.connect(address, "provider"), PROVIDER);
  await expect(page.getByRole("heading", { name: "Valid draft", exact: true })).toBeVisible();
});

test("la publication exige un profil valide mais la suppression du brouillon reste accessible", async ({ page }) => {
  await expect(page.locator("html")).toHaveAttribute("lang", "en");
  await expect(card(page, "Valid draft").getByText("Binary logistic regression v1.0.0", { exact: true })).toBeVisible();
  for (const name of ["Legacy draft", "Invalid profile version"]) {
    const draft = card(page, name);
    await expect(draft.getByText("Missing profile", { exact: true })).toBeVisible();
    await expect(draft.getByRole("button", { name: "Re-upload required" })).toBeDisabled();
    await expect(draft.getByRole("button", { name: "Delete draft" })).toBeEnabled();
    await expect(draft.getByText(/Legacy dataset without a valid profile/)).toBeVisible();
  }
  await expect(card(page, "Valid draft").getByRole("button", { name: "Publish title" })).toBeEnabled();
});

test("un ancien dataset suspendu peut être supprimé sans être remis en publication", async ({ page }) => {
  const suspended = card(page, "Suspended legacy dataset");
  await expect(suspended.getByRole("button", { name: "Delete", exact: true })).toBeEnabled();
  await expect(suspended.getByRole("button", { name: "Public", exact: true })).toHaveCount(0);
  await expect(suspended.getByRole("button", { name: "Publish title" })).toHaveCount(0);
});

test("une erreur de finalisation garde la carte et permet de réessayer", async ({ page }) => {
  await page.route("**/api/datasets/dataset-legacy-deleted", async (route) => {
    expect(route.request().method()).toBe("POST");
    await route.fulfill({ status: 503, json: { error: "Contrats EVM Sirius indisponibles ou incompatibles" } });
  });
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toContain("current EVM registry");
    await dialog.accept();
  });
  const deleted = card(page, "Deleted legacy dataset");
  await deleted.getByRole("button", { name: "Finalize deletion" }).click();
  await expect(page.getByText("Sirius EVM contracts are unavailable or incompatible", { exact: true })).toBeVisible();
  await expect(deleted.getByRole("button", { name: "Finalize deletion" })).toBeEnabled();
});
