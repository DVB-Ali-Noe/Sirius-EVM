"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { Card } from "@/components/ui/Card";
import { ConnectCta } from "@/components/wallet/ConnectCta";
import { truncate } from "@/lib/format";
import { formatUsdcAtomic } from "@/lib/evm/usdc";
import { transactionExplorerUrl } from "@/lib/evm/explorer";
import type { EvmNetwork } from "@/lib/evm/networks";
import { useWalletStore } from "@/stores/wallet";
import { useLocale } from "@/components/i18n/LocaleProvider";
import type { ModelId } from "@/lib/models/registry";

interface AuditLoan {
  id: string;
  borrower: string;
  provider: string;
  amountUsdcAtomic: string;
  modelId: ModelId;
  modelVersion: string;
  status: "PENDING" | "SUBMITTING" | "ESCROWED" | "TRAINING" | "SETTLING" | "SETTLED" | "CANCELLED";
  evmLockTxHash: string | null;
  settleTxHash: string | null;
  auditReceipt: string | null;
  cancelTxHash: string | null;
  attestationHash: string | null;
  attestationComposeHash: string | null;
  evmDeadline: string | null;
  createdAt: string;
  settledAt: string | null;
  dataset: { name: string; evmDatasetId: string | null; evmMintTxHash: string | null };
}

const STATUS_VARIANT: Record<AuditLoan["status"], BadgeVariant> = {
  PENDING: "warning",
  SUBMITTING: "warning",
  ESCROWED: "accent",
  TRAINING: "accent",
  SETTLING: "accent",
  SETTLED: "positive",
  CANCELLED: "negative",
};

export default function AuditPage() {
  const identity = useWalletStore((state) => `${state.revision}:${state.authenticated}`);
  return <AuditPageContent key={identity} />;
}

function AuditPageContent() {
  const connected = useWalletStore((state) => state.connected);
  const authenticated = useWalletStore((state) => state.authenticated);
  const { locale, t } = useLocale();
  const [network, setNetwork] = useState<EvmNetwork>("testnet");
  const [loans, setLoans] = useState<AuditLoan[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);

  const refresh = useCallback(async () => {
    if (!authenticated) return;
    setLoading(true);
    setError(false);
    try {
      const response = await fetch("/api/audit");
      if (!response.ok) throw new Error();
      const body = await response.json() as { network: EvmNetwork; loans: AuditLoan[] };
      setNetwork(body.network);
      setLoans(body.loans);
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [authenticated]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  if (!connected) {
    return (
      <main className="mx-auto w-full max-w-4xl px-6 py-8">
        <Card className="flex flex-col items-start gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{t("Registre d’audit")}</h1>
            <p className="mt-1 text-sm text-muted">{t("Connecte un wallet pour consulter ses preuves.")}</p>
          </div>
          <ConnectCta>{t("Connecter un wallet")}</ConnectCta>
        </Card>
      </main>
    );
  }

  const settled = loans.filter((loan) => loan.status === "SETTLED").length;
  const refunded = loans.filter((loan) => loan.status === "CANCELLED" && loan.cancelTxHash).length;

  return (
    <main className="mx-auto w-full max-w-4xl px-6 py-8">
      <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("Registre d’audit")}</h1>
          <p className="mt-1 text-sm text-muted">{t("Chaîne de preuves Sirius recoupable sur EVM.")}</p>
        </div>
        <div className="flex flex-wrap gap-x-5 gap-y-1 font-mono text-xs uppercase tracking-wider text-muted">
          <span>{t("{count} réglés", { count: settled })}</span>
          <span>{t("{count} remboursés", { count: refunded })}</span>
          <span>{network}</span>
        </div>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-negative/40 bg-negative/10 px-4 py-3 text-sm text-negative">
          {t("Registre indisponible — réessaie.")}
        </div>
      )}
      {loading && loans.length === 0 && <p className="py-8 text-center text-sm text-muted">{t("Chargement des preuves…")}</p>}
      {!loading && !error && loans.length === 0 && (
        <p className="rounded-xl border border-border bg-surface/30 px-4 py-8 text-center text-sm text-muted">
          {t("Aucun prêt auditable pour ce wallet.")}
        </p>
      )}

      <div className="flex flex-col gap-4">
        {loans.map((loan) => (
          <Card key={loan.id}>
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div className="min-w-0 flex-1 basis-64">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="font-medium">{loan.dataset.name}</h2>
                  {/* Un prêt annulé avec transaction de remboursement a bien eu lieu : c'est un remboursement, pas un échec. */}
                  {loan.status === "CANCELLED" && loan.cancelTxHash
                    ? <Badge variant="positive">{t("REFUNDED")}</Badge>
                    : <Badge variant={STATUS_VARIANT[loan.status]}>{t(loan.status)}</Badge>}
                </div>
                <p className="mt-1 font-mono text-xs text-muted">{loan.id}</p>
              </div>
              <div className="text-right">
                <div className="text-sm font-medium">{formatUsdcAtomic(loan.amountUsdcAtomic)} USDC</div>
                <div className="mt-1 text-xs text-muted">{new Date(loan.createdAt).toLocaleDateString(locale === "fr" ? "fr-FR" : "en-US")}</div>
              </div>
            </div>

            <div className="mt-5 grid gap-2 sm:grid-cols-2">
              <Evidence label={t("Titre du dataset")} value={loan.dataset.evmDatasetId} txHash={loan.dataset.evmMintTxHash} network={network} />
              <Evidence label="Lock USDC" value={loan.evmLockTxHash} txHash={loan.evmLockTxHash} network={network} />
              <Evidence label={t("Attestation TEE")} value={loan.attestationHash} />
              <Evidence label={t("Reçu d’audit")} value={loan.auditReceipt} />
              <Evidence
                label={loan.cancelTxHash ? t("Remboursement USDC") : "Release USDC"}
                value={loan.cancelTxHash ?? loan.settleTxHash}
                txHash={loan.cancelTxHash ?? loan.settleTxHash}
                network={network}
              />
            </div>

            <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2 border-t border-border pt-4 font-mono text-[11px] text-muted">
              <span>{t("provider")} {truncate(loan.provider)}</span>
              <span>{t("borrower")} {truncate(loan.borrower)}</span>
              <span>{t("modèle")} {loan.modelId} v{loan.modelVersion}</span>
              {loan.attestationComposeHash && <span>compose {truncate(loan.attestationComposeHash)}</span>}
              {loan.evmDeadline && <span>{t("échéance")} {new Date(loan.evmDeadline).toLocaleString(locale === "fr" ? "fr-FR" : "en-US")}</span>}
            </div>
          </Card>
        ))}
      </div>
    </main>
  );
}

function Evidence({
  label,
  value,
  txHash,
  network,
}: {
  label: string;
  value: string | null;
  txHash?: string | null;
  network?: EvmNetwork;
}) {
  const { t } = useLocale();
  const content = value ? truncate(value, 10, 8) : t("En attente");
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-background/30 px-3 py-2.5">
      <div className="min-w-0">
        <div className="text-[10px] uppercase tracking-wider text-muted">{label}</div>
        <div className={`mt-0.5 truncate font-mono text-xs ${value ? "text-foreground" : "text-muted"}`}>{content}</div>
      </div>
      {txHash && network && (
        <a
          href={transactionExplorerUrl(network, txHash)}
          target="_blank"
          rel="noreferrer"
          aria-label={t("Vérifier {label} sur EVM", { label })}
          className="shrink-0 text-xs font-medium text-accent transition-opacity hover:opacity-70"
        >
          {t("Vérifier ↗")}
        </a>
      )}
    </div>
  );
}
