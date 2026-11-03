"use client";

import { useState } from "react";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { MIN_RENTAL_DAYS, isValidRentalDays } from "@/lib/billing/rental";

/**
 * Choix du nombre de jours de location (D-29) : emprunt, réentraînement et prolongation.
 * Seul un entier de 1 à `max` est remonté ; une saisie en cours invalide reste affichée telle
 * quelle sans changer la valeur retenue, puis est remplacée par celle-ci à la sortie du champ.
 */
export function RentalDaysInput({
  value,
  max,
  onChange,
  disabled,
  label = "Durée de location (jours)",
}: {
  value: number;
  max: number;
  onChange: (days: number) => void;
  disabled?: boolean;
  /** Clé de traduction du libellé. */
  label?: string;
}) {
  const { t } = useLocale();
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{t(label)}</span>
      <input
        type="number"
        name="rentalDays"
        inputMode="numeric"
        min={MIN_RENTAL_DAYS}
        max={max}
        step={1}
        value={draft ?? String(value)}
        disabled={disabled}
        onChange={(event) => {
          setDraft(event.target.value);
          const days = Number(event.target.value);
          if (isValidRentalDays(days, max)) onChange(days);
        }}
        onBlur={() => setDraft(null)}
        className="w-28 rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm tabular-nums outline-hidden focus:border-white/30"
      />
    </label>
  );
}
