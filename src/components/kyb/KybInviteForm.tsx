"use client";

import { useState } from "react";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { acceptKybCredential } from "@/lib/kyb/client";

/**
 * Saisie d'un code d'invitation KYB. Le code, signé hors ligne par un vérificateur Sirius,
 * ne vaut que pour l'adresse connectée ; le wallet signe ensuite l'acceptation on-chain.
 */
export function KybInviteForm({ role, onAccepted }: { role: "provider" | "borrower"; onAccepted: () => void }) {
  const { t } = useLocale();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!code.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await acceptKybCredential(role, code);
      setCode("");
      onAccepted();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Code d’invitation KYB invalide");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="mb-6 flex flex-col gap-2 rounded-xl border border-border bg-surface p-4">
      <label htmlFor={`kyb-invite-${role}`} className="text-sm font-medium">{t("Code d’invitation KYB")}</label>
      <p className="text-xs text-muted">{t("Pendant la bêta, l’accès est sur invitation. Colle le code reçu de l’équipe Sirius, puis confirme dans ton wallet.")}</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <input
          id={`kyb-invite-${role}`}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          placeholder="sirius-kyb-…"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-2 font-mono text-xs"
        />
        <button
          type="submit"
          disabled={busy || !code.trim()}
          className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-background disabled:opacity-40"
        >
          {busy ? t("Validation…") : t("Valider l’invitation")}
        </button>
      </div>
      {error && <p role="alert" className="text-xs text-negative">{t(error)}</p>}
    </form>
  );
}
