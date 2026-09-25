"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card } from "@/components/ui/Card";
import { ConnectCta } from "@/components/wallet/ConnectCta";
import { useWalletStore } from "@/stores/wallet";
import { DEMO_EXAMPLES } from "@/lib/phala-demo/examples";
import { trainDemoFile } from "@/lib/phala-demo/training-client";
import { openDemoDelivery } from "@/lib/phala-demo/delivery-client";
import { parseCsv } from "@/lib/sirius/metrics";
import { MAX_DATASET_BYTES } from "@/lib/tee/contract";
import { fetchDecryptedModel, downloadDecryptedModel } from "@/lib/train/model-client";
import { MODEL_OPTIONS, type ModelId } from "@/lib/models/registry";
import { messageOf } from "@/lib/errors-client";

interface Job { id: string; status: string; metrics: Record<string, number> | null; deliveryPublicKey: string | null; dataset: { name: string } | null }
const button = "rounded-xl bg-accent px-5 py-3 font-medium text-background disabled:cursor-not-allowed disabled:opacity-40";
const field = "w-full rounded-xl border border-border bg-background p-3 text-foreground";

export function PhalaDemo() {
  const identity = useWalletStore((state) => `${state.revision}:${state.authenticated}`);
  return <Content key={identity} />;
}

function Content() {
  const address = useWalletStore((state) => state.address);
  const authenticated = useWalletStore((state) => state.authenticated);
  const [available, setAvailable] = useState(false);
  const [sessionLabel, setSessionLabel] = useState("Vérification de la disponibilité…");
  const [file, setFile] = useState<File | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [target, setTarget] = useState("");
  const [model, setModel] = useState<ModelId>("linear_regression");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState("");
  const [jobs, setJobs] = useState<Job[]>([]);

  useEffect(() => {
    let cancelled = false;
    const refresh = async () => {
      try {
        const response = await fetch("/api/phala-demo/session", { cache: "no-store" });
        const state = await response.json();
        if (cancelled) return;
        setAvailable(response.ok && state.available === true);
        setSessionLabel(!response.ok ? "Démonstration indisponible" : state.available ? "Démonstration ouverte · offerte par Sirius"
          : state.phase === "opening" ? "Démarrage en cours" : state.phase === "open" ? "Démonstration ouverte · capacité momentanément indisponible" : "Démonstration fermée");
      } catch { if (!cancelled) { setAvailable(false); setSessionLabel("Démonstration indisponible"); } }
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
      if (useWalletStore.getState().revision === revision) setJobs(result.filter((job: Job) => job.deliveryPublicKey));
    }
  }, [authenticated]);
  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    void fetch("/api/train", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const result = await response.json();
      if (!cancelled) setJobs(result.filter((job: Job) => job.deliveryPublicKey));
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [authenticated]);

  async function selectFile(selected: File, preferredTarget?: string) {
    setFile(null); setColumns([]); setTarget(""); setError("");
    if (!selected.size || selected.size > MAX_DATASET_BYTES) throw new Error("CSV vide ou trop volumineux (max 3 Mo)");
    const header = parseCsv(await selected.text())[0];
    if (!header?.length || header.some((name) => !name.trim()) || new Set(header).size !== header.length) throw new Error("En-têtes CSV absents ou dupliqués");
    setFile(selected); setColumns(header); setTarget(preferredTarget ?? header[header.length - 1]);
  }

  async function example(index: number) {
    setError(""); setBusy(true);
    try {
      const sample = DEMO_EXAMPLES[index];
      const response = await fetch(sample.path);
      if (!response.ok) throw new Error("Exemple indisponible");
      await selectFile(new File([await response.blob()], `${sample.id}.csv`, { type: "text/csv" }), sample.target);
      setModel(sample.modelId);
    } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); }
  }

  async function train() {
    if (!file) return;
    setBusy(true); setError("");
    try {
      await trainDemoFile(file, model, target, setProgress);
      setProgress("Modèle prêt. Télécharge-le ci-dessous.");
      await refreshJobs();
    } catch (cause) { setError(messageOf(cause)); setProgress(""); }
    finally { setBusy(false); }
  }

  async function download(job: Job) {
    if (!address) return;
    const revision = useWalletStore.getState().revision;
    setBusy(true); setError("");
    try {
      const response = await fetch(`/api/phala-demo/results/${encodeURIComponent(job.id)}`);
      const result = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Résultat indisponible");
      const key = await openDemoDelivery(job.id, address, result.publicKey, result.envelope);
      const output = await fetchDecryptedModel(result.modelCid, key);
      if (useWalletStore.getState().revision !== revision) throw new Error("Le wallet a changé");
      downloadDecryptedModel(output, `sirius-${job.id}.json`);
    } catch (cause) { setError(messageOf(cause)); } finally { setBusy(false); }
  }

  return <main className="mx-auto w-full max-w-5xl space-y-7 px-5 py-8 md:px-8">
    <div><p className="text-sm text-muted">Phala · entraînement confidentiel · testnet</p>
      <h1 className="mt-3 text-3xl font-semibold tracking-tight md:text-5xl">Tes données. Ton modèle.</h1>
      <p className="mt-4 max-w-2xl text-muted">Choisis un exemple ou importe ton CSV. Ton fichier est chiffré dans ton navigateur, puis entraîné dans une enclave Phala.</p></div>
    <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border px-5 py-4">
      <span className={available ? "text-emerald-400" : "text-muted"}>{sessionLabel}</span>
      <a href="/api/phala-demo/attestation" target="_blank" rel="noreferrer" className="text-sm underline">Attestation du runner</a>
    </div>
    {error && <p role="alert" className="rounded-xl border border-red-400/30 bg-red-400/10 p-4 text-red-300">{error}</p>}
    <div className="grid gap-4 md:grid-cols-2">{DEMO_EXAMPLES.map((sample, index) => <Card key={sample.id}>
      <p className="text-xs uppercase tracking-widest text-muted">Dataset synthétique prêt à utiliser</p>
      <h2 className="mt-3 text-xl font-medium">{sample.name}</h2><p className="mt-2 min-h-12 text-sm text-muted">{sample.description}</p>
      <div className="mt-5 flex flex-wrap items-center gap-4"><button className={button} disabled={busy} onClick={() => void example(index)}>Utiliser cet exemple</button>
        <a href={sample.path} download className="text-sm underline">Télécharger le CSV</a></div>
    </Card>)}</div>
    <Card><h2 className="text-xl font-medium">Préparer l’entraînement</h2>
      <div className="mt-5 grid gap-4 md:grid-cols-2"><label className="space-y-2 text-sm"><span>Ton CSV · 3 Mo maximum</span>
        <input className={field} type="file" accept=".csv,text/csv" disabled={busy} onChange={(event) => {
          const selected = event.target.files?.[0]; if (selected) void selectFile(selected).catch((cause) => setError(messageOf(cause)));
        }} /></label>
        <label className="space-y-2 text-sm"><span>Modèle</span><select className={field} value={model} disabled={busy} onChange={(event) => setModel(event.target.value as ModelId)}>
          {MODEL_OPTIONS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label className="space-y-2 text-sm"><span>Colonne à prédire</span><select className={field} value={target} disabled={busy || !file} onChange={(event) => setTarget(event.target.value)}>
          {columns.map((column) => <option key={column} value={column}>{column}</option>)}</select></label>
        <p className="self-end text-sm text-muted">{file ? `Fichier sélectionné : ${file.name}` : "Sélectionne un exemple ou importe ton fichier."}</p></div>
      <p className="mt-4 text-sm text-muted">Au moins 100 lignes ; colonnes prédictives numériques. La classification attend une cible 0/1. Les limites du profil sont vérifiées avant calcul.</p>
      <div className="mt-6">{authenticated ? <button className={button} disabled={!available || busy || !file || !target} onClick={() => void train()}>Entraîner avec Phala</button>
        : <ConnectCta>Connecter mon wallet testnet</ConnectCta>}</div>
      <p className="mt-3 text-sm text-muted">Le calcul est offert. Ton wallet confirme le titre testnet du dataset ; aucun achat de données n’est demandé.</p>
      {progress && <p role="status" className="mt-4">{progress}</p>}
    </Card>
    {authenticated && <section className="space-y-3"><h2 className="text-xl font-medium">Mes résultats</h2>
      <p className="text-sm text-muted">Après fermeture, récupère tes modèles depuis ce même navigateur. Télécharge-les pour les conserver ailleurs.</p>
      {jobs.length === 0 && <p className="text-sm text-muted">Ton premier modèle apparaîtra ici.</p>}
      {jobs.map((job) => <Card key={job.id}><div className="flex flex-wrap items-center justify-between gap-4">
        <div><h3 className="font-medium">{job.dataset?.name ?? "Mon dataset"}</h3><p className="text-sm text-muted">{job.status === "DONE" ? "Entraînement terminé" : job.status}</p></div>
        <button className={button} disabled={busy || job.status !== "DONE"} onClick={() => void download(job)}>Télécharger le modèle</button></div>
        {job.metrics && <dl className="mt-4 flex flex-wrap gap-5">{Object.entries(job.metrics).map(([name, value]) => <div key={name}><dt className="text-xs text-muted">{name}</dt><dd className="font-mono text-sm">{Number.isFinite(value) ? Number(value.toPrecision(4)) : "—"}</dd></div>)}</dl>}
      </Card>)}
    </section>}
    <Link href="/phala/operator" className="inline-block text-xs text-muted underline">Accès opérateurs</Link>
  </main>;
}
