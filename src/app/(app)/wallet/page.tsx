"use client";

import { useCallback, useEffect, useState } from "react";
import { Card } from "@/components/ui/Card";
import { ConnectCta } from "@/components/wallet/ConnectCta";
import { SecureAccountCard } from "@/components/wallet/SecureAccount";
import { useWalletStore } from "@/stores/wallet";
import { fetchUsdcBalance, type UsdcBalance } from "@/lib/evm/balance";
import { formatUsdcAtomic } from "@/lib/evm/usdc";
import { sendPayment } from "@/lib/wallet/payment-client";
import { addFunds } from "@/lib/wallet/onramp";
import { messageOf } from "@/lib/errors-client";
import { truncate } from "@/lib/format";
import { useLocale } from "@/components/i18n/LocaleProvider";

export default function WalletPage() {
  const connected = useWalletStore((s) => s.connected);
  const address = useWalletStore((s) => s.address);
  const authenticated = useWalletStore((s) => s.authenticated);
  const { locale, t } = useLocale();

  const [balance, setBalance] = useState<UsdcBalance | null>(null);
  const [balError, setBalError] = useState(false);

  const [destination, setDestination] = useState("");
  const [amount, setAmount] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<string | null>(null);
  const [fundsPending, setFundsPending] = useState(false);
  const [fundsMessage, setFundsMessage] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!address) return;
    setBalError(false);
    try {
      setBalance(await fetchUsdcBalance(address));
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
    } catch (err) {
      setFundsMessage(t(err instanceof Error ? err.message : "Ajout de fonds indisponible"));
    } finally {
      setFundsPending(false);
    }
  };

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- fetch initial, setState post-await
    refresh();
  }, [refresh]);

  async function handleSend(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setSendError(null);
    setTxHash(null);

    if (!/^\d+(?:\.\d{1,6})?$/.test(amount) || Number(amount) <= 0) {
      setSendError(t("Montant invalide."));
      return;
    }

    setSending(true);
    try {
      const hash = await sendPayment({ destination: destination.trim(), amountUsdc: amount });
      setTxHash(hash);
      setDestination("");
      setAmount("");
      await refresh();
    } catch (err) {
      setSendError(messageOf(err));
    } finally {
      setSending(false);
    }
  }

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
        <p className="mt-1 font-mono text-sm text-muted">{truncate(address)}</p>
      </div>

      <Card className="mb-6 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-xs uppercase tracking-wider text-muted">{t("Solde")}</div>
          <div className="mt-1 flex items-baseline gap-2">
            <span className="text-3xl font-semibold tracking-tight">
              {balError ? "—" : balance ? Number(formatUsdcAtomic(balance.atomic)).toLocaleString(locale === "fr" ? "fr-FR" : "en-US", { maximumFractionDigits: 6 }) : "…"}
            </span>
            <span className="text-sm text-muted">USDC</span>
          </div>
          {balError && <p className="mt-2 text-xs text-negative">{t("Solde indisponible.")}</p>}
        </div>
        <div className="flex flex-col items-end gap-2">
          <button
            onClick={handleAddFunds}
            disabled={fundsPending}
            className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90 disabled:opacity-50"
          >
            {fundsPending ? t("Envoi en cours…") : t("Ajouter des fonds")}
          </button>
          {fundsMessage && <p className="max-w-[16rem] text-right text-xs text-muted">{fundsMessage}</p>}
        </div>
      </Card>

      <Card>
        <h2 className="text-sm font-semibold">{t("Envoyer / Retirer")}</h2>
        <p className="mt-1 text-xs text-muted">
          {t("Tes fonds vivent on-chain — envoie-les vers n’importe quelle adresse EVM que tu contrôles.")}
        </p>

        <form onSubmit={handleSend} className="mt-4 flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">{t("Adresse de destination")}</label>
            <input
              value={destination}
              onChange={(e) => setDestination(e.target.value)}
              required
              placeholder="0x…"
              className="rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none transition-colors focus:border-white/30"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">{t("Montant (USDC)")}</label>
            <input
              type="number"
              min="0.000001"
              step="0.000001"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
              placeholder="0.00"
              className="w-40 rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-white/30"
            />
          </div>

          {!authenticated && (
            <p className="text-xs text-muted">{t("Authentifie-toi (bouton « Se connecter ») pour envoyer.")}</p>
          )}
          {sendError && <p className="text-xs text-negative">{sendError}</p>}
          {txHash && (
            <p className="text-xs text-positive">
              {t("Envoyé — tx")} <span className="font-mono">{truncate(txHash)}</span>
            </p>
          )}

          <button
            type="submit"
            disabled={sending || !authenticated}
            className="self-start rounded-xl bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90 disabled:opacity-50"
          >
            {sending ? t("Envoi…") : t("Envoyer")}
          </button>
        </form>
      </Card>

      <SecureAccountCard />
    </main>
  );
}
