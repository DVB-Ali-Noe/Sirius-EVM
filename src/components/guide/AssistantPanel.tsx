"use client";

import { useEffect, useId, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { streamAssistantChat } from "@/lib/assistant/client";
import { ASSISTANT_MAX_MESSAGE_CHARS } from "@/lib/assistant/config";
import type { AssistantTurn } from "@/lib/assistant/validate";
import { contactMailtoHref } from "@/lib/copy/disclaimers";
import { GUIDE_NAME } from "@/lib/guide/machine";
import { GuideBlob } from "./GuideBlob";

/** Questions proposées ; chacune a aussi une réponse courte servie quand le chat est coupé. */
const SUGGESTIONS: readonly { question: string; answer: string }[] = [
  {
    question: "Comment emprunter un dataset ?",
    answer: "Ouvre la Marketplace, choisis un dataset et clique sur Emprunter : le prix et le compute sont bloqués en escrow, puis l’entraînement tourne dans un TEE.",
  },
  {
    question: "Pourquoi attendre ~15 minutes ?",
    answer: "Après le paiement, la chaîne doit atteindre la finalité (~15 min) avant que le job puisse démarrer. Laisse la page Entraîner ouverte ou reviens cliquer sur Lancer le job.",
  },
  {
    question: "Comment publier des données ?",
    answer: "Dans Mes datasets, importe un CSV : il est chiffré dans ton navigateur, puis publie son titre on-chain pour le rendre empruntable.",
  },
  {
    question: "Mes données sont-elles en sécurité ?",
    answer: "Les données brutes ne quittent jamais le chiffrement : l’entraînement tourne dans une enclave et l’emprunteur ne reçoit que le modèle.",
  },
];

interface Message extends AssistantTurn {
  id: number;
  /** Réponse en cours de réception. */
  streaming?: boolean;
  /** Message d'erreur (clé française) à la place d'une réponse. */
  error?: string;
}

let nextId = 1;

/**
 * Panneau de conversation avec Sirio : liste des messages, réponse en flux, questions suggérées,
 * erreurs lisibles, lien vers l'équipe. Non modal : Échap le ferme, le site reste utilisable.
 * L'historique vit dans ce composant (jamais en base) et seul le texte des messages et le chemin
 * de la page partent au serveur.
 */
export function AssistantPanel({ onClose, onReplay }: { onClose: () => void; onReplay: () => void }) {
  const { t } = useLocale();
  const pathname = usePathname();
  const [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [disabled, setDisabled] = useState<boolean | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const titleId = useId();

  useEffect(() => {
    inputRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      abortRef.current?.abort();
    };
  }, [onClose]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages]);

  async function ask(question: string) {
    const content = question.trim();
    if (!content || busy) return;
    setDraft("");
    const history = messages.filter((message) => !message.error && !message.streaming);
    const userMessage: Message = { id: nextId++, role: "user", content };
    const reply: Message = { id: nextId++, role: "assistant", content: "", streaming: true };
    setMessages([...history, userMessage, reply]);

    // Chat coupé sur l'instance : réponse locale pour les questions proposées, contact sinon.
    if (disabled) {
      const canned = SUGGESTIONS.find((item) => item.question === content);
      setMessages((current) => current.map((message) => message.id === reply.id
        ? { ...message, streaming: false, content: canned ? t(canned.answer) : "", error: canned ? undefined : "Assistant indisponible" }
        : message));
      return;
    }

    setBusy(true);
    const controller = new AbortController();
    abortRef.current = controller;
    // Les réponses repartent avec leur signature : le serveur écarte celles qu'il n'a pas signées.
    const turns: AssistantTurn[] = [...history, userMessage].map(({ role, content: text, signature }) =>
      role === "assistant" && signature ? { role, content: text, signature } : { role, content: text });
    const result = await streamAssistantChat(turns, pathname, (text) => {
      setMessages((current) => current.map((message) => message.id === reply.id ? { ...message, content: message.content + text } : message));
    }, controller.signal);
    setBusy(false);
    abortRef.current = null;
    setMessages((current) => current.map((message) => {
      if (message.id !== reply.id) return message;
      switch (result.status) {
        case "done":
          return { ...message, streaming: false, signature: result.signature, error: result.stopReason === "max_tokens" ? "Réponse coupée : pose une question plus précise." : undefined };
        case "refusal":
          return { ...message, streaming: false, content: "", error: "Sirio ne peut pas répondre à cette demande. Pose une question sur Sirius, ou écris à l’équipe." };
        case "disabled":
          setDisabled(true);
          return { ...message, streaming: false, content: "", error: "Le chat n’est pas activé sur cette instance. Voici les réponses les plus demandées :" };
        case "error":
          return { ...message, streaming: false, content: "", error: result.message };
      }
    }));
  }

  const lastUser = [...messages].reverse().find((message) => message.role === "user");
  const lastFailed = messages[messages.length - 1]?.error !== undefined && messages[messages.length - 1]?.role === "assistant";

  return (
    <div
      role="dialog"
      aria-labelledby={titleId}
      data-testid="guide-panel"
      className="fixed bottom-20 right-4 z-30 flex max-h-[min(70dvh,560px)] w-[min(92vw,380px)] flex-col overflow-hidden rounded-2xl border border-white/15 bg-surface/90 shadow-[0_24px_80px_rgba(0,0,0,0.55)] backdrop-blur-2xl animate-fade-in print:hidden"
    >
      <div className="flex items-center gap-3 border-b border-border px-4 py-3">
        <GuideBlob size={34} mood={busy ? "talking" : "idle"} />
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-sm font-semibold">{GUIDE_NAME}</h2>
          <p className="truncate text-[11px] text-muted">{t("Pose ta question sur Sirius")}</p>
        </div>
        <button type="button" onClick={onClose} aria-label={t("Fermer le panneau")} className="rounded-lg p-1.5 text-muted transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-accent">
          <svg width="16" height="16" viewBox="0 0 20 20" fill="none" aria-hidden><path d="M15 5L5 15M5 5l10 10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </button>
      </div>

      <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto overscroll-contain px-4 py-3" aria-live="polite" aria-busy={busy}>
        {messages.length === 0 && (
          <p className="text-xs leading-relaxed text-muted">
            {t("Sirio répond aux questions sur Sirius et l’utilisation du site. Il ne donne aucun conseil financier et ne demande jamais de clé privée.")}
          </p>
        )}
        {messages.map((message) => (
          <div key={message.id} className={message.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div
              className={`max-w-[85%] whitespace-pre-wrap rounded-2xl px-3.5 py-2 text-sm leading-relaxed wrap-anywhere ${
                message.role === "user" ? "bg-accent text-background" : "border border-border bg-background/60 text-foreground"
              }`}
            >
              {message.content}
              {message.streaming && message.content === "" && (
                <span className="inline-flex items-center gap-1" role="status" aria-label={t("Sirio réfléchit…")}>
                  {[0, 1, 2].map((i) => (
                    <span key={i} aria-hidden className="h-1.5 w-1.5 rounded-full bg-muted motion-safe:animate-bounce" style={{ animationDelay: `${i * 150}ms` }} />
                  ))}
                </span>
              )}
              {message.error && <p role="alert" className={`text-xs text-negative ${message.content ? "mt-2" : ""}`}>{t(message.error)}</p>}
            </div>
          </div>
        ))}
        {(messages.length === 0 || disabled) && (
          <div className="flex flex-wrap gap-1.5">
            {SUGGESTIONS.map((item) => (
              <button
                key={item.question}
                type="button"
                onClick={() => void ask(t(item.question))}
                disabled={busy}
                className="rounded-full border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:border-white/25 hover:text-foreground disabled:opacity-50"
              >
                {t(item.question)}
              </button>
            ))}
          </div>
        )}
        {lastFailed && lastUser && !disabled && (
          <button type="button" onClick={() => void ask(lastUser.content)} className="text-xs text-muted underline-offset-2 hover:text-foreground hover:underline">
            {t("Réessayer")}
          </button>
        )}
      </div>

      <form
        className="border-t border-border px-3 py-2"
        onSubmit={(event) => {
          event.preventDefault();
          void ask(draft);
        }}
      >
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value.slice(0, ASSISTANT_MAX_MESSAGE_CHARS))}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault();
                void ask(draft);
              }
            }}
            rows={1}
            maxLength={ASSISTANT_MAX_MESSAGE_CHARS}
            placeholder={t("Écris ta question…")}
            aria-label={t("Écris ta question…")}
            className="max-h-28 min-h-9 flex-1 resize-none rounded-xl border border-border bg-background/60 px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground focus:border-white/30 focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy || draft.trim().length === 0}
            aria-label={t("Envoyer la question")}
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-accent text-background transition-colors hover:bg-accent/90 disabled:opacity-40"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M5 12h14" /><path d="M13 6l6 6-6 6" /></svg>
          </button>
        </div>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px] text-muted">
          <button type="button" onClick={onReplay} className="underline-offset-2 hover:text-foreground hover:underline">{t("Revoir la visite guidée")}</button>
          <div className="flex items-center gap-3">
            {messages.length > 0 && (
              <button type="button" onClick={() => setMessages([])} disabled={busy} className="underline-offset-2 hover:text-foreground hover:underline disabled:opacity-50">
                {t("Effacer la conversation")}
              </button>
            )}
            <a href={contactMailtoHref()} className="underline-offset-2 hover:text-foreground hover:underline">{t("Contacter l’équipe")}</a>
          </div>
        </div>
      </form>
    </div>
  );
}
