"use client";

import { useLocale } from "@/components/i18n/LocaleProvider";

export type WaitStepStatus = "pending" | "active" | "done" | "error";

export interface WaitStep {
  id: string;
  /** Libellé déjà traduit par l'appelant (`t(...)`). */
  label: string;
  status: WaitStepStatus;
  /** Précision facultative sous l'étape (déjà traduite). */
  detail?: string;
}

const STATUS_LABEL: Record<WaitStepStatus, string> = {
  pending: "en attente",
  active: "en cours",
  done: "fait",
  error: "erreur",
};

const STATUS_TEXT_CLASS: Record<WaitStepStatus, string> = {
  pending: "text-muted",
  active: "text-foreground",
  done: "text-positive",
  error: "text-negative",
};

/** Durée restante affichée : secondes sous la minute, minutes arrondies au-dessus sinon. */
export function formatWaitRemaining(seconds: number): { key: string; params: Record<string, number> } | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const whole = Math.ceil(seconds);
  if (whole < 60) return { key: "Temps restant estimé : ~{seconds} s", params: { seconds: whole } };
  return { key: "Temps restant estimé : ~{minutes} min", params: { minutes: Math.ceil(whole / 60) } };
}

/**
 * Attente expliquée (D-30) : étapes nommées, durée estimée facultative et ce qui se passe si la
 * page est fermée. Seule l'étape en cours s'anime, et uniquement sans `prefers-reduced-motion`
 * (variante `motion-safe:` : rien ne bouge quand le système demande moins d'animations).
 */
export function WaitSteps({
  steps,
  title,
  description,
  remainingSeconds,
  canClose,
  closeNote,
  testId,
  progress,
}: {
  steps: readonly WaitStep[];
  /** Titre déjà traduit. */
  title?: string;
  /** Paragraphe d'explication sous le titre (déjà traduit). */
  description?: string;
  /** Durée restante estimée, en secondes ; rien d'affiché si absente ou écoulée. */
  remainingSeconds?: number | null;
  /** `true` : « tu peux fermer la page » ; `false` : « garde la page ouverte » ; absent : rien. */
  canClose?: boolean;
  /** Remplace la phrase par défaut sur la fermeture de la page (déjà traduite). */
  closeNote?: string;
  testId?: string;
  /** Ligne d'avancement (déjà traduite), par exemple le temps d'attente écoulé ; hors région `aria-live`. */
  progress?: string;
}) {
  const { t } = useLocale();
  const remaining = remainingSeconds == null ? null : formatWaitRemaining(remainingSeconds);
  const failed = steps.some((step) => step.status === "error");
  const note = closeNote
    ?? (canClose === true
      ? t("Tu peux fermer cette page : l’opération continue sans toi.")
      : canClose === false
        ? t("Garde cette page ouverte jusqu’à la fin de l’opération.")
        : null);
  return (
    <div
      data-testid={testId}
      data-wait-state={failed ? "error" : steps.every((step) => step.status === "done") ? "done" : "waiting"}
      className="mt-4 rounded-lg border border-border bg-surface/40 p-3 text-xs leading-relaxed"
    >
      {title && <p className="mb-2 font-medium text-foreground">{title}</p>}
      {description && <p className="mb-2 text-muted" data-testid={testId ? `${testId}-description` : undefined}>{description}</p>}
      <ol className="space-y-1.5" aria-live="polite">
        {steps.map((step) => (
          <li key={step.id} data-step={step.id} data-status={step.status} aria-current={step.status === "active" ? "step" : undefined} className="flex items-start gap-2">
            <StepMarker status={step.status} />
            <span className="min-w-0">
              <span className={STATUS_TEXT_CLASS[step.status]}>{step.label}</span>
              <span className="sr-only"> ({t(STATUS_LABEL[step.status])})</span>
              {step.detail && <span className="block text-muted">{step.detail}</span>}
            </span>
          </li>
        ))}
      </ol>
      {remaining && <p className="mt-2 text-muted" data-testid={testId ? `${testId}-remaining` : undefined}>{t(remaining.key, remaining.params)}</p>}
      {progress && <p className="mt-2 tabular-nums text-muted" data-testid={testId ? `${testId}-progress` : undefined}>{progress}</p>}
      {note && <p className="mt-1 text-muted" data-testid={testId ? `${testId}-close-note` : undefined}>{note}</p>}
    </div>
  );
}

function StepMarker({ status }: { status: WaitStepStatus }) {
  const base = "mt-0.5 inline-flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full";
  if (status === "done") {
    return (
      <span aria-hidden="true" className={`${base} bg-positive/20 text-positive`}>
        <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2.5 6.5 5 9l4.5-5.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </span>
    );
  }
  if (status === "error") {
    return (
      <span aria-hidden="true" className={`${base} bg-negative/20 text-negative`}>
        <svg viewBox="0 0 12 12" className="h-2.5 w-2.5" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3.5 3.5l5 5M8.5 3.5l-5 5" strokeLinecap="round" /></svg>
      </span>
    );
  }
  if (status === "active") {
    return <span aria-hidden="true" data-motion="spin" className={`${base} border-2 border-accent/30 border-t-accent motion-safe:animate-spin`} />;
  }
  return <span aria-hidden="true" className={`${base} border border-border`} />;
}
