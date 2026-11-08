"use client";

import { useState } from "react";
import { Modal } from "@/components/ui/Modal";
import { WaitSteps, type WaitStep } from "@/components/ui/WaitSteps";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { messageOf } from "@/lib/errors-client";
import { API_KEY_NAME_MAX_LENGTH, createApiKey, type ApiKeyCreationStep, type CreatedApiKey } from "@/lib/train/api-keys-client";
import { retryWhileEnclaveStarts } from "@/lib/train/enclave-wait";
import { EnclaveStartingSteps } from "./EnclaveStartingSteps";
import { useUnmountSignal } from "@/components/ui/useUnmountSignal";

const STEP_ORDER: readonly ApiKeyCreationStep[] = ["preparing", "sealing", "signing", "registering"];

/**
 * Création d'une clé API (D-30) : nom, puis génération et scellement dans le navigateur,
 * autorisation signée par la session wallet, enregistrement dans l'enclave. La clé complète
 * n'est affichée qu'une fois : fermer la fenêtre l'efface de la page. `revealed` : clé déjà créée
 * d'office après le règlement (D-32), affichée directement avec le même avertissement.
 */
export function CreateApiKeyDialog({
  open,
  loanId,
  revealed = null,
  onClose,
  onCreated,
}: {
  open: boolean;
  loanId: string;
  revealed?: CreatedApiKey | null;
  onClose: () => void;
  onCreated: () => void;
}) {
  const { t } = useLocale();
  const [name, setName] = useState("");
  const [step, setStep] = useState<ApiKeyCreationStep | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedApiKey | null>(null);
  const [copied, setCopied] = useState(false);
  const [enclaveRetry, setEnclaveRetry] = useState<number | null>(null);
  const unmountSignal = useUnmountSignal();
  const shown = created ?? revealed;
  const working = step !== null && !failed && !shown;

  function close() {
    if (working) return;
    setName("");
    setStep(null);
    setFailed(null);
    setCreated(null);
    setCopied(false);
    onClose();
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (working) return;
    setFailed(null);
    setStep("preparing");
    try {
      const key = await retryWhileEnclaveStarts(
        () => createApiKey({ loanId, name, onStep: setStep }),
        { onWaiting: setEnclaveRetry, signal: unmountSignal() },
      );
      setCreated(key);
      onCreated();
    } catch (error) {
      setFailed(messageOf(error));
    }
  }

  async function copy() {
    if (!shown) return;
    await navigator.clipboard?.writeText(shown.token).then(() => setCopied(true), () => setCopied(false));
  }

  const labels: Record<ApiKeyCreationStep, string> = {
    preparing: t("Vérification de l’accès et de l’enclave"),
    sealing: t("Génération de la clé et scellement du secret pour l’enclave"),
    signing: t("Signature de l’autorisation"),
    registering: t("Enregistrement dans l’enclave"),
  };
  const current = step ? STEP_ORDER.indexOf(step) : -1;
  const steps: WaitStep[] = STEP_ORDER.map((id, index) => ({
    id,
    label: labels[id],
    status: shown || index < current ? "done" : index === current ? (failed ? "error" : "active") : "pending",
  }));

  return (
    <Modal open={open} onClose={close} title={revealed ? t("Ta clé API") : t("Créer une clé API")}>
      <div role="dialog" aria-modal="true" aria-label={revealed ? t("Ta clé API") : t("Créer une clé API")} data-testid="create-api-key-dialog" className="space-y-4 text-sm">
        {shown ? (
          <div className="space-y-3" data-testid="api-key-created">
            {revealed && (
              <p className="text-xs text-muted" data-testid="api-key-auto-created">
                {t("Ta location inclut l’API : une clé « {name} » vient d’être créée pour ce prêt.", { name: revealed.name })}
              </p>
            )}
            <p className="rounded-lg border border-yellow-400/30 bg-yellow-400/5 p-3 text-xs text-yellow-400" role="alert">
              {t("Copie cette clé maintenant : elle ne sera plus jamais affichée. Sirius ne la conserve pas en clair ; seule l’enclave en garde le secret.")}
            </p>
            <code data-testid="api-key-secret" className="block break-all rounded-lg border border-border bg-background/60 p-3 font-mono text-xs text-foreground">
              {shown.token}
            </code>
            <div className="flex flex-wrap justify-end gap-3">
              <button type="button" onClick={() => void copy()} className="rounded-lg border border-border px-4 py-2 text-sm">
                {copied ? t("Copié") : t("Copier")}
              </button>
              <button type="button" onClick={close} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-background">
                {t("J’ai copié la clé")}
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={(event) => void submit(event)} className="space-y-3">
            <label className="block text-xs text-muted">
              {t("Nom de la clé")}
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={API_KEY_NAME_MAX_LENGTH}
                required
                disabled={working}
                placeholder={t("ex. serveur de production")}
                className="mt-1 w-full rounded-xl border border-border bg-surface px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted focus:border-accent"
              />
            </label>
            <p className="text-xs text-muted">
              {t("La clé est générée dans ton navigateur. Son secret est chiffré pour l’enclave avant d’être envoyé : ni Sirius ni le serveur web ne peuvent signer d’appel à ta place.")}
            </p>
            {step && (
              <WaitSteps
                testId="api-key-steps"
                steps={steps}
                canClose={failed ? undefined : false}
              />
            )}
            {failed && <p role="alert" className="text-xs text-negative">{t(failed)}</p>}
            {enclaveRetry !== null && !failed && (
              <EnclaveStartingSteps phase="starting" retryInSeconds={enclaveRetry} testId="api-key-enclave-starting" />
            )}
            <div className="flex flex-wrap justify-end gap-3">
              <button type="button" onClick={close} disabled={working} className="rounded-lg border border-border px-4 py-2 text-sm disabled:opacity-50">{t("Annuler")}</button>
              <button type="submit" disabled={working || !name.trim()} aria-busy={working} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-background disabled:opacity-50">
                {working ? t("Création…") : failed ? t("Réessayer") : t("Créer la clé")}
              </button>
            </div>
          </form>
        )}
      </div>
    </Modal>
  );
}
