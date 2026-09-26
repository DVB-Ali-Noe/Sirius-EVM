import Link from "next/link";
import { PhalaDemo } from "@/components/phala-demo/PhalaDemo";

export default function PhalaPage() {
  if (process.env.SIRIUS_PHALA_DEMO === "true") return <PhalaDemo />;
  const configured = process.env.SIRIUS_PHALA_DEMO_ORIGIN;
  let target: string | null = null;
  try {
    const url = new URL(configured ?? "");
    if (url.protocol === "https:" && !url.username && !url.password && url.origin === configured) target = `${url.origin}/phala`;
  } catch { /* L’espace dédié reste fermé tant que sa cible n’est pas configurée. */ }
  return <main className="mx-auto max-w-3xl px-6 py-12">
    <p className="text-sm text-muted">Sirius × calcul confidentiel</p>
    <h1 className="mt-4 text-4xl font-semibold tracking-tight">Entraîner avec Phala</h1>
    <p className="mt-5 text-muted">Utilise un dataset d’exemple ou ton propre CSV pour entraîner un modèle dans une enclave Phala. Les essais sont offerts par Sirius lorsque la démonstration est ouverte.</p>
    {target ? <a className="mt-8 inline-flex rounded-xl bg-accent px-6 py-3 text-background" href={target}>Accéder à l’espace Phala</a>
      : <p className="mt-8 rounded-xl border border-border p-5">La démonstration est fermée pour le moment.</p>}
    <Link className="mt-8 block text-sm text-muted underline" href="/train">Entraînements habituels</Link>
  </main>;
}
