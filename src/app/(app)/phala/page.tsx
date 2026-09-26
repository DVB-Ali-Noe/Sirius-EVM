import Link from "next/link";
import { PhalaDemo } from "@/components/phala-demo/PhalaDemo";

// Textes anglais écrits directement : un composant serveur n'a pas accès au contexte de locale.
export default function PhalaPage() {
  if (process.env.SIRIUS_PHALA_DEMO === "true") return <PhalaDemo />;
  const configured = process.env.SIRIUS_PHALA_DEMO_ORIGIN;
  let target: string | null = null;
  try {
    const url = new URL(configured ?? "");
    if (url.protocol === "https:" && !url.username && !url.password && url.origin === configured) target = `${url.origin}/phala`;
  } catch { /* L’espace dédié reste fermé tant que sa cible n’est pas configurée. */ }
  return <main className="mx-auto max-w-3xl px-6 py-12">
    <p className="text-sm text-muted">Sirius × confidential compute</p>
    <h1 className="mt-4 text-4xl font-semibold tracking-tight">Train with Phala</h1>
    <p className="mt-5 text-muted">Use a sample dataset or your own CSV to train a model inside a Phala enclave. Runs are sponsored by Sirius while the demo is open.</p>
    {target ? <a className="mt-8 inline-flex rounded-xl bg-accent px-6 py-3 text-background" href={target}>Open the Phala workspace</a>
      : <p className="mt-8 rounded-xl border border-border p-5">The demo is currently closed.</p>}
    <Link className="mt-8 block text-sm text-muted underline" href="/train">Standard training</Link>
  </main>;
}
