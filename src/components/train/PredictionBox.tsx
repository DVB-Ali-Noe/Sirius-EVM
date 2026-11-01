"use client";

import { useState } from "react";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { messageOf } from "@/lib/errors-client";
import { useWalletStore } from "@/stores/wallet";
import { parsePredictionFeatures, type PredictionResult } from "@/lib/train/prediction-client";

/**
 * Prédiction privée : le modèle reste scellé dans le runner, seule la sortie signée (décision 0/1
 * ou valeur arrondie) revient avec son numéro d'appel.
 */
export function PredictionBox({
  id,
  disabled = false,
  predict,
}: {
  id: string;
  disabled?: boolean;
  predict: (features: Record<string, number>) => Promise<PredictionResult>;
}) {
  const { t } = useLocale();
  const [input, setInput] = useState("{}");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<PredictionResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    const revision = useWalletStore.getState().revision;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const output = await predict(parsePredictionFeatures(input));
      if (useWalletStore.getState().revision !== revision) throw new Error("Le wallet a changé");
      setResult(output);
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-3 space-y-2" data-testid="prediction-box">
      <label className="block text-xs text-muted" htmlFor={`features-${id}`}>
        {t("Variables numériques (JSON, noms identiques aux colonnes d’entraînement)")}
      </label>
      <textarea
        id={`features-${id}`}
        rows={3}
        value={input}
        onChange={(event) => setInput(event.target.value)}
        className="w-full rounded-lg border border-border bg-background p-2 font-mono text-xs text-foreground outline-none focus:border-accent"
      />
      <button
        type="button"
        onClick={() => void submit()}
        disabled={disabled || busy}
        className="rounded-lg border border-positive/30 px-3 py-1.5 text-xs font-medium text-positive transition-colors hover:border-positive disabled:opacity-50"
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
      {error && <p role="alert" className="text-xs text-negative">{t(error)}</p>}
    </div>
  );
}
