import Link from "next/link";
import { DocSection } from "@/app/docs/DocsShell";
import { LegalShell } from "@/components/layout/LegalShell";
import { legalSectionId } from "@/lib/copy/legal-sections";
import type { Metadata } from "next";
import { CONTACT_EMAIL } from "@/lib/copy/disclaimers";

/**
 * Mentions légales. Texte en anglais, page serveur publique, comme les conditions.
 *
 * Sirius n'est pas une société immatriculée : l'éditeur est « Sirius », joignable à
 * l'adresse de contact. Aucune donnée personnelle des fondateurs (nom, adresse, téléphone,
 * numéro d'immatriculation) n'apparaît ici ; un champ sans valeur réelle est omis, jamais
 * rempli d'un texte d'attente. Les prestataires cités sont ceux réellement utilisés
 * (docs/passage-mainnet/19-mise-en-production.md, deploy/operations/supplier-limits.json).
 * `legal.test.ts` vérifie ces points.
 */

export const metadata: Metadata = {
  title: "Legal notice · Sirius",
  description: "Publisher, hosting and service providers of Sirius.",
};

const LAST_UPDATED = "6 October 2026";

const SECTIONS: [string, string[]][] = [
  ["Hosting", [
    "Web application: Vercel Inc., 440 N Barranca Ave #4133, Covina, CA 91723, USA.",
    "Confidential compute: Phala Cloud, operated by Phala Network. Training runs inside Intel TDX hardware enclaves, as described on the status page.",
  ]],
  ["Service providers", [
    "Neon: managed PostgreSQL database.",
    "Pinata: IPFS storage of encrypted datasets and models.",
    "OVHcloud: server running the background settlement tasks.",
    "Web3Auth: optional sign-in with a Google account.",
    "Alchemy: blockchain node access to Robinhood Chain.",
  ]],
  ["Blockchain", [
    "Loans, payments and wallet verifications are recorded on Robinhood Chain, a public blockchain that Sirius does not operate.",
  ]],
];

const TOC = [
  { id: legalSectionId("Publisher"), label: "Publisher" },
  ...SECTIONS.map(([title]) => ({ id: legalSectionId(title), label: title })),
];

export default function LegalPage() {
  return (
    <LegalShell title="Legal notice" lead={<p>Last updated {LAST_UPDATED}.</p>} toc={TOC}>
      <DocSection id={legalSectionId("Publisher")} title="Publisher">
        <p>
          This site, sirius-data.tech, is published by Sirius. Contact:{" "}
          <a href={`mailto:${CONTACT_EMAIL}`} className="text-foreground underline underline-offset-4 hover:text-muted">{CONTACT_EMAIL}</a>.
        </p>
      </DocSection>
      {SECTIONS.map(([title, items]) => (
        <DocSection key={title} id={legalSectionId(title)} title={title}>
          <ul className="ml-5 list-disc space-y-2 marker:text-muted">
            {items.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </DocSection>
      ))}
      <p className="mt-8 text-sm text-muted">
        See also the <Link href="/terms" className="text-foreground underline underline-offset-4 hover:text-muted">terms</Link> and the{" "}
        <Link href="/privacy" className="text-foreground underline underline-offset-4 hover:text-muted">privacy policy</Link>.
      </p>
    </LegalShell>
  );
}
