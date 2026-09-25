"use client";

import { useEffect, useState } from "react";
import { useWalletStore } from "@/stores/wallet";
import { ConnectCta } from "@/components/wallet/ConnectCta";
import { Card } from "@/components/ui/Card";
import type { ControllerStatus } from "@/lib/phala-demo/controller-client";

export default function DemoOperatorPage() {
  const identity = useWalletStore((state) => `${state.revision}:${state.authenticated}`);
  return <Operator key={identity} />;
}

function Operator() {
  const authenticated = useWalletStore((state) => state.authenticated);
  const [status, setStatus] = useState<ControllerStatus | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!authenticated) return;
    let cancelled = false;
    const update = async () => {
      try {
        const response = await fetch("/api/phala-demo/operator", { cache: "no-store" });
        const body = await response.json();
        if (cancelled) return;
        if (!response.ok) { setStatus(null); setError(body.error ?? "Accès refusé"); }
        else { setStatus(body); setError(""); }
      } catch { if (!cancelled) { setStatus(null); setError("Contrôleur indisponible"); } }
    };
    void update(); const timer = setInterval(() => void update(), 5000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [authenticated]);

  async function command(action: "open" | "close" | "emergency") {
    if (!status) return;
    setBusy(true); setError("");
    try {
      const response = await fetch("/api/phala-demo/operator", { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ command: action, revision: status.revision }) });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "Commande refusée");
      setStatus(body);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Commande refusée"); }
    finally { setBusy(false); }
  }

  const pending = busy || status?.phase === "opening" || status?.phase === "closing";
  return <main className="mx-auto max-w-3xl space-y-6 px-6 py-10"><h1 className="text-3xl font-semibold">Commandes Phala</h1>
    <p className="text-muted">Ouverture et fermeture manuelles. Aucun visiteur ne peut démarrer la machine.</p>
    {!authenticated && <ConnectCta>Connecter le wallet opérateur</ConnectCta>}
    {error && <p role="alert" className="text-red-300">{error}</p>}
    {status && <Card><dl className="grid gap-4 sm:grid-cols-2"><div><dt className="text-sm text-muted">État</dt><dd>{status.phase}</dd></div>
      <div><dt className="text-sm text-muted">Financement</dt><dd>{status.funding ?? "À lire à l’ouverture"}</dd></div>
      <div><dt className="text-sm text-muted">Opérations en cours</dt><dd>{status.activeOperations}</dd></div>
      <div><dt className="text-sm text-muted">Opérations de la session</dt><dd>{status.usedOperations}</dd></div></dl>
      <div className="mt-6 flex flex-wrap gap-3">{(["open", "close", "emergency"] as const).map((action) => <button key={action}
        className="rounded-xl border border-border px-5 py-3 disabled:opacity-40" disabled={busy || (action !== "emergency" && pending) || (action === "open" && status.phase === "open")}
        onClick={() => void command(action)}>{action === "open" ? "Activer" : action === "close" ? "Désactiver" : "Arrêt d’urgence"}</button>)}</div>
      {status.error && <p role="alert" className="mt-4 text-red-300">{status.error}</p>}
      <p className="mt-4 text-sm text-muted">Désactiver ferme les admissions, attend les résultats en cours puis arrête Phala. L’arrêt d’urgence peut interrompre un entraînement.</p>
    </Card>}
  </main>;
}
