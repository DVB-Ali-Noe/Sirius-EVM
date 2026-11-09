"use client";

import { useState } from "react";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { messageOf } from "@/lib/errors-client";
import { useWalletStore } from "@/stores/wallet";
import { parsePredictionFeatures, type PredictionResult } from "@/lib/train/prediction-client";
import { retryWhileEnclaveStarts } from "@/lib/train/enclave-wait";
import { EnclaveStartingSteps } from "./EnclaveStartingSteps";
import { useUnmountSignal } from "@/components/ui/useUnmountSignal";

const FIELD = "w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm text-foreground outline-none focus:border-accent";

/**
 * Prédiction privée : le modèle reste scellé dans le runner, seule la sortie signée (décision 0/1
 * ou valeur arrondie) revient avec son numéro d'appel. Une case numérique par colonne du modèle ;
 * un modèle entraîné avant l'enregistrement de ses colonnes garde la saisie JSON libre.
 */
export function PredictionBox({
  id,
  disabled = false,
  features = [],
  predict,
}: {
  id: string;
  disabled?: boolean;
  features?: string[];
  predict: (features: Record<string, number>) => Promise<PredictionResult>;
}) {
  const { t } = useLocale();
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(features.map((name) => [name, ""])));
  const [json, setJson] = useState("{}");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PredictionResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Enclave arrêtée : la route répond 503 `enclave_starting` ; la demande est relancée seule.
  const [enclaveRetry, setEnclaveRetry] = useState<number | null>(null);
  const unmountSignal = useUnmountSignal();

  function collect(): Record<string, number> {
    if (!features.length) return parsePredictionFeatures(json);
    return Object.fromEntries(features.map((name) => {
      const raw = values[name]?.trim().replace(",", ".") ?? "";
      const value = Number(raw);
      if (!raw || !Number.isFinite(value)) throw new Error("Saisis une valeur numérique pour chaque variable");
      return [name, value];
    }));
  }

  async function submit() {
    const revision = useWalletStore.getState().revision;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const input = collect();
      const output = await retryWhileEnclaveStarts(() => predict(input), { onWaiting: setEnclaveRetry, signal: unmountSignal() });
      if (useWalletStore.getState().revision !== revision) throw new Error("Le wallet a changé");
      setResult(output);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-3" data-testid="prediction-box">
      {features.length ? (
        <fieldset className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <legend className="mb-2 text-xs text-muted">{t("Variables du modèle")}</legend>
          {features.map((name) => (
            <label key={name} className="space-y-1">
              <span className="block truncate font-mono text-xs text-muted" title={name}>{name}</span>
              <input
                type="text"
                inputMode="decimal"
                autoComplete="off"
                value={values[name] ?? ""}
                onChange={(event) => setValues((current) => ({ ...current, [name]: event.target.value }))}
                className={FIELD}
              />
            </label>
          ))}
        </fieldset>
      ) : (
        <>
          <label className="block text-xs text-muted" htmlFor={`features-${id}`}>
            {t("Variables numériques (JSON, noms identiques aux colonnes d’entraînement)")}
          </label>
          <textarea
            id={`features-${id}`}
            rows={3}
            value={json}
            onChange={(event) => setJson(event.target.value)}
            className={`${FIELD} font-mono text-xs`}
          />
        </>
      )}
      <button
        type="button"
        onClick={() => void submit()}
        disabled={disabled || busy}
        className="rounded-md border border-positive/30 px-3 py-1.5 text-xs font-medium text-positive transition-colors hover:border-positive disabled:opacity-50"
      >
        {busy ? t("Prédiction…") : t("Demander une prédiction")}
      </button>
      {result && (
        <p role="status" className="text-xs text-foreground">
          {result.outputKind === "decision"
            ? t("Décision : {value} · appel n° {count}", { value: result.output, count: result.counter })
            : t("Valeur : {value} · appel n° {count}", { value: result.output, count: result.counter })}
        </p>
      )}
      {enclaveRetry !== null && (
        <EnclaveStartingSteps
          phase="starting"
          retryInSeconds={enclaveRetry}
          testId="prediction-enclave-starting"
          closeNote={t("Si tu fermes la page, l’enclave continue de démarrer : relance ta prédiction dans quelques minutes, rien n’est décompté.")}
        />
      )}
      {error && <p role="alert" className="text-xs text-negative">{t(error)}</p>}
    </div>
  );
}
