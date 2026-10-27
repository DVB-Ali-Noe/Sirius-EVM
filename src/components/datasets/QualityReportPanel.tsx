"use client";

import { useId } from "react";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { formatCount } from "@/lib/copy/numbers";
import { hasQualitySignal, type QualityReport } from "@/lib/datasets/quality";

const COLUMN_CLASS = "rounded-full border border-border px-2 py-0.5 font-mono wrap-anywhere";

/** Cible qui change en silence : affichée au-dessus du résultat du contrôle, qui passe alors en ton avertissement. */
export function TargetShiftWarning({ shift }: { shift: NonNullable<QualityReport["targetShift"]> }) {
  const { t } = useLocale();
  return (
    <div role="alert" className="mt-2 rounded-lg border border-yellow-400/40 bg-yellow-400/10 p-3 text-xs text-foreground/90">
      <p className="font-medium text-yellow-400">{t("Cible différente de la dernière colonne : à vérifier")}</p>
      <p className="mt-1">
        {t("La dernière colonne, {expected}, contient des cellules vides ou non numériques : l’entraînement l’écarte et prendra {actual} comme cible.", {
          expected: shift.expected,
          actual: shift.actual,
        })}
      </p>
    </div>
  );
}

/**
 * Rapport de qualité (E1) : signalements « à vérifier », jamais des refus. Il reste dans la page :
 * aucun envoi, aucun stockage. Noms de colonnes et comptes seulement, jamais de valeur de cellule.
 * Le changement de cible est affiché à part, au-dessus du résultat du contrôle (`TargetShiftWarning`).
 */
export function QualityReportPanel({ report }: { report: QualityReport }) {
  const { t } = useLocale();
  const titleId = useId();
  const { excluded, textColumns, constant, duplicates, targetCopies, classBalance } = report;
  const signals = hasQualitySignal(report);

  return (
    <section aria-labelledby={titleId} className="mt-2 rounded-lg border border-border bg-surface/30 p-3 text-xs text-foreground/90">
      <h3 id={titleId} className="font-medium text-foreground">{t("Rapport de qualité")}</h3>

      {!signals && <p className="mt-2 text-muted">{t("Aucun signalement.")}</p>}

      <ul className="mt-2 flex flex-col gap-2 empty:hidden">
        {targetCopies.length > 0 && (
          <li>
            <p className="font-medium text-yellow-400">{t("Variables qui semblent recopier la cible : à vérifier")}</p>
            <ul className="mt-1 flex flex-wrap gap-1">
              {targetCopies.map((copy) => (
                <li key={copy.column} className={COLUMN_CLASS}>
                  {copy.column} ·{" "}
                  {copy.kind === "identical" ? t("identique") : copy.kind === "inverse" ? t("inverse (1 − cible)") : t("corrélation {value}", { value: copy.correlation })}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-muted">{t("Une variable qui contient la réponse donne un modèle trompeur. Retire-la si elle n’est pas connue au moment de prédire.")}</p>
          </li>
        )}
        {excluded.length > 0 && (
          <li>
            <p className="font-medium text-yellow-400">{t("Colonnes écartées par l’entraînement : à vérifier")}</p>
            <ul className="mt-1 flex flex-col gap-1">
              {excluded.map((column) => (
                <li key={column.column}>
                  <span className={COLUMN_CLASS}>{column.column}</span>{" "}
                  {t("{missing} vides, {invalid} non numériques", { missing: formatCount(column.missing), invalid: formatCount(column.invalid) })}
                </li>
              ))}
            </ul>
            <p className="mt-1 text-muted">{t("Une seule cellule vide ou non numérique écarte toute la colonne. Complète-les pour l’utiliser.")}</p>
            <p className="mt-1 text-muted">{t("Un nombre s’écrit en décimal avec un point (12.5, -3, 1e6) : une cellule faite d’espaces compte comme vide, une valeur 0x, 0b ou 0o n’est pas un nombre.")}</p>
          </li>
        )}
        {constant.length > 0 && (
          <li>
            <p className="font-medium text-yellow-400">{t("Colonnes constantes : à vérifier")}</p>
            <ul className="mt-1 flex flex-wrap gap-1">
              {constant.map((column) => <li key={column} className={COLUMN_CLASS}>{column}</li>)}
            </ul>
            <p className="mt-1 text-muted">{t("Une seule valeur sur tout le fichier : la colonne n’apporte aucune information.")}</p>
          </li>
        )}
        {duplicates.rows > 0 && (
          <li>
            <p className="font-medium text-yellow-400">{t("Lignes en double : à vérifier")}</p>
            <p className="mt-1">
              {t("{rows} lignes ont au moins un double sur les colonnes d’entraînement ; une même ligne revient jusqu’à {max} fois.", {
                rows: formatCount(duplicates.rows),
                max: formatCount(duplicates.maxRepeat),
              })}
            </p>
            <p className="mt-1 text-muted">{t("Les doublons peuvent être légitimes. Une ligne répétée pèse davantage et se mémorise plus facilement.")}</p>
          </li>
        )}
        {classBalance?.imbalanced && (
          <li>
            <p className="font-medium text-yellow-400">{t("Classes déséquilibrées : à vérifier")}</p>
            <p className="mt-1">
              {t("{zeros} lignes à 0, {ones} lignes à 1 : la classe minoritaire fait {share} % du fichier.", {
                zeros: formatCount(classBalance.zeros),
                ones: formatCount(classBalance.ones),
                share: (classBalance.minorityShare * 100).toFixed(1),
              })}
            </p>
          </li>
        )}
        {textColumns.length > 0 && (
          <li>
            <p className="text-muted">{t("Colonnes texte, ignorées par l’entraînement :")}</p>
            <ul className="mt-1 flex flex-wrap gap-1">
              {textColumns.map((column) => <li key={column} className={COLUMN_CLASS}>{column}</li>)}
            </ul>
          </li>
        )}
      </ul>

      <p className="mt-3 text-muted">{t("Ce rapport reste dans ton navigateur : il n’est ni envoyé, ni enregistré, et ne modifie pas ton fichier.")}</p>
    </section>
  );
}
