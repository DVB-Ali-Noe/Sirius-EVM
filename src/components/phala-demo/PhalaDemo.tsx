"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { CardTitle, SectionTitle } from "@/components/ui/Heading";
import { Page, PageHeader } from "@/components/layout/Page";
import { SignInCta } from "@/components/wallet/SignInCta";
import { ConnectButton } from "@/components/wallet/ConnectButton";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { useWalletStore } from "@/stores/wallet";
import { DEMO_EXAMPLES } from "@/lib/phala-demo/examples";
import { demoQualityReport } from "@/lib/phala-demo/csv";
import { QualityReportPanel } from "@/components/datasets/QualityReportPanel";
import { predictDemoModel, trainDemoFile } from "@/lib/phala-demo/training-client";
import { openDemoDelivery } from "@/lib/phala-demo/delivery-client";
import { parseCsv } from "@/lib/sirius/metrics";
import { MAX_DATASET_BYTES } from "@/lib/tee/contract";
import { fetchDecryptedModel, downloadDecryptedModel } from "@/lib/train/model-client";
import { MODEL_OPTIONS, type ModelId } from "@/lib/models/registry";
import { messageOf } from "@/lib/errors-client";

interface Job { id: string; status: string; metrics: Record<string, number> | null; deliveryPublicKey: string | null; servedModelId: string | null; dataset: { name: string } | null; createdAt: string; completedAt: string | null }
/** `table` : le fichier lu, gardé dans la page pour le rapport de qualité ; jamais envoyé ni stocké. */
interface Draft { file: File | null; example: string | null; columns: string[]; rows: number; table: string[][]; target: string; model: ModelId; served: boolean }
const EMPTY_DRAFT: Draft = { file: null, example: null, columns: [], rows: 0, table: [], target: "", model: "linear_regression", served: false };
const button = "rounded-xl bg-accent px-5 py-3 font-medium text-background disabled:cursor-not-allowed disabled:opacity-40";
const selectedButton = "rounded-xl border border-positive/50 px-5 py-3 font-medium text-positive disabled:cursor-not-allowed disabled:opacity-40";
const field = "w-full rounded-xl border border-border bg-background p-3 text-foreground";

export function PhalaDemo() {
  const identity = useWalletStore((state) => `${state.revision}:${state.authenticated}`);
  // La sélection n'appartient à aucun wallet : elle survit à la connexion et à la signature,
  // qui remontent le contenu lié au compte.
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  return <Content key={identity} draft={draft} setDraft={setDraft} />;
}

function Content({ draft, setDraft }: { draft: Draft; setDraft: React.Dispatch<React.SetStateAction<Draft>> }) {
  const { locale, t } = useLocale();
  const { file, example, columns, rows, table, target, model, served } = draft;
  const quality = useMemo(() => (file ? demoQualityReport(table, target) : null), [file, table, target]);
  const address = useWalletStore((state) => state.address);
  const authenticated = useWalletStore((state) => state.authenticated);
  const connected = useWalletStore((state) => state.connected);
  // null : première lecture en cours ; phase null : état illisible.
  const [session, setSession] = useState<{ available: boolean; phase: string | null; predictEnabled: boolean } | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [downloadError, setDownloadError] = useState<{ jobId: string; message: string } | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [predictionInput, setPredictionInput] = useState<Record<string, string>>({});
  const [prediction, setPrediction] = useState<{ jobId: string; decision: 0 | 1; counter: number } | null>(null);
  const available = session?.available === true;

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch("/api/phala-demo/session", { cache: "no-store" });
        const state = await response.json();
        if (!cancelled) setSession(response.ok ? { available: state.available === true, phase: String(state.phase), predictEnabled: state.predictEnabled === true }
          : { available: false, phase: null, predictEnabled: false });
      } catch { if (!cancelled) setSession({ available: false, phase: null, predictEnabled: false }); }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 10_000);
    return () => { cancelled = true; clearInterval(timer); };
  }, []);

  const refreshJobs = useCallback(async () => {
    if (!authenticated) return;
    const revision = useWalletStore.getState().revision;
    const response = await fetch("/api/train", { cache: "no-store" });
    if (response.ok) {
      const result = await response.json();
      if (useWalletStore.getState().revision === revision) setJobs(result.filter((job: Job) => job.deliveryPublicKey || job.servedModelId));
    }
  }, [authenticated]);
  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    void fetch("/api/train", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const result = await response.json();
      if (!cancelled) setJobs(result.filter((job: Job) => job.deliveryPublicKey || job.servedModelId));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [authenticated]);

  async function selectFile(selected: File, sample?: (typeof DEMO_EXAMPLES)[number]) {
    setDraft((current) => ({ ...EMPTY_DRAFT, model: current.model })); setError("");
    if (!selected.size || selected.size > MAX_DATASET_BYTES) throw new Error("CSV vide ou trop volumineux (max 3 Mo)");
    const table = parseCsv(await selected.text());
    const [header, ...lines] = table;
    if (!header?.length || header.some((name) => !name.trim()) || new Set(header).size !== header.length) throw new Error("En-têtes CSV absents ou dupliqués");
    setDraft((current) => ({ file: selected, example: sample?.id ?? null, columns: header, rows: lines.length, table,
      target: sample?.target ?? header[header.length - 1], model: sample?.modelId ?? current.model, served: sample?.modelId === "gradient_boosted_trees" ? current.served : false }));
  }

  async function loadExample(index: number) {
    setError(""); setBusy(true);
    try {
      const sample = DEMO_EXAMPLES[index];
      const response = await fetch(sample.path);
      if (!response.ok) throw new Error("Exemple indisponible");
      await selectFile(new File([await response.blob()], `${sample.id}.csv`, { type: "text/csv" }), sample);
    } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); }
  }

  async function train() {
    if (!file) return;
    setBusy(true); setError("");
    try {
      await trainDemoFile(file, model, target, setProgress, served && model === "gradient_boosted_trees");
      setProgress(served ? "Modèle privé prêt. Il reste dans Phala pendant les sessions ouvertes." : "Modèle prêt. Télécharge-le ci-dessous.");
      await refreshJobs();
    } catch (cause) { setError(messageOf(cause)); setProgress(""); }
    finally { setBusy(false); }
  }

  async function download(job: Job) {
    if (!address) return;
    const revision = useWalletStore.getState().revision;
    setBusy(true); setDownloadError(null);
    try {
      const response = await fetch(`/api/phala-demo/results/${encodeURIComponent(job.id)}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Résultat indisponible");
      const key = await openDemoDelivery(job.id, address, result.publicKey, result.envelope);
      const output = await fetchDecryptedModel(result.modelCid, key);
      if (useWalletStore.getState().revision !== revision) throw new Error("Le wallet a changé");
      downloadDecryptedModel(output, `sirius-${job.id}.json`);
    } catch (cause) { setDownloadError({ jobId: job.id, message: messageOf(cause) }); } finally { setBusy(false); }
  }

  async function predict(job: Job) {
    const revision = useWalletStore.getState().revision;
    setBusy(true); setDownloadError(null); setPrediction(null);
    try {
      const input = JSON.parse(predictionInput[job.id] ?? "{}") as unknown;
      if (!input || typeof input !== "object" || Array.isArray(input) || !Object.values(input).every((value) => typeof value === "number" && Number.isFinite(value))) {
        throw new Error("Saisis un objet JSON de variables numériques");
      }
      const result = await predictDemoModel(job.id, input as Record<string, number>);
      if (useWalletStore.getState().revision !== revision) throw new Error("Le wallet a changé");
      setPrediction({ jobId: job.id, decision: result.decision, counter: result.counter });
    } catch (cause) { setDownloadError({ jobId: job.id, message: messageOf(cause) }); } finally { setBusy(false); }
  }

  return <Page>
    <PageHeader eyebrow={t("Phala · entraînement confidentiel · testnet")} title={t("Tes données. Ton modèle.")}
      description={t("Choisis un exemple ou importe ton CSV. Ton fichier est chiffré dans ton navigateur, puis entraîné dans une enclave Phala.")} />
    <div role="status" data-guide="page:phala:attestation" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border px-5 py-4">
      <span className={available ? "text-emerald-400" : "text-muted"}>{t(session === null ? "Vérification de la disponibilité…"
        : session.available ? "Démonstration ouverte · offerte par Sirius" : session.phase === null ? "Démonstration indisponible"
        : session.phase === "opening" ? "Démarrage en cours" : session.phase === "open" ? "Démonstration ouverte · capacité momentanément indisponible"
        : "Démonstration fermée")}</span>
      <Link href="/phala/attestation" className="text-sm underline">{t("Attestation du runner")}</Link>
    </div>
    <div className="grid gap-4 md:grid-cols-2" data-guide="page:phala:examples">{DEMO_EXAMPLES.map((sample, index) => <Card key={sample.id} className={example === sample.id ? "ring-1 ring-positive/50" : ""}>
      <p className="text-xs uppercase tracking-wider text-muted">{t("Dataset synthétique prêt à utiliser")}</p>
      <CardTitle className="mt-3">{sample.name}</CardTitle><p className="mt-2 min-h-12 text-sm text-muted">{sample.description}</p>
      <div className="mt-5 flex flex-wrap items-center gap-4">
        <button className={example === sample.id ? selectedButton : button} disabled={busy} onClick={() => void loadExample(index)}>
          {example === sample.id ? t("Exemple sélectionné ✓") : t("Utiliser cet exemple")}</button>
        <a href={sample.path} download className="text-sm underline">{t("Télécharger le CSV")}</a></div>
    </Card>)}</div>
    <Card data-guide="page:phala:prepare"><CardTitle>{t("Préparer l’entraînement")}</CardTitle>
      <label className={`mt-5 flex cursor-pointer flex-col gap-1 rounded-xl border border-dashed p-4 transition-colors focus-within:ring-2 focus-within:ring-accent/50 hover:border-accent/60 ${file ? "border-positive/50 bg-positive/5" : "border-border"} ${busy ? "pointer-events-none opacity-50" : ""}`}>
        <span className="text-sm text-muted">{t("Ton CSV · 3 Mo maximum")}</span>
        <span className="truncate font-medium">{file ? `✓ ${file.name}` : t("Choisir un fichier CSV")}</span>
        {file && <span className="text-xs text-muted">{t("{count} lignes", { count: rows })} · {t("{count} colonnes", { count: columns.length })}</span>}
        <input className="sr-only" type="file" accept=".csv,text/csv" aria-label={t("Ton CSV · 3 Mo maximum")} disabled={busy} onChange={(event) => {
          const selected = event.target.files?.[0]; event.target.value = "";
          if (selected) void selectFile(selected).catch((cause) => setError(messageOf(cause)));
        }} />
      </label>
      <div className="mt-4 grid gap-4 md:grid-cols-2">
        <label className="space-y-2 text-sm"><span>{t("Modèle")}</span><select className={field} value={model} disabled={busy} onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value as ModelId, served: event.target.value === "gradient_boosted_trees" && current.served }))}>
          {MODEL_OPTIONS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label className="space-y-2 text-sm"><span>{t("Colonne à prédire")}</span><select className={field} value={target} disabled={busy || !file} onChange={(event) => setDraft((current) => ({ ...current, target: event.target.value }))}>
          {columns.map((column) => <option key={column} value={column}>{column}</option>)}</select></label></div>
      {session?.predictEnabled && model === "gradient_boosted_trees" && <label className="mt-4 flex items-start gap-3 text-sm">
        <input type="checkbox" checked={served} disabled={busy} onChange={(event) => setDraft((current) => ({ ...current, served: event.target.checked }))} />
        <span>{t("Garder le modèle privé dans Phala : seules les décisions 0/1 seront accessibles pendant une session ouverte. Aucun téléchargement.")}</span>
      </label>}
      <p className="mt-4 text-sm text-muted">{t("Au moins 100 lignes ; colonnes prédictives numériques. La classification attend une cible 0/1. Les limites du profil sont vérifiées avant calcul.")}</p>
      {quality && quality.invalidTarget > 0 && <div role="alert" className="mt-4 rounded-lg border border-yellow-400/40 bg-yellow-400/10 p-3 text-xs text-foreground/90">
        <p className="font-medium text-yellow-400">{t("Colonne à prédire non numérique : à vérifier")}</p>
        <p className="mt-1">{t("La colonne à prédire, {column}, contient {count} cellules vides ou non numériques : l’entraînement sera refusé. Choisis une autre colonne ou complète-les.", { column: target, count: quality.invalidTarget })}</p>
      </div>}
      {quality && <QualityReportPanel report={quality.report} />}
      <div className="mt-6">{authenticated ? <button className={button} disabled={!available || busy || !file || !target} onClick={() => void train()}>{t("Entraîner avec Phala")}</button>
        // Sans wallet connecté : le menu de choix (Google, MetaMask, Phantom…) plutôt que
        // `window.ethereum`, que la dernière extension installée s'approprie.
        : connected ? <SignInCta /> : <div className="inline-block"><ConnectButton menuAlign="left" /></div>}</div>
      <p className="mt-3 text-sm text-muted">{t("Le calcul est offert. Ton wallet confirme le titre testnet du dataset ; aucun achat de données n’est demandé.")}</p>
      {progress && <p role="status" className="mt-4">{t(progress)}</p>}
      {/* Sous le bouton : un refus (quota, fichier, session) reste visible là où l'on vient de cliquer. */}
      {error && <p role="alert" className="mt-4 rounded-lg border border-negative/40 bg-negative/10 px-4 py-3 text-sm text-negative">{t(error)}</p>}
    </Card>
    {authenticated && <section className="space-y-3" data-guide="page:phala:results"><SectionTitle>{t("Mes résultats")}</SectionTitle>
      <p className="text-sm text-muted">{t("Les modèles livrés restent téléchargeables après fermeture. Les modèles privés ne répondent que pendant une session ouverte.")}</p>
      {jobs.length === 0 && <p className="text-sm text-muted">{t("Ton premier modèle apparaîtra ici.")}</p>}
      {jobs.map((job) => <Card key={job.id}><div className="flex flex-wrap items-center justify-between gap-4">
        <div><h3 className="font-medium">{job.dataset?.name ?? t("Mon dataset")}</h3><p className="text-sm text-muted">{job.status === "DONE" ? t("Entraînement terminé") : job.status}</p>
          <p className="text-xs text-muted">{t("Entraîné le {date}", { date: new Date(job.completedAt ?? job.createdAt).toLocaleString(locale === "fr" ? "fr-FR" : "en-US", { dateStyle: "medium", timeStyle: "short" }) })}</p></div>
        {job.servedModelId ? <span className="text-sm text-muted">{t("Modèle privé · sans téléchargement")}</span>
          : <button className={button} disabled={busy || job.status !== "DONE"} onClick={() => void download(job)}>{t("Télécharger le modèle")}</button>}</div>
        {job.metrics && <dl className="mt-4 flex flex-wrap gap-5">{Object.entries(job.metrics).map(([name, value]) => <div key={name}><dt className="text-xs text-muted">{name}</dt><dd className="font-mono text-sm">{Number.isFinite(value) ? Number(value.toPrecision(4)) : "—"}</dd></div>)}</dl>}
        {job.servedModelId && job.status === "DONE" && <div className="mt-4 space-y-2">
          <label className="block text-sm" htmlFor={`features-${job.id}`}>{t("Variables numériques (JSON, noms identiques aux colonnes d’entraînement)")}</label>
          <textarea id={`features-${job.id}`} className={field} rows={3} value={predictionInput[job.id] ?? "{}"}
            onChange={(event) => setPredictionInput((current) => ({ ...current, [job.id]: event.target.value }))} />
          <button className={button} disabled={!available || !session?.predictEnabled || busy} onClick={() => void predict(job)}>{t("Demander une décision")}</button>
          {prediction?.jobId === job.id && <p role="status">{t("Décision : {value} · appel n° {count}", { value: prediction.decision, count: prediction.counter })}</p>}
        </div>}
        {downloadError?.jobId === job.id && <p role="alert" className="mt-4 rounded-lg border border-negative/40 bg-negative/10 px-4 py-3 text-sm text-negative">{t(downloadError.message)}</p>}
      </Card>)}
    </section>}
  </Page>;
}
