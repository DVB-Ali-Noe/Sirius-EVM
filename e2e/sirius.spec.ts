import { expect, test, type Page, type Route } from "playwright/test";

const PROVIDER = "0x930f5a13d65b3e7e07431a38da30229562e3318b";
const BORROWER = "0x37f98be7c9d48b5d39e449616e7c70e37e29db13";

interface DatasetFixture {
  id: string;
  name: string;
  description: string | null;
  provider: string;
  status: "LISTED";
  sizeBytes: number;
  priceUsdcAtomic: string;
  challengeDays: number;
  metrics: { rowCount: number; columnCount: number };
}

const listedDataset: DatasetFixture = {
  id: "dataset-listed",
  name: "Mobilité urbaine Europe",
  description: "Trajets agrégés par zone",
  provider: PROVIDER,
  status: "LISTED",
  sizeBytes: 1_250_000,
  priceUsdcAtomic: "1750000",
  challengeDays: 7,
  metrics: { rowCount: 48_000, columnCount: 24 },
};

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

async function connect(page: Page, address: string, role: "provider" | "borrower") {
  await page.waitForFunction(() => Boolean(window.__SIRIUS_E2E__));
  await page.evaluate(
    ({ wallet, walletRole }) => window.__SIRIUS_E2E__?.connect(wallet, walletRole),
    { wallet: address, walletRole: role },
  );
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("sirius-tour-seen", "1");
    localStorage.removeItem("sirius-ui");
    localStorage.removeItem("sirius-favorites");
  });
});

test("affiche le tableau de bord EVM d'un wallet authentifié", async ({ page }) => {
  await page.route("**/api/reputation", (route) => json(route, {
    provider: { score: 50, completedLoans: 3, cancelledEscrows: 0, evidenceCount: 3 },
    borrower: { score: 25, completedLoans: 1, cancelledEscrows: 0, evidenceCount: 1 },
  }));

  await page.goto("/dashboard");
  await connect(page, BORROWER, "borrower");

  await expect(page.getByRole("heading", { name: "Tableau de bord" })).toBeVisible();
  await expect(page.getByText("Confiance EVM")).toBeVisible();
  await page.getByRole("link", { name: "Marketplace" }).first().click();
  await expect(page).toHaveURL(/\/marketplace$/);
});

test("priorise les favoris du catalogue USDC", async ({ page }) => {
  const another = { ...listedDataset, id: "dataset-other", name: "Crédit PME France", priceUsdcAtomic: "2500000" };
  await page.route("**/api/datasets?status=LISTED", (route) => json(route, [another, listedDataset]));

  await page.goto("/marketplace");
  await expect(page.getByText("Crédit PME France")).toBeVisible();
  await expect(page.getByText("1.75 USDC")).toBeVisible();

  const targetCard = page.locator("main").getByText("Mobilité urbaine Europe").locator("../..");
  await targetCard.getByRole("button", { name: "Ajouter aux favoris" }).click();
  await expect(page.locator("main h3").first()).toHaveText("Mobilité urbaine Europe");
});

test("présente des preuves vérifiables sur EVM", async ({ page }) => {
  const lockTxHash = `0x${"a".repeat(64)}`;
  const settleTxHash = `0x${"b".repeat(64)}`;
  const mintTxHash = `0x${"c".repeat(64)}`;
  await page.route("**/api/audit", (route) => json(route, {
    network: "testnet",
    loans: [{
      id: "loan-audit",
      borrower: BORROWER,
      provider: PROVIDER,
      amountUsdcAtomic: "1750000",
      status: "SETTLED",
      evmLockTxHash: lockTxHash,
      settleTxHash,
      auditTxHash: null,
      cancelTxHash: null,
      attestationHash: "d".repeat(64),
      attestationComposeHash: null,
      evmDeadline: "2026-08-10T12:00:00.000Z",
      createdAt: "2026-08-03T12:00:00.000Z",
      settledAt: "2026-08-03T12:05:00.000Z",
      dataset: {
        name: listedDataset.name,
        evmDatasetId: `0x${"e".repeat(64)}`,
        evmMintTxHash: mintTxHash,
      },
    }],
  }));

  await page.goto("/audit");
  await connect(page, BORROWER, "borrower");

  await expect(page.getByRole("heading", { name: "Registre d’audit" })).toBeVisible();
  await expect(page.getByText("1.75 USDC")).toBeVisible();
  await expect(page.getByRole("link", { name: "Vérifier Lock USDC sur EVM" }))
    .toHaveAttribute("href", `https://explorer.testnet.chain.robinhood.com/tx/${lockTxHash}`);
  await expect(page.getByRole("link", { name: "Vérifier Release USDC sur EVM" }))
    .toHaveAttribute("href", `https://explorer.testnet.chain.robinhood.com/tx/${settleTxHash}`);
});
