import Link from "next/link";
import type { Metadata } from "next";

/** Conditions de la bêta mainnet. Texte en anglais, page serveur publique. */

export const metadata: Metadata = {
  title: "Beta terms · Sirius",
  description: "Terms of the Sirius mainnet beta.",
};

const SECTIONS: [string, string[]][] = [
  ["What the beta is", [
    "Sirius lets a data provider rent access to an encrypted dataset for model training, and a borrower pay to obtain only the trained model.",
    "The mainnet beta uses real USDC on Robinhood Chain. It is limited on purpose: loans are capped, total exposure is capped, and access is by invitation.",
  ]],
  ["Risks you accept", [
    "The smart contracts have not been externally audited. A defect could lock or lose the funds of a loan.",
    "Transactions on a blockchain are final. A payment confirmed on-chain cannot be reversed by Sirius.",
    "The service may be paused, limited or interrupted at any time to protect users. Locked funds remain governed by the contract: the borrower can be refunded after the deadline.",
  ]],
  ["Your responsibilities", [
    "Only publish data you have the right to share and to license for training.",
    "Keep control of your wallet. Sirius never asks for your private key or seed phrase.",
    "Do not use the service from a country or for a purpose where it would be unlawful.",
  ]],
  ["What Sirius commits to", [
    "Datasets are encrypted in your browser before upload and decrypted only inside the training environment described on the status page.",
    "Every loan is recorded on-chain and listed in the audit ledger.",
    "Limits, environment and audit status are published on the status page and kept up to date.",
  ]],
];

export default function TermsPage() {
  return (
    <main className="mx-auto w-full max-w-2xl px-6 py-12">
      <p className="text-xs uppercase tracking-[0.11em] text-muted">Mainnet beta</p>
      <h1 className="mt-2 text-3xl font-semibold tracking-tight">Beta terms</h1>
      <p className="mt-3 text-sm text-muted">Last updated 1 October 2026. See the current limits on the <Link href="/status" className="text-accent hover:text-accent/80">status page</Link>.</p>
      {SECTIONS.map(([title, items]) => (
        <section key={title} className="mt-8">
          <h2 className="text-lg font-semibold">{title}</h2>
          <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-muted">
            {items.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </section>
      ))}
    </main>
  );
}
