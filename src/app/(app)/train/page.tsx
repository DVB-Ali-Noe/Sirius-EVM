"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card } from "@/components/ui/Card";
import { Badge, type BadgeVariant } from "@/components/ui/Badge";
import { Field } from "@/components/ui/Field";
import { ConnectCta } from "@/components/wallet/ConnectCta";
import { truncate, formatBytes } from "@/lib/format";
import { formatUsdcAtomic } from "@/lib/evm/usdc";
import { messageOf } from "@/lib/errors-client";
import { useWalletStore } from "@/stores/wallet";
import { useUiStore } from "@/stores/ui";
import {
  borrowDataset,
  cancelExpiredLoan,
  resumeLoanSubmission,
  resumeLoanSettlement,
  retrieveLoanKey,
  runLoanJob,
} from "@/lib/loans/client";
import { retrieveSelfTrainKey, runSelfTrain } from "@/lib/train/client";
import { downloadDecryptedModel, fetchDecryptedModel, type DeliveredModel } from "@/lib/train/model-client";
import { evaluateModelCsv, predictModel, type ModelEvaluation } from "@/lib/train/evaluation-client";
import { useLocale } from "@/components/i18n/LocaleProvider";

interface Metrics {
  rowCount: number;
  columnCount: number;
}

interface Dataset {
  id: string;
  name: string;
  description: string | null;
  provider: string;
  status: "DRAFT" | "LISTING" | "LISTED" | "UNLISTED" | "PRIVATE" | "SUSPENDED";
  ipfsCid: string | null;
  runnerReceipt: string | null;
  sizeBytes: number | null;
  priceUsdcAtomic: string | null;
  challengeDays: number;
  metrics: Metrics | null;
}

interface Loan {
  id: string;
  datasetId: string;
  amountUsdcAtomic: string;
  status: "PENDING" | "SUBMITTING" | "ESCROWED" | "TRAINING" | "SETTLING" | "SETTLED" | "CANCELLED";
  evmLockTxHash: string | null;
  evmLoanKey: string | null;
  settleTxHash: string | null;
  cancelTxHash: string | null;
  modelCid: string | null;
  runnerReceipt: string | null;
  evmDeadline: string | null;
  createdAt: string;
  dataset: { name: string; runnerReceipt: string | null } | null;
  refundable: boolean;
}

interface Job {
  id: string;
  status: "PENDING" | "RUNNING" | "DONE" | "FAILED";
  modelCid: string | null;
  runnerReceipt: string | null;
  metrics: Record<string, number> | null;
  createdAt: string;
  dataset: { name: string } | null;
}

interface Delivery {
  modelCid: string;
  modelKey: string;
}

const LOAN_VARIANT: Record<Loan["status"], BadgeVariant> = {
  PENDING: "warning",
  SUBMITTING: "warning",
  ESCROWED: "accent",
  TRAINING: "accent",
  SETTLING: "accent",
  SETTLED: "positive",
  CANCELLED: "negative",
};

const JOB_VARIANT: Record<Job["status"], BadgeVariant> = {
  PENDING: "warning",
  RUNNING: "accent",
  DONE: "positive",
  FAILED: "negative",
};

export default function TrainPage() {
  const connected = useWalletStore((s) => s.connected);
  const address = useWalletStore((s) => s.address);
  const authenticated = useWalletStore((s) => s.authenticated);
  const advanced = useUiStore((s) => s.advanced);
  const { locale, t } = useLocale();

  const [mine, setMine] = useState<Dataset[]>([]);
  const [catalogue, setCatalogue] = useState<Dataset[]>([]);
  const [loans, setLoans] = useState<Loan[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [delivered, setDelivered] = useState<Record<string, Delivery>>({});
  const [inspected, setInspected] = useState<Record<string, DeliveredModel>>({});

  const [error, setError] = useState<string | null>(null);
  // Clés d'occupation préfixées par type (`train:`/`job:`) → un bouton ne débloque
  // que sa propre action (pas de collision entre self-train et lancement de job).
  const [busy, setBusy] = useState<Set<string>>(new Set());

  // Ids dont la clé du modèle est déjà livrée → évite de re-fetcher à chaque refresh.
  const haveKey = useRef<Set<string>>(new Set());
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const setBusyKey = (key: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  const deliver = (id: string, d: Delivery) => {
    haveKey.current.add(id);
    setDelivered((prev) => ({ ...prev, [id]: d }));
  };

  const refresh = useCallback(async () => {
    if (!address || !authenticated) {
      setMine([]);
      setCatalogue([]);
      setLoans([]);
      setJobs([]);
      setDelivered({});
      setInspected({});
      haveKey.current.clear();
      return;
    }
    const [mineRes, catRes, loansRes, jobsRes] = await Promise.all([
      fetch("/api/datasets"),
      fetch("/api/datasets?status=LISTED"),
      fetch("/api/loans"),
      fetch("/api/train"),
    ]);
    const mineData: Dataset[] = mineRes.ok ? await mineRes.json() : [];
    const catData: Dataset[] = catRes.ok ? await catRes.json() : [];
    const loanData: Loan[] = loansRes.ok ? await loansRes.json() : [];
    const jobData: Job[] = jobsRes.ok ? await jobsRes.json() : [];
    if (!mounted.current) return;
    setMine(mineData);
    setCatalogue(catData);
    setLoans(loanData);
    setJobs(jobData);

    for (const job of jobData) {
      if (job.status !== "DONE" || !job.runnerReceipt || haveKey.current.has(job.id)) continue;
      try {
        const delivery = await retrieveSelfTrainKey(job.id, job.runnerReceipt);
        if (mounted.current) deliver(job.id, delivery);
      } catch {
        // Une délégation expirée sera redemandée lors de la prochaine connexion.
      }
    }
    for (const loan of loanData) {
      if (
        loan.status !== "SETTLED" ||
        !loan.runnerReceipt ||
        !loan.settleTxHash ||
        haveKey.current.has(loan.id)
      ) {
        continue;
      }
      try {
        const delivery = await retrieveLoanKey(loan.id, loan.runnerReceipt);
        if (mounted.current) deliver(loan.id, delivery);
      } catch {
        // Une délégation expirée sera redemandée lors de la prochaine connexion.
      }
    }
  }, [address, authenticated]);

  useEffect(() => {
    const timer = window.setTimeout(() => void refresh(), 0);
    return () => window.clearTimeout(timer);
  }, [refresh]);

  async function selfTrain(dataset: Dataset) {
    const key = `train:${dataset.id}`;
    setError(null);
    setBusyKey(key, true);
    try {
      if (!dataset.runnerReceipt) throw new Error(t("Reçu confidentiel du dataset manquant"));
      const res = await runSelfTrain(dataset.id, dataset.runnerReceipt);
      deliver(res.jobId, { modelCid: res.modelCid, modelKey: res.modelKey });
      await refresh();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusyKey(key, false);
    }
  }

  async function runJob(loan: Loan) {
    const key = `job:${loan.id}`;
    setError(null);
    setBusyKey(key, true);
    try {
      if (!loan.dataset?.runnerReceipt || !loan.evmLockTxHash || !loan.evmLoanKey) {
        throw new Error(t("Preuve d’escrow ou reçu dataset manquant"));
      }
      const delivery = await runLoanJob({
        loanId: loan.id,
        datasetId: loan.datasetId,
        datasetReceipt: loan.dataset.runnerReceipt,
      });
      deliver(loan.id, delivery);
      await refresh();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusyKey(key, false);
    }
  }

  async function resumeJob(loan: Loan) {
    const key = `job:${loan.id}`;
    setError(null);
    setBusyKey(key, true);
    try {
      if (!loan.runnerReceipt) throw new Error(t("Capsule TEE manquante"));
      deliver(loan.id, await resumeLoanSettlement(loan.id, loan.runnerReceipt));
      await refresh();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusyKey(key, false);
    }
  }

  async function inspectModel(id: string, delivery: Delivery) {
    const key = `model:${id}`;
    setError(null);
    setBusyKey(key, true);
    try {
      const model = await fetchDecryptedModel(delivery.modelCid, delivery.modelKey);
      if (!mounted.current) return;
      setInspected((previous) => ({ ...previous, [id]: model }));
      downloadDecryptedModel(model, `sirius-model-${id}.json`);
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusyKey(key, false);
    }
  }

  async function resumeSubmission(loan: Loan) {
    const key = `submit:${loan.id}`;
    setError(null);
    setBusyKey(key, true);
    try {
      await resumeLoanSubmission();
      await refresh();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusyKey(key, false);
    }
  }

  async function refundLoan(loan: Loan) {
    const key = `refund:${loan.id}`;
    setError(null);
    setBusyKey(key, true);
    try {
      await cancelExpiredLoan(loan.id);
      await refresh();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusyKey(key, false);
    }
  }

  if (!connected || !address) {
    return (
      <main className="mx-auto w-full max-w-3xl px-6 py-8">
        <Card className="flex flex-col items-start gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">{t("Entraîner un modèle")}</h1>
            <p className="mt-1 text-sm text-muted">{t("Connecte un wallet pour lancer un entraînement.")}</p>
          </div>
          <ConnectCta>{t("Connecter un wallet")}</ConnectCta>
        </Card>
      </main>
    );
  }

  const trainable = mine.filter((d) => d.ipfsCid && d.runnerReceipt);
  const external = catalogue.filter((d) => d.provider !== address);
  const hasHistory = loans.length > 0 || jobs.length > 0;

  return (
    <main className="mx-auto w-full max-w-3xl px-6 py-8">
      <div className="mb-8 flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{t("Entraîner un modèle")}</h1>
          <p className="mt-1 text-sm text-muted">
            {t("Le calcul tourne dans un TEE — tu ne récupères que le modèle, jamais la donnée brute.")}
          </p>
        </div>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-negative/40 bg-negative/10 px-4 py-3 text-sm text-negative">
          {t(error)}
        </div>
      )}

      {/* Mes données — self-train, gratuit, sans escrow */}
      <section className="mb-10">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">{t("Mes données")}</h2>
          <span className="text-xs text-muted">{t("Self-train · gratuit")}</span>
        </div>
        {trainable.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface/30 px-4 py-6 text-center text-sm text-muted">
            {t("Aucun dataset finalisé. Dépose-en un dans « Mes datasets ».")}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {trainable.map((d) => (
              <Card key={d.id} className="flex items-center justify-between gap-4">
                <div className="min-w-0">
                  <h3 className="truncate font-medium">{d.name}</h3>
                  <p className="mt-1 text-xs text-muted">
                    {d.metrics ? `${t("{count} lignes", { count: d.metrics.rowCount })} · ${t("{count} colonnes", { count: d.metrics.columnCount })} · ` : ""}
                    {formatBytes(d.sizeBytes)}
                  </p>
                </div>
                <button
                  onClick={() => selfTrain(d)}
                  disabled={busy.has(`train:${d.id}`)}
                  className="shrink-0 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90 disabled:opacity-50"
                >
                  {busy.has(`train:${d.id}`) ? t("Entraînement…") : t("Entraîner")}
                </button>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* Catalogue — emprunt via escrow */}
      <section className="mb-10">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-sm font-semibold uppercase tracking-wider text-muted">{t("Catalogue")}</h2>
          <span className="text-xs text-muted">{t("Emprunt · escrow USDC")}</span>
        </div>
        {external.length === 0 ? (
          <p className="rounded-lg border border-border bg-surface/30 px-4 py-6 text-center text-sm text-muted">
            {t("Aucun dataset tiers disponible pour l’instant.")}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {external.map((d) => (
              <CatalogueCard key={d.id} dataset={d} advanced={advanced} onBorrowed={refresh} onError={setError} />
            ))}
          </div>
        )}
      </section>

      {/* Suivi unifié */}
      <section>
        <h2 className="mb-3 text-sm font-semibold uppercase tracking-wider text-muted">{t("Mes entraînements")}</h2>
        {!hasHistory && (
          <p className="py-8 text-center text-sm text-muted">{t("Aucun entraînement pour l’instant.")}</p>
        )}
        <div className="flex flex-col gap-3">
          {jobs.map((j) => (
            <Card key={j.id}>
              <div className="flex items-center gap-2">
                <h3 className="truncate font-medium">{j.dataset?.name ?? t("Dataset")}</h3>
                <Badge variant={JOB_VARIANT[j.status]}>{t(j.status)}</Badge>
                <Badge variant="default">{t("Self-train")}</Badge>
              </div>
              {j.status === "DONE" && (
                <div className="mt-4 rounded-lg border border-positive/30 bg-positive/5 p-3">
                  <div className="mb-2 text-xs font-medium uppercase tracking-wider text-positive">{t("Modèle livré")}</div>
                  <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
                    <Field label={t("Modèle (CID)")} value={j.modelCid ? truncate(j.modelCid) : "—"} mono />
                    <Field label="R²" value={j.metrics?.r2 != null ? j.metrics.r2.toFixed(4) : "—"} />
                    <Field
                      label={t("Clé de déchiffrement")}
                      value={delivered[j.id] ? truncate(delivered[j.id].modelKey, 10, 6) : "—"}
                      mono
                    />
                  </dl>
                  {delivered[j.id] && (
                    <button
                      onClick={() => void inspectModel(j.id, delivered[j.id])}
                      disabled={busy.has(`model:${j.id}`)}
                      className="mt-3 rounded-lg border border-positive/30 px-3 py-1.5 text-xs font-medium text-positive transition-colors hover:border-positive disabled:opacity-50"
                    >
                      {busy.has(`model:${j.id}`) ? t("Vérification…") : t("Vérifier et télécharger")}
                    </button>
                  )}
                  {inspected[j.id] && <ModelInspection model={inspected[j.id]} />}
                </div>
              )}
            </Card>
          ))}

          {loans.map((l) => (
            <Card key={l.id}>
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="truncate font-medium">{l.dataset?.name ?? t("Dataset")}</h3>
                    <Badge variant={LOAN_VARIANT[l.status]}>{t(l.status)}</Badge>
                    <Badge variant="default">{t("Emprunt")}</Badge>
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-3">
                    <Field label={t("Montant")} value={`${formatUsdcAtomic(l.amountUsdcAtomic)} USDC`} />
                    {advanced && (
                      <>
                        <Field label={t("Lock USDC")} value={l.evmLockTxHash ? truncate(l.evmLockTxHash) : "—"} mono />
                        <Field
                          label={t("Remboursable après")}
                          value={l.evmDeadline ? new Date(l.evmDeadline).toLocaleDateString(locale === "fr" ? "fr-FR" : "en-US") : "—"}
                        />
                      </>
                    )}
                  </dl>
                </div>
                {l.refundable && (
                  <button
                    onClick={() => refundLoan(l)}
                    disabled={busy.has(`refund:${l.id}`)}
                    className="shrink-0 rounded-xl border border-negative/40 px-4 py-2 text-sm font-medium text-negative transition-colors hover:border-negative disabled:opacity-50"
                  >
                    {busy.has(`refund:${l.id}`) ? t("Remboursement…") : t("Récupérer l’escrow")}
                  </button>
                )}
                {!l.refundable && (l.status === "ESCROWED" || (l.status === "TRAINING" && !l.modelCid)) && (
                  <button
                    onClick={() => runJob(l)}
                    disabled={busy.has(`job:${l.id}`)}
                    className="shrink-0 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90 disabled:opacity-50"
                  >
                    {busy.has(`job:${l.id}`)
                      ? t("Job TEE…")
                      : l.status === "TRAINING"
                        ? t("Réessayer le job")
                        : t("Lancer le job (TEE)")}
                  </button>
                )}
                {l.status === "SUBMITTING" && (
                  <button
                    onClick={() => resumeSubmission(l)}
                    disabled={busy.has(`submit:${l.id}`)}
                    className="shrink-0 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90 disabled:opacity-50"
                  >
                    {busy.has(`submit:${l.id}`) ? t("Réconciliation…") : t("Réconcilier l’escrow")}
                  </button>
                )}
                {!l.refundable && (l.status === "TRAINING" || l.status === "SETTLING") && l.modelCid && l.runnerReceipt && (
                  <button
                    onClick={() => resumeJob(l)}
                    disabled={busy.has(`job:${l.id}`)}
                    className="shrink-0 rounded-xl bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90 disabled:opacity-50"
                  >
                    {busy.has(`job:${l.id}`)
                      ? t("Règlement…")
                      : l.status === "SETTLING"
                        ? t("Réconcilier le règlement")
                        : t("Finaliser le règlement")}
                  </button>
                )}
              </div>

              {l.status === "SETTLED" && (
                <div className="mt-4 rounded-lg border border-positive/30 bg-positive/5 p-3">
                  <div className="mb-2 text-xs font-medium uppercase tracking-wider text-positive">{t("Modèle livré")}</div>
                  <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
                    <Field label={t("Modèle (CID)")} value={l.modelCid ? truncate(l.modelCid) : "—"} mono />
                    {advanced && (
                      <Field label={t("Règlement tx")} value={l.settleTxHash ? truncate(l.settleTxHash) : "—"} mono />
                    )}
                    <Field
                      label={t("Clé de déchiffrement")}
                      value={delivered[l.id] ? truncate(delivered[l.id].modelKey, 10, 6) : t("livrée à l'exécution")}
                      mono
                    />
                  </dl>
                  {delivered[l.id] && (
                    <button
                      onClick={() => void inspectModel(l.id, delivered[l.id])}
                      disabled={busy.has(`model:${l.id}`)}
                      className="mt-3 rounded-lg border border-positive/30 px-3 py-1.5 text-xs font-medium text-positive transition-colors hover:border-positive disabled:opacity-50"
                    >
                      {busy.has(`model:${l.id}`) ? t("Vérification…") : t("Vérifier et télécharger")}
                    </button>
                  )}
                  {inspected[l.id] && <ModelInspection model={inspected[l.id]} />}
                </div>
              )}
              {l.status === "CANCELLED" && l.cancelTxHash && (
                <div className="mt-4 rounded-lg border border-negative/30 bg-negative/5 p-3">
                  <div className="text-xs font-medium uppercase tracking-wider text-negative">
                    {t("Escrow remboursé")}
                  </div>
                  {advanced && (
                    <dl className="mt-2 text-xs">
                      <Field label={t("Remboursement tx")} value={truncate(l.cancelTxHash)} mono />
                    </dl>
                  )}
                </div>
              )}
            </Card>
          ))}
        </div>
      </section>
    </main>
  );
}

function ModelInspection({ model }: { model: DeliveredModel }) {
  const { t } = useLocale();
  const [testFile, setTestFile] = useState<File | null>(null);
  const [evaluation, setEvaluation] = useState<ModelEvaluation | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [featureValues, setFeatureValues] = useState<Record<string, string>>({});
  const [prediction, setPrediction] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function evaluate() {
    if (!testFile) {
      setError(t("Sélectionne un CSV de test"));
      return;
    }
    setError(null);
    setEvaluating(true);
    try {
      setEvaluation(evaluateModelCsv(model, await testFile.text()));
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setEvaluating(false);
    }
  }

  function predict() {
    setError(null);
    try {
      const values = Object.fromEntries(
        model.features.map((feature) => {
          const raw = featureValues[feature];
          if (raw === undefined || raw.trim() === "" || !Number.isFinite(Number(raw))) {
            throw new Error(t("Toutes les valeurs doivent être numériques"));
          }
          return [feature, Number(raw)];
        }),
      );
      setPrediction(predictModel(model, values));
    } catch (cause) {
      setError(messageOf(cause));
    }
  }

  return (
    <div className="mt-3 border-t border-positive/20 pt-3">
      <div className="mb-2 text-xs font-medium uppercase tracking-wider text-positive">{t("Modèle déchiffré")}</div>
      <dl className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-2">
        <Field label={t("Algorithme")} value={model.algo} mono />
        <Field label={t("Cible")} value={model.target} />
        <Field label={t("Features")} value={model.features.join(", ")} />
        <Field label="R²" value={model.metrics.r2.toFixed(6)} />
        <Field label="RMSE" value={model.metrics.rmse.toFixed(6)} />
        <Field label="n" value={String(model.metrics.n)} />
      </dl>
      <div className="mt-2 text-xs text-muted">
        <span className="font-medium text-foreground">{t("Coefficients")}</span>
        <code className="ml-2 break-all font-mono">[{model.coefficients.join(", ")}]</code>
      </div>
      <details className="mt-3 rounded-lg border border-border bg-surface/30 p-3">
        <summary className="cursor-pointer text-xs font-medium text-foreground">{t("Évaluer sur un CSV de test")}</summary>
        <p className="mt-2 text-xs text-muted">
          {t("Le fichier reste dans ton navigateur et doit contenir la cible et les mêmes features.")}
        </p>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(event) => setTestFile(event.target.files?.[0] ?? null)}
            className="max-w-full text-xs text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-accent file:px-3 file:py-1.5 file:text-xs file:font-medium file:text-background hover:file:bg-accent/90"
          />
          <button
            type="button"
            onClick={() => void evaluate()}
            disabled={evaluating || !testFile}
            className="rounded-lg border border-positive/30 px-3 py-1.5 text-xs font-medium text-positive transition-colors hover:border-positive disabled:opacity-50"
          >
            {evaluating ? t("Évaluation…") : t("Évaluer")}
          </button>
        </div>
        {evaluation && (
          <dl className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5 text-xs sm:grid-cols-4">
            <Field label="R²" value={evaluation.r2.toFixed(6)} />
            <Field label="RMSE" value={evaluation.rmse.toFixed(6)} />
            <Field label="MAE" value={evaluation.mae.toFixed(6)} />
            <Field label={t("Lignes de test")} value={String(evaluation.n)} />
          </dl>
        )}
      </details>
      <details className="mt-3 rounded-lg border border-border bg-surface/30 p-3">
        <summary className="cursor-pointer text-xs font-medium text-foreground">{t("Tester une prédiction")}</summary>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {model.features.map((feature) => (
            <label key={feature} className="flex flex-col gap-1 text-xs text-muted">
              {feature}
              <input
                type="number"
                inputMode="decimal"
                value={featureValues[feature] ?? ""}
                onChange={(event) => setFeatureValues((values) => ({ ...values, [feature]: event.target.value }))}
                className="rounded-lg border border-border bg-background px-2 py-1.5 text-foreground outline-none focus:border-accent"
              />
            </label>
          ))}
        </div>
        <button
          type="button"
          onClick={predict}
          className="mt-3 rounded-lg border border-positive/30 px-3 py-1.5 text-xs font-medium text-positive transition-colors hover:border-positive"
        >
          {t("Prédire")}
        </button>
        {prediction !== null && (
          <p className="mt-2 text-xs text-muted">
            {t("Prédiction")} <span className="font-medium text-foreground">{prediction.toFixed(6)} {model.target}</span>
          </p>
        )}
      </details>
      {error && <p className="mt-3 text-xs text-negative">{error}</p>}
    </div>
  );
}

function CatalogueCard({
  dataset,
  advanced,
  onBorrowed,
  onError,
}: {
  dataset: Dataset;
  advanced: boolean;
  onBorrowed: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const { t } = useLocale();
  const [openForm, setOpenForm] = useState(false);
  const [busy, setBusy] = useState(false);

  function reset() {
    setOpenForm(false);
  }

  async function confirm() {
    onError("");
    setBusy(true);
    try {
      await borrowDataset({ datasetId: dataset.id });
      reset();
      await onBorrowed();
    } catch (err) {
      onError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <div className="flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h3 className="truncate font-medium">{dataset.name}</h3>
          <p className="mt-1 text-xs text-muted">
            {dataset.metrics ? `${t("{count} lignes", { count: dataset.metrics.rowCount })} · ${t("{count} colonnes", { count: dataset.metrics.columnCount })} · ` : ""}
            {formatBytes(dataset.sizeBytes)}
          </p>
          <p className="mt-1 text-xs font-medium text-foreground">
            {dataset.priceUsdcAtomic ? formatUsdcAtomic(dataset.priceUsdcAtomic) : "—"} USDC · {t("remboursable après {days} j", { days: dataset.challengeDays })}
          </p>
        </div>
        {!openForm && (
          <button
            onClick={() => setOpenForm(true)}
            className="shrink-0 rounded-xl border border-border bg-surface px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-white/20"
          >
            {t("Emprunter")}
          </button>
        )}
      </div>

      {openForm && (
        <div className="mt-4 border-t border-border pt-4">
          <div className="flex flex-wrap items-end gap-3">
            {advanced && (
              <p className="text-xs text-muted">{t("Termes provider verrouillés dans le reçu runner")}</p>
            )}
            <button
              onClick={confirm}
              disabled={busy}
              className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90 disabled:opacity-50"
            >
              {busy ? t("Escrow…") : t("Confirmer l'escrow")}
            </button>
            <button
              onClick={reset}
              className="rounded-xl px-3 py-2 text-sm text-muted transition-colors hover:text-foreground"
            >
              {t("Annuler")}
            </button>
          </div>
        </div>
      )}
    </Card>
  );
}
