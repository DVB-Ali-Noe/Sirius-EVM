"use client";

import { DocsShell, type DocsPage, type TocItem } from "@/app/docs/DocsShell";

const LEGAL_PAGES: DocsPage[] = [
  { href: "/terms", group: "Legal", tab: "Terms", label: "Beta terms" },
  { href: "/privacy", group: "Legal", tab: "Privacy", label: "Privacy policy" },
  { href: "/legal", group: "Legal", tab: "Legal notice", label: "Legal notice" },
];

/** Pages légales dans la mise en page de la documentation : en-tête, menu, sommaire, sections. */
export function LegalShell({ title, lead, toc, children }: { title: string; lead: React.ReactNode; toc: TocItem[]; children: React.ReactNode }) {
  return (
    <DocsShell pages={LEGAL_PAGES} section="Legal" title={title} lead={lead} toc={toc} tocLabel={(label) => label}>
      {children}
    </DocsShell>
  );
}
