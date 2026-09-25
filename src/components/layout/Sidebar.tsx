"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ConnectButton } from "@/components/wallet/ConnectButton";
import { useLocale } from "@/components/i18n/LocaleProvider";

const NAV = [
  { href: "/dashboard", label: "Tableau de bord" },
  { href: "/train", label: "Entraîner" },
  { href: "/phala", label: "Phala" },
  { href: "/marketplace", label: "Marketplace" },
  { href: "/datasets", label: "Mes datasets" },
  { href: "/audit", label: "Audit" },
  { href: "/wallet", label: "Wallet" },
];

function LogoSlot() {
  return (
    <Link href="/dashboard" className="text-2xl font-semibold tracking-[-0.05em]">
      Sirius
    </Link>
  );
}

/** Sortie de l'app vers la landing (icône logout : flèche sortant d'une porte). */
function ExitButton({ className = "" }: { className?: string }) {
  const { t } = useLocale();

  return (
    <Link
      href="/"
      aria-label={t("Quitter vers l'accueil")}
      title={t("Quitter")}
      className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-[2rem] text-muted transition-colors hover:bg-background hover:text-foreground ${className}`}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
        <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
        <polyline points="16 17 21 12 16 7" />
        <line x1="21" x2="9" y1="12" y2="12" />
      </svg>
    </Link>
  );
}

function NavLinks({ vertical, onNavigate }: { vertical?: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  const { t } = useLocale();
  return (
    <nav className={vertical ? "flex flex-col gap-2" : "flex items-center gap-2"}>
      {NAV.map((item) => {
        const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
        return (
          <Link
            key={item.href}
            href={item.href}
            onClick={onNavigate}
            className={`rounded-[2rem] px-5 py-3 font-medium transition-[background-color,color,transform] duration-200 ${
              vertical ? "flex min-h-14 w-full items-center text-base" : "shrink-0 px-4 py-2.5 text-sm"} ${
              active
                ? "bg-accent text-background shadow-[0_8px_24px_rgba(255,255,255,0.1)]"
                : "text-muted hover:bg-background hover:text-foreground"
            }`}
          >
            {t(item.label)}
          </Link>
        );
      })}
    </nav>
  );
}

export function Sidebar() {
  return (
    <>
      <aside className="fixed inset-y-4 left-4 z-30 hidden w-[17rem] flex-col rounded-[2rem] border border-white/[0.12] bg-surface/55 p-3 shadow-[0_18px_60px_rgba(0,0,0,0.38)] backdrop-blur-2xl md:flex">
        <div className="flex h-14 shrink-0 items-center justify-between px-3">
          <LogoSlot />
        </div>
        <div className="flex-1 overflow-y-auto py-5">
          <NavLinks vertical />
        </div>
        <div className="flex items-center gap-2 rounded-[2rem] bg-background/40 p-2 backdrop-blur-xl">
          <div className="min-w-0 flex-1">
            <ConnectButton dropUp />
          </div>
          <ExitButton />
        </div>
      </aside>

      {/* Mobile : barre horizontale en haut */}
      <header className="fixed inset-x-0 top-0 z-30 flex h-16 items-center justify-between border-b border-border bg-surface/80 px-4 backdrop-blur-sm md:hidden">
        <LogoSlot />
        <div className="flex items-center gap-1">
          <ExitButton />
          <ConnectButton />
        </div>
      </header>
      {/* Le fondu à droite dit que la barre défile ; le `pr-12` laisse le dernier lien sortir du fondu en fin de course. */}
      <div className="fixed inset-x-0 top-16 z-30 overflow-x-auto border-b border-border bg-surface/60 py-2 pl-3 pr-12 backdrop-blur-sm [mask-image:linear-gradient(to_right,black_calc(100%-3rem),transparent)] md:hidden">
        <NavLinks />
      </div>
    </>
  );
}
