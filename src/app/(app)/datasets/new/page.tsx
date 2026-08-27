"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Card } from "@/components/ui/Card";
import { messageOf } from "@/lib/errors-client";
import { encryptDatasetForRunner } from "@/lib/tee/ingress-client";
import { MAX_DATASET_BYTES, type DatasetIngressKey } from "@/lib/tee/contract";
import { issueRunnerGrant } from "@/lib/runner/authorization-client";
import { encodeRunnerGrantHeader } from "@/lib/runner/authorization-contract";
import { useLocale } from "@/components/i18n/LocaleProvider";

export default function NewDatasetPage() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadingExample, setLoadingExample] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const { t } = useLocale();

  /**
   * Charge le jeu d'exemple dans le champ fichier.
   *
   * Le champ est non contrôlé — le formulaire le lit au moment de l'envoi — donc on
   * lui assigne un `FileList` construit via `DataTransfer`, seule façon de garnir un
   * input file par programme. Sans ça, un visiteur devrait télécharger le fichier
   * puis le re-sélectionner à la main, et la plupart abandonneraient là.
   */
  async function loadExample() {
    setError(null);
    setLoadingExample(true);
    try {
      const response = await fetch("/examples/housing-prices.csv");
      if (!response.ok) throw new Error(t("Exemple indisponible"));
      const blob = await response.blob();
      const file = new File([blob], "housing-prices.csv", { type: "text/csv" });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      if (fileRef.current) fileRef.current.files = transfer.files;
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setLoadingExample(false);
    }
  }

  async function handleUpload(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const form = new FormData(e.currentTarget);
      const file = form.get("file");
      const name = form.get("name");
      const description = form.get("description");
      const priceUsdc = form.get("priceUsdc");
      const challengeDays = form.get("challengeDays");
      if (
        !(file instanceof File) ||
        typeof name !== "string" ||
        typeof priceUsdc !== "string" ||
        typeof challengeDays !== "string"
      ) {
        throw new Error(t("Formulaire invalide"));
      }
      if (file.size === 0 || file.size > MAX_DATASET_BYTES) throw new Error(t("Fichier trop volumineux (max 16 Mo)"));

      const initRes = await fetch("/api/datasets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name,
          description: typeof description === "string" ? description : undefined,
          sizeBytes: file.size,
          priceUsdc,
          challengeDays: Number(challengeDays),
        }),
      });
      const init = (await initRes.json()) as {
        datasetId?: string;
        ingressKey?: DatasetIngressKey;
        priceUsdcAtomic?: string;
        challengeDays?: number;
        sizeBytes?: number;
        error?: string;
      };
      if (
        !initRes.ok ||
        !init.datasetId ||
        !init.ingressKey ||
        !init.priceUsdcAtomic ||
        !init.challengeDays ||
        init.sizeBytes !== file.size
      ) {
        throw new Error(init.error ?? t("Échec de la préparation du dépôt"));
      }

      const envelope = await encryptDatasetForRunner(await file.arrayBuffer(), init.datasetId, init.ingressKey);
      const authorization = await issueRunnerGrant(
        "seal-dataset",
        { datasetId: init.datasetId },
        [
          init.datasetId,
          init.priceUsdcAtomic,
          String(init.challengeDays),
          String(init.sizeBytes),
          envelope.ciphertext,
        ],
      );
      const uploadRes = await fetch(`/api/datasets/${init.datasetId}/upload`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-sirius-runner-grant": encodeRunnerGrantHeader(authorization),
        },
        body: JSON.stringify({ envelope }),
      });
      const upload = (await uploadRes.json()) as { error?: string };
      if (!uploadRes.ok) throw new Error(upload.error ?? t("Échec de l’upload confidentiel"));
      router.push("/datasets");
    } catch (err) {
      setError(messageOf(err));
      setBusy(false);
    }
  }

  return (
    <main className="mx-auto w-full max-w-xl px-6 py-8">
      <div className="mb-6">
        <Link href="/datasets" className="text-sm text-muted transition-colors hover:text-foreground">
          {t("← Mes actifs data")}
        </Link>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight">{t("Déposer un dataset")}</h1>
        <p className="mt-1 text-sm text-muted">
          {t("Chiffré dans ton navigateur → ouvert et rescellé dans le TEE → IPFS. Next.js ne reçoit jamais la donnée brute.")}
        </p>
      </div>

      {error && (
        <div className="mb-6 rounded-lg border border-negative/40 bg-negative/10 px-4 py-3 text-sm text-negative">
          {t(error)}
        </div>
      )}

      <Card>
        <form onSubmit={handleUpload} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">{t("Nom")}</label>
            <input
              name="name"
              required
              placeholder={t("Ex : Transactions e-commerce 2025")}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-white/30"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">
              {t("Description")} <span className="text-muted">{t("(optionnel)")}</span>
            </label>
            <input
              name="description"
              placeholder={t("Contenu, provenance, fraîcheur…")}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-white/30"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">{t("Prix par entraînement (USDC)")}</label>
            <input
              name="priceUsdc"
              type="number"
              min="0.001"
              max="1000000"
              step="0.000001"
              defaultValue="10"
              required
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-white/30"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">{t("Délai de remboursement (jours)")}</label>
            <input
              name="challengeDays"
              type="number"
              min="1"
              max="30"
              defaultValue="7"
              required
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none transition-colors focus:border-white/30"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label className="text-sm font-medium">{t("Fichier CSV")}</label>
            <input
              ref={fileRef}
              name="file"
              type="file"
              accept=".csv,text/csv"
              required
              className="text-sm text-muted file:mr-3 file:rounded-lg file:border-0 file:bg-accent file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-background hover:file:bg-accent/90"
            />
            <p className="text-xs text-muted">
              {t("Pas de données sous la main ?")}{" "}
              <button
                type="button"
                onClick={loadExample}
                disabled={loadingExample}
                className="underline underline-offset-4 transition-colors hover:text-foreground disabled:opacity-50"
              >
                {loadingExample ? t("Chargement…") : t("Charger le jeu d'exemple")}
              </button>{" "}
              {t("— 140 lignes de prix immobiliers, R² ≈ 0,97.")}{" "}
              <a
                href="/examples/housing-prices.csv"
                download
                className="underline underline-offset-4 transition-colors hover:text-foreground"
              >
                {t("Télécharger")}
              </a>
            </p>
          </div>
          <button
            type="submit"
            disabled={busy}
            className="self-start rounded-xl bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90 disabled:opacity-50"
          >
            {busy ? t("Chiffrement & upload…") : t("Déposer le dataset")}
          </button>
        </form>
      </Card>
    </main>
  );
}
