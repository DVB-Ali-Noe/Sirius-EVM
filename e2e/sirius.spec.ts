import { expect, test, type Page, type Route } from "playwright/test";

const PROVIDER = "rProviderE2e111111111111111111111";
const BORROWER = "rBorrowerE2e111111111111111111111";

interface DatasetFixture {
  id: string;
  name: string;
  description: string | null;
  provider: string;
  status: string;
  ipfsCid: string | null;
  runnerReceipt: string | null;
  merkleRoot: string | null;
  mptIssuanceId: string | null;
  sizeBytes: number;
  priceDrops: string;
  challengeDays: number;
  metrics: { rowCount: number; columnCount: number };
}

const ownedDataset: DatasetFixture = {
  id: "dataset-owned",
  name: "Crédit PME France",
  description: "Historique anonymisé",
  provider: PROVIDER,
  status: "LISTED",
  ipfsCid: "bafy-owned",
  runnerReceipt: "receipt-owned",
  merkleRoot: "merkle-owned",
  mptIssuanceId: "mpt-owned",
  sizeBytes: 1_250_000,
  priceDrops: "2500000",
  challengeDays: 7,
  metrics: { rowCount: 12_000, columnCount: 18 },
};

const listedDataset: DatasetFixture = {
  ...ownedDataset,
  id: "dataset-listed",
  name: "Mobilité urbaine Europe",
  description: "Trajets agrégés par zone",
  provider: PROVIDER,
  ipfsCid: "bafy-listed",
  runnerReceipt: "receipt-listed",
  merkleRoot: "merkle-listed",
  mptIssuanceId: "mpt-listed",
  priceDrops: "1750000",
  metrics: { rowCount: 48_000, columnCount: 24 },
};

async function preparePage(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("sirius-tour-seen", "1");
    localStorage.removeItem("sirius-ui");
    localStorage.removeItem("sirius-favorites");
  });
}

async function connect(page: Page, address: string, role: "provider" | "borrower") {
  await page.waitForFunction(() => Boolean(window.__SIRIUS_E2E__));
  await page.evaluate(
    ({ wallet, walletRole }) => window.__SIRIUS_E2E__?.connect(wallet, walletRole),
    { wallet: address, walletRole: role },
  );
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

test.beforeEach(async ({ page }) => {
  await preparePage(page);
});

test("affiche le tableau de bord d'un wallet authentifié", async ({ page }) => {
  await page.route("**/api/xrpl-rpc", (route) =>
    json(route, { result: { account_data: { Balance: "42500000" } } }),
  );
  await page.route("**/api/reputation", (route) =>
    json(route, {
      provider: { score: 50, completedLoans: 3, cancelledEscrows: 0, evidenceCount: 3 },
      borrower: { score: 25, completedLoans: 1, cancelledEscrows: 0, evidenceCount: 1 },
    }),
  );

  await page.goto("/dashboard");
  await connect(page, BORROWER, "borrower");

  await expect(page.getByRole("heading", { name: "Tableau de bord" })).toBeVisible();
  await expect(page.getByText("42,5")).toBeVisible();
  await expect(page.getByText("Confiance XRPL")).toBeVisible();
  await page.getByRole("link", { name: "Marketplace" }).first().click();
  await expect(page).toHaveURL(/\/marketplace$/);
});

test("récupère un brouillon interrompu et change la visibilité d'un dataset", async ({ page }) => {
  let datasets: DatasetFixture[] = [
    {
      ...ownedDataset,
      id: "dataset-draft",
      name: "Upload interrompu",
      status: "DRAFT",
      ipfsCid: null,
      runnerReceipt: null,
      merkleRoot: null,
      mptIssuanceId: null,
      sizeBytes: 0,
    },
    ownedDataset,
  ];
  let visibility: string | null = null;

  await page.route("**/api/datasets**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const draftEndpoint = url.pathname === "/api/datasets/dataset-draft";
    const ownedEndpoint = url.pathname === "/api/datasets/dataset-owned";

    if (request.method() === "GET" && url.pathname === "/api/datasets") {
      return json(route, datasets);
    }
    if (draftEndpoint && request.method() === "POST") {
      return json(route, { transaction: null });
    }
    if (draftEndpoint && request.method() === "DELETE") {
      datasets = datasets.filter((dataset) => dataset.id !== "dataset-draft");
      return json(route, {});
    }
    if (ownedEndpoint && request.method() === "PATCH") {
      visibility = (request.postDataJSON() as { visibility: string }).visibility;
      datasets = datasets.map((dataset) =>
        dataset.id === "dataset-owned" ? { ...dataset, status: visibility ?? dataset.status } : dataset,
      );
      return json(route, {});
    }
    return json(route, { error: "Route E2E inattendue" }, 500);
  });

  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/datasets");
  await connect(page, PROVIDER, "provider");

  await expect(page.getByText("Upload interrompu")).toBeVisible();
  await page.getByRole("button", { name: "Supprimer le brouillon" }).click();
  await expect(page.getByText("Upload interrompu")).toHaveCount(0);

  const privateButton = page.getByRole("button", { name: "Privé", exact: true });
  await privateButton.click();
  await expect.poll(() => visibility).toBe("PRIVATE");
  await expect(privateButton).toBeDisabled();
});

test("priorise les favoris du catalogue", async ({ page }) => {
  await page.route("**/api/datasets?status=LISTED", (route) =>
    json(route, [ownedDataset, listedDataset]),
  );

  await page.goto("/marketplace");
  await expect(page.getByText("Crédit PME France")).toBeVisible();

  const targetCard = page.locator("main").getByText("Mobilité urbaine Europe").locator("../..");
  await targetCard.getByRole("button", { name: "Ajouter aux favoris" }).click();

  await expect(page.locator("main h3").first()).toHaveText("Mobilité urbaine Europe");
  await expect(targetCard.getByRole("button", { name: "Retirer des favoris" })).toBeVisible();
});

test("affiche et réconcilie les états du parcours confidentiel", async ({ page }) => {
  let submissionStatus = "SUBMITTING";
  const loan = () => ({
    id: "loan-e2e",
    datasetId: listedDataset.id,
    amount: listedDataset.priceDrops,
    currency: "XRP",
    status: submissionStatus,
    escrowTxHash: submissionStatus === "ESCROWED" ? "ESCROW_TX" : null,
    escrowSequence: submissionStatus === "ESCROWED" ? 42 : null,
    settleTxHash: null,
    modelCid: null,
    runnerReceipt: null,
    cancelAfter: "2026-08-10T12:00:00.000Z",
    createdAt: "2026-08-03T12:00:00.000Z",
    dataset: { name: listedDataset.name, runnerReceipt: listedDataset.runnerReceipt },
  });

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "GET" && url.pathname === "/api/datasets") {
      return json(route, url.searchParams.get("status") === "LISTED" ? [listedDataset] : [ownedDataset]);
    }
    if (request.method() === "GET" && url.pathname === "/api/loans") {
      return json(route, [loan()]);
    }
    if (request.method() === "GET" && url.pathname === "/api/train") {
      return json(route, [
        {
          id: "job-done",
          status: "DONE",
          modelCid: "bafy-model",
          runnerReceipt: null,
          metrics: { r2: 0.9412 },
          createdAt: "2026-08-03T12:00:00.000Z",
          dataset: { name: ownedDataset.name },
        },
      ]);
    }
    if (request.method() === "POST" && url.pathname === "/api/loans/loan-e2e/submit") {
      submissionStatus = "ESCROWED";
      return json(route, {});
    }
    return json(route, { error: "Route E2E inattendue" }, 500);
  });

  await page.goto("/train");
  await connect(page, BORROWER, "borrower");

  await expect(page.getByText("Crédit PME France").first()).toBeVisible();
  await expect(page.getByText("Modèle livré")).toBeVisible();
  await page.getByRole("button", { name: "Réconcilier l’escrow" }).click();
  await expect(page.getByRole("button", { name: "Lancer le job (TEE)" })).toBeVisible();
});

test("présente une chaîne de preuves vérifiable sur XRPL", async ({ page }) => {
  const escrowTxHash = "A".repeat(64);
  const settleTxHash = "B".repeat(64);
  await page.route("**/api/audit", (route) =>
    json(route, {
      network: "testnet",
      loans: [
        {
          id: "loan-audit",
          borrower: BORROWER,
          provider: PROVIDER,
          amount: "1750000",
          currency: "XRP",
          status: "SETTLED",
          escrowTxHash,
          settleTxHash,
          cancelTxHash: null,
          attestationHash: "C".repeat(64),
          attestationComposeHash: "D".repeat(64),
          cancelAfter: "2026-08-10T12:00:00.000Z",
          createdAt: "2026-08-03T12:00:00.000Z",
          settledAt: "2026-08-03T12:05:00.000Z",
          dataset: {
            name: listedDataset.name,
            mptIssuanceId: "E".repeat(64),
            mptTxHash: "F".repeat(64),
          },
        },
      ],
    }),
  );

  await page.goto("/audit");
  await connect(page, BORROWER, "borrower");

  await expect(page.getByRole("heading", { name: "Registre d’audit" })).toBeVisible();
  await expect(page.getByText("Mobilité urbaine Europe")).toBeVisible();
  await expect(page.getByRole("link", { name: "Vérifier EscrowCreate sur XRPL" }))
    .toHaveAttribute("href", `https://testnet.xrpl.org/transactions/${escrowTxHash}`);
  await expect(page.getByRole("link", { name: "Vérifier EscrowFinish sur XRPL" }))
    .toHaveAttribute("href", `https://testnet.xrpl.org/transactions/${settleTxHash}`);
});
