"use client";

import { useCallback, useEffect, useState } from "react";
import { EscrowCredits } from "@/components/wallet/EscrowCredits";
import { Card } from "@/components/ui/Card";
import { ConnectCta } from "@/components/wallet/ConnectCta";
import { SecureAccountCard } from "@/components/wallet/SecureAccount";
import { ReceiveFunds } from "@/components/wallet/ReceiveFunds";
import { addFundsOptions } from "@/components/wallet/add-funds";
import { normalizeAddress } from "@/components/profile/address";
import { useWalletStore } from "@/stores/wallet";
import { fetchGasBalance, fetchUsdcBalance, type GasBalance, type UsdcBalance } from "@/lib/evm/balance";
import { formatUsdcAtomic } from "@/lib/evm/usdc";
import { addFunds } from "@/lib/wallet/onramp";
import { addressExplorerUrl } from "@/lib/evm/explorer";
import { resolveClientNetwork } from "@/lib/evm/networks";
import { truncate } from "@/lib/format";
import { useLocale } from "@/components/i18n/LocaleProvider";

const NETWORK = resolveClientNetwork();

export default function WalletPage() {
  const identity = useWalletStore((state) => `${state.revision}:${state.authenticated}`);
  return <WalletPageContent key={identity} />;
}

function WalletPageContent() {
  const connected = useWalletStore((s) => s.connected);
  const address = useWalletStore((s) => s.address);
  const authenticated = useWalletStore((s) => s.authenticated);
  const starterFunds = useWalletStore((s) => s.starterFunds);
  const { locale, t } = useLocale();
  // Mainnet : réception par transfert (adresse + QR) en plus du pont. Testnet : faucet seul.
  const fundsOptions = addFundsOptions(NETWORK);
  const checksummed = normalizeAddress(address);

  const [balance, setBalance] = useState<UsdcBalance | null>(null);
  const [gas, setGas] = useState<GasBalance | null>(null);
  const [balError, setBalError] = useState(false);

  const [fundsPending, setFundsPending] = useState(false);
  const [fundsMessage, setFundsMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!address) return;
    setBalError(false);
    try {
      const [usdc, natif] = await Promise.all([
        fetchUsdcBalance(address),
        fetchGasBalance(address).catch(() => null),
      ]);
      setBalance(usdc);
      setGas(natif);
    } catch {
      setBalError(true);
    }
  }, [address]);

  const handleAddFunds = async () => {
    setFundsPending(true);
    setFundsMessage(null);
    try {
      const recu = await addFunds();
      setFundsMessage(
        recu.eth
          ? t("{usdc} USDC et {eth} ETH envoyés.", { usdc: recu.usdc, eth: recu.eth })
          : t("{usdc} USDC envoyés.", { usdc: recu.usdc }),
      );
      await refresh();
      // Sans cet effacement, la confirmation restait à l'écran indéfiniment. Le solde
      // continuait de bouger — un emprunt, un retrait — et « 1000 USDC envoyés » finissait
      // affiché à côté d'un solde qui ne correspondait plus, ce qui se lit comme un échec
      // du virement alors qu'il a bien eu lieu.
      window.setTimeout(() => setFundsMessage(null), 8_000);
    } catch (err) {
      setFundsMessage(t(err instanceof Error ? err.message : "Ajout de fonds indisponible"));
    } finally {
      setFundsPending(false);
    }
  };

  useEffect(() => {
    // `authenticated` en dépendance, et pas seulement l'adresse : la première signature
    // déclenche l'attestation KYB puis, sur un compte neuf, l'approvisionnement. Les deux
    // arrivent après ce premier affichage, et sans cette relecture l'utilisateur resterait
    // devant un solde nul alors que les fonds sont déjà sur la chaîne.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch initial, setState post-await
    refresh();
  }, [refresh, authenticated]);

  if (!connected || !address) {
    return (
      <main className="mx-auto w-full max-w-xl px-6 py-8">
        <Card className="flex flex-col items-start gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Wallet</h1>
            <p className="mt-1 text-sm text-muted">{t("Connecte un wallet pour voir ton solde.")}</p>
          </div>
          <ConnectCta>{t("Connecter un wallet")}</ConnectCta>
        </Card>
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-xl px-6 py-8">
      <div className="mb-8">
        <h1 className="text-2xl font-semibold tracking-tight">Wallet</h1>
        <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 font-mono text-sm text-muted">
          <span>{truncate(address)}</span>
          {checksummed && (
            <a
              href={addressExplorerUrl(NETWORK, checksummed)}
              target="_blank"
              rel="noopener noreferrer"
              className="font-sans text-xs underline-offset-2 transition-colors hover:text-foreground hover:underline"
            >
              {t("Voir sur l’explorateur")}
            </a>
          )}
        </p>
      </div>

      <Card className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-wider text-muted">{t("Solde")}</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-3xl font-semibold tracking-tight">
              {balError ? "—" : balance ? Number(formatUsdcAtomic(balance.atomic)).toLocaleString(locale === "fr" ? "fr-FR" : "en-US", { maximumFractionDigits: 6 }) : "…"}
            </span>
            <span className="text-sm text-muted">{process.env.NEXT_PUBLIC_EVM_NETWORK === "mainnet" ? "USDC" : t("test USDC")}</span>
          </div>
          {gas && (
            <p className={`mt-1.5 text-xs ${gas.low ? "text-negative" : "text-muted"}`}>
              {gas.low ? t("{eth} ETH — plus assez pour payer le gas", { eth: gas.eth }) : t("{eth} ETH pour le gas", { eth: gas.eth })}
            </p>
          )}
          {balError && <p className="mt-2 text-xs text-negative">{t("Solde indisponible.")}</p>}
        </div>
        <div className="flex flex-col items-end gap-2">
          <button
            onClick={handleAddFunds}
            disabled={fundsPending}
            className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90 disabled:opacity-50"
          >
            {fundsPending ? t("Envoi en cours…") : fundsOptions.faucet ? t("Ajouter des fonds") : t("Utiliser le pont")}
          </button>
          {fundsMessage && <p className="max-w-[16rem] text-right text-xs text-muted">{fundsMessage}</p>}
          {!fundsMessage && fundsOptions.faucet && typeof starterFunds === "object" && (
            <p className="max-w-[16rem] text-right text-xs text-negative">
              {t("Fonds de démarrage non reçus : {reason}", { reason: t(starterFunds.failed) })}
            </p>
          )}
        </div>
      </Card>

      {fundsOptions.transfer && <ReceiveFunds network={NETWORK} address={address} />}

      <EscrowCredits onWithdraw={refresh} />

      <SecureAccountCard />
    </main>
  );
}
