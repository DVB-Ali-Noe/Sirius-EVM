import { expect, test, type Page } from "playwright/test";

const ADDRESS = "0x2f9B9A9Eb5fEf4F4a2218984a6F27d9f4174D13D";
const SHORT = "0x2f9B…D13D";

test.describe.configure({ timeout: 90_000 });

declare global {
  interface Window {
    __SIRIUS_E2E__?: { connect: (address: string, role?: string | null) => void };
  }
}

async function openApp(page: Page, path: string) {
  await page.route("**/api/**", (route) => route.fulfill({ json: { authenticated: false, known: true } }));
  await page.addInitScript(() => {
    localStorage.setItem("sirius-tour-seen", "1");
    // Solde de 12,5 jetons (18 décimales sur le testnet) pour la lecture du bouton profil.
    Object.defineProperty(window, "ethereum", {
      configurable: true,
      value: {
        async request({ method }: { method: string }) {
          if (method === "eth_chainId") return "0xb626";
          if (method === "eth_call") return `0x${(BigInt(125) * BigInt(10) ** BigInt(17)).toString(16).padStart(64, "0")}`;
          if (method === "eth_getBalance") return "0x0";
          return [];
        },
      },
    });
  });
  await page.goto(path);
  await page.waitForFunction(() => Boolean(window.__SIRIUS_E2E__));
  await page.evaluate((address) => window.__SIRIUS_E2E__?.connect(address, "provider"), ADDRESS);
}

test("le menu latéral n'a plus de lien Wallet", async ({ page }) => {
  await openApp(page, "/explorer");
  await expect(page.locator("aside").getByRole("link", { name: "Wallet", exact: true })).toHaveCount(0);
  await expect(page.locator("aside").getByRole("link", { name: "Explorer", exact: true })).toBeVisible();
});

test("le bouton profil donne le réseau, l'adresse, le solde et les liens, puis mène au Wallet", async ({ page }) => {
  await openApp(page, "/explorer");
  const button = page.getByTestId("profile-button");
  await expect(button).toContainText(SHORT);
  await expect(button).toHaveAttribute("aria-expanded", "false");
  await button.click();

  const panel = page.getByRole("dialog", { name: "Profile menu" });
  await expect(panel.getByTestId("network-badge")).toHaveText("Robinhood Chain testnet");
  await expect(panel.getByTestId("network-badge")).toHaveAttribute("data-network", "testnet");
  await expect(panel.getByTestId("profile-address")).toHaveText(SHORT);
  await expect(panel.getByTestId("profile-balance")).toHaveText("12.5 test USDC");
  const explorer = panel.getByRole("link", { name: "Explorer", exact: true });
  await expect(explorer).toHaveAttribute("href", `https://explorer.testnet.chain.robinhood.com/address/${ADDRESS}`);
  await expect(explorer).toHaveAttribute("rel", "noopener noreferrer");
  await expect(panel.getByRole("link", { name: "Settings", exact: true })).toHaveAttribute("href", "/settings");
  await expect(panel.getByRole("link", { name: "KYB", exact: true })).toHaveAttribute("href", "/kyb");
  await expect(panel.getByRole("button", { name: "Guided tour", exact: true })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Log out", exact: true })).toBeVisible();

  await panel.getByRole("link", { name: "Wallet", exact: true }).click();
  await expect(page).toHaveURL(/\/wallet$/);
  await expect(page.getByRole("dialog", { name: "Profile menu" })).toHaveCount(0);
});

test("Échap ferme le menu et rend le focus au bouton ; la visite guidée sans abonné le dit", async ({ page }) => {
  await openApp(page, "/explorer");
  await page.getByTestId("profile-button").click();
  const panel = page.getByRole("dialog", { name: "Profile menu" });
  await panel.getByRole("button", { name: "Guided tour", exact: true }).click();
  await expect(panel.getByRole("status")).toHaveText("The guided tour will be available soon.");
  await page.keyboard.press("Escape");
  await expect(panel).toHaveCount(0);
  await expect(page.getByTestId("profile-button")).toBeFocused();
});

test("un abonné à l'événement de visite guidée est prévenu et le menu se ferme", async ({ page }) => {
  await openApp(page, "/explorer");
  await page.evaluate(() => {
    (window as unknown as { tourStarts: number }).tourStarts = 0;
    window.addEventListener("sirius:guided-tour:start", (event) => {
      event.preventDefault();
      (window as unknown as { tourStarts: number }).tourStarts += 1;
    });
  });
  await page.getByTestId("profile-button").click();
  await page.getByRole("button", { name: "Guided tour", exact: true }).click();
  expect(await page.evaluate(() => (window as unknown as { tourStarts: number }).tourStarts)).toBe(1);
  await expect(page.getByRole("dialog", { name: "Profile menu" })).toHaveCount(0);
});

test("sur testnet, la page Wallet garde le faucet et n'affiche pas de QR code de réception", async ({ page }) => {
  await openApp(page, "/wallet");
  await expect(page.getByRole("button", { name: "Add funds", exact: true })).toBeVisible();
  await expect(page.getByTestId("receive-funds")).toHaveCount(0);
  await expect(page.getByTestId("receive-qr")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "View on explorer", exact: true }))
    .toHaveAttribute("href", `https://explorer.testnet.chain.robinhood.com/address/${ADDRESS}`);
});

test("sans connexion, aucun bouton profil", async ({ page }) => {
  await page.route("**/api/**", (route) => route.fulfill({ json: { authenticated: false, known: true } }));
  await page.addInitScript(() => localStorage.setItem("sirius-tour-seen", "1"));
  await page.goto("/explorer");
  await expect(page.getByTestId("profile-button")).toHaveCount(0);
});
