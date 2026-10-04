"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { DisclaimerNote } from "@/components/ui/DisclaimerNote";
import { TOUR_UI, type TourStep } from "@/lib/tour/content";

/** Éléments qui peuvent recevoir le focus au clavier, dans l'ordre du document. */
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusableIn(root: HTMLElement): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) => element.getClientRects().length > 0);
}

interface TourDialogProps {
  /** Petit libellé au-dessus du titre (« Guided tour », « Page guide »), déjà traduit. */
  eyebrow: string;
  steps: readonly TourStep[];
  /** Toute fermeture : terminer, passer, Échap. */
  onClose: () => void;
}

/**
 * Fenêtre modale des tutos.
 *
 * Accessibilité : `role="dialog"` + `aria-modal`, titre et texte reliés par
 * `aria-labelledby` / `aria-describedby`, focus placé sur l'action principale à
 * l'ouverture, piégé dans la fenêtre (Tab et Maj+Tab bouclent sur ses boutons et liens,
 * et y ramènent un focus resté sur le corps de la page), Échap ferme, et le focus revient
 * à l'élément qui l'avait avant l'ouverture. Le fond recouvre toute la page : la souris
 * ne peut rien atteindre derrière. Un clic sur le fond ne ferme pas : une fermeture
 * accidentelle vaudrait « vu ».
 *
 * Volontairement, la fenêtre ne reprend pas de force un focus parti dans une autre
 * fenêtre posée au-dessus (wallet embarqué, devis) : elle en bloquerait la saisie. Échap
 * et Tab ne sont alors pas interceptés non plus.
 */
export function TourDialog({ eyebrow, steps, onClose }: TourDialogProps) {
  const { t } = useLocale();
  const [index, setIndex] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const titleId = useId();
  const bodyId = useId();

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  // Ouverture : mémorise le focus précédent, le place dans la fenêtre, installe le piège.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    primaryRef.current?.focus();

    function onKeyDown(event: KeyboardEvent) {
      const root = rootRef.current;
      if (!root) return;
      const current = document.activeElement;
      const inside = current instanceof Node && root.contains(current);
      // Focus parti dans une autre fenêtre (wallet embarqué, devis) : on ne lui vole ni le
      // focus ni la touche Échap.
      if (!inside && current && current !== document.body && current !== document.documentElement) return;
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const items = focusableIn(root);
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      if (!inside) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && current === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      // Rend le focus à l'élément d'origine s'il est encore dans la page.
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  // Changement d'étape : un bouton qui disparaît (« Précédent » à la première étape) ne
  // doit pas laisser le focus sur le corps de la page.
  useEffect(() => {
    const root = rootRef.current;
    if (root && !root.contains(document.activeElement)) primaryRef.current?.focus();
  }, [index]);

  const count = steps.length;
  const safeIndex = Math.min(index, count - 1);
  const step = steps[safeIndex];
  if (!step) return null;
  const isLast = safeIndex === count - 1;
  const multi = count > 1;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm">
      <div
        ref={rootRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        data-tour-dialog=""
        className="max-h-[calc(100dvh-2rem)] w-full max-w-md overflow-y-auto rounded-2xl border border-border bg-surface p-6 shadow-xl wrap-anywhere"
      >
        <div className="text-xs uppercase tracking-wider text-muted">
          {eyebrow}
          {multi && (
            <>
              {" · "}
              {t(TOUR_UI.step, { current: safeIndex + 1, total: count })}
            </>
          )}
        </div>
        <h2 id={titleId} className="mt-2 text-xl font-semibold tracking-tight">
          {t(step.title)}
        </h2>
        <div id={bodyId} className="mt-3 space-y-2 text-sm leading-relaxed text-muted">
          {step.body.map((paragraph) => (
            <p key={paragraph}>{t(paragraph)}</p>
          ))}
        </div>
        {step.limits && step.limits.length > 0 && (
          <div className="mt-4">
            <h3 className="text-xs font-medium uppercase tracking-wider text-foreground/80">{t(TOUR_UI.limits)}</h3>
            <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm leading-relaxed text-muted">
              {step.limits.map((limit) => (
                <li key={limit}>{t(limit)}</li>
              ))}
            </ul>
          </div>
        )}
        {step.disclaimers && step.disclaimers.length > 0 && (
          <DisclaimerNote className="mt-4" messages={step.disclaimers} />
        )}

        {multi && (
          <div aria-hidden="true" className="mt-5 flex items-center gap-1.5">
            {steps.map((item, i) => (
              <span
                key={item.title}
                className={`h-1.5 rounded-full transition-all ${i === safeIndex ? "w-5 bg-foreground" : "w-1.5 bg-border"}`}
              />
            ))}
          </div>
        )}

        <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
          {multi && !isLast ? (
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg text-sm text-muted transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {t(TOUR_UI.skip)}
            </button>
          ) : (
            <span />
          )}
          <div className="flex items-center gap-2">
            {multi && safeIndex > 0 && (
              <button
                type="button"
                onClick={() => setIndex(safeIndex - 1)}
                className="rounded-xl border border-border bg-surface px-4 py-2 text-sm font-medium text-foreground transition-colors hover:border-white/20 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
              >
                {t(TOUR_UI.previous)}
              </button>
            )}
            <button
              ref={primaryRef}
              type="button"
              onClick={() => (isLast ? onClose() : setIndex(safeIndex + 1))}
              className="rounded-xl bg-accent px-4 py-2 text-sm font-medium text-background transition-colors hover:bg-accent/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              {!multi ? t(TOUR_UI.close) : isLast ? t(TOUR_UI.finish) : t(TOUR_UI.next)}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
