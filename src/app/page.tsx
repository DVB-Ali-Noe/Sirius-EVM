"use client";

import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import { ConnectButton } from "@/components/wallet/ConnectButton";
import { ConnectCta } from "@/components/wallet/ConnectCta";
import { useBlobStore } from "@/stores/blob";
import { useWalletStore } from "@/stores/wallet";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { LanguageToggle } from "@/components/i18n/LanguageToggle";

gsap.registerPlugin(ScrollTrigger);
// Évite les recalculs de 100vh au show/hide de la barre d'adresse mobile (jank du pin).
ScrollTrigger.config({ ignoreMobileResize: true });

const XIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" className="h-7 w-7">
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
  </svg>
);

const LinkedInIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" className="h-7 w-7">
    <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
  </svg>
);

const GitHubIcon = () => (
  <svg viewBox="0 0 24 24" fill="currentColor" className="h-7 w-7">
    <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
  </svg>
);

const team = [
  {
    name: "Ali BEN YEZZA",
    image: "/images/image_ali.png",
    imageStyle: "",
    x: "https://x.com/AliBENYEZZ13187",
    linkedin: "https://www.linkedin.com/in/ali-ben-yezza/",
    github: "https://github.com/alibenyezza",
  },
  {
    name: "Noe WALES",
    image: "/images/avatar-noe.png",
    imageStyle: "object-[center_15%]",
    x: "https://x.com/nooeeww",
    linkedin: "https://www.linkedin.com/in/noé-w",
    github: "https://github.com/CHAAIISE",
  },
];

/** Avatar circulaire qui se retourne au survol pour révéler les réseaux sociaux. */
function AvatarCard({
  name,
  image,
  imageStyle,
  x,
  linkedin,
  github,
}: {
  name: string;
  image: string;
  imageStyle: string;
  x: string;
  linkedin: string;
  github: string;
}) {
  const { t } = useLocale();
  const [flipped, setFlipped] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  const handleMouseEnter = () => {
    clearTimer();
    setFlipped(true);
  };

  const handleMouseLeave = () => {
    timerRef.current = setTimeout(() => setFlipped(false), 250);
  };

  useEffect(() => () => clearTimer(), []);

  return (
    <div className="flex flex-col items-center">
      <div
        className="h-[220px] w-[220px] cursor-pointer md:h-[280px] md:w-[280px]"
        style={{ perspective: "1000px" }}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
      >
        <div
          className="relative h-full w-full transition-transform duration-500"
          style={{ transformStyle: "preserve-3d", transform: flipped ? "rotateY(180deg)" : "rotateY(0deg)" }}
        >
          <div className="absolute inset-0 overflow-hidden rounded-full border border-border" style={{ backfaceVisibility: "hidden" }}>
            <Image
              src={image}
              alt={name}
              fill
              sizes="(min-width: 768px) 280px, 220px"
              className={`object-cover ${imageStyle}`}
            />
          </div>

          <div
            className="absolute inset-0 overflow-hidden rounded-full border border-border"
            style={{ backfaceVisibility: "hidden", transform: "rotateY(180deg)" }}
          >
            <Image
              src={image}
              alt=""
              aria-hidden
              fill
              sizes="(min-width: 768px) 280px, 220px"
              className={`object-cover ${imageStyle}`}
              style={{ transform: "scaleX(-1)" }}
            />
            <div className="absolute inset-0 flex items-center justify-center gap-6 bg-black/70">
              <a href={x} target="_blank" rel="noopener noreferrer" aria-label={t("{name} sur X", { name })} className="text-white transition-transform hover:scale-125" onClick={(e) => e.stopPropagation()}>
                <XIcon />
              </a>
              <a href={linkedin} target="_blank" rel="noopener noreferrer" aria-label={t("{name} sur LinkedIn", { name })} className="text-white transition-transform hover:scale-125" onClick={(e) => e.stopPropagation()}>
                <LinkedInIcon />
              </a>
              <a href={github} target="_blank" rel="noopener noreferrer" aria-label={t("{name} sur GitHub", { name })} className="text-white transition-transform hover:scale-125" onClick={(e) => e.stopPropagation()}>
                <GitHubIcon />
              </a>
            </div>
          </div>
        </div>
      </div>
      <p className="mt-6 text-center text-lg font-medium tracking-tight text-foreground md:text-xl">{name}</p>
    </div>
  );
}

function PageBottom() {
  const { t } = useLocale();
  return (
    <div className="relative">
      <section className="relative z-10 px-8 py-24 md:px-16 md:py-32">
        <div className="mx-auto max-w-5xl">
          <div className="flex flex-wrap items-center justify-between gap-6">
            <h2 className="text-4xl font-semibold tracking-tight text-foreground md:text-5xl">{t("About us")}</h2>
            <a
              href="https://devinciblockchain.com/"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 opacity-80 transition-opacity hover:opacity-100"
            >
              <Image
                src="/images/devinci-blockchain.png"
                alt="DeVinci Blockchain"
                width={1228}
                height={1244}
                sizes="56px"
                className="h-12 w-auto md:h-14"
              />
              <span className="text-left text-sm leading-tight text-foreground md:text-base">
                DeVinci
                <br />
                Blockchain
              </span>
            </a>
          </div>

          <div className="mt-20 flex flex-col items-center justify-center gap-16 md:mt-28 md:flex-row md:gap-24 lg:gap-32">
            {team.map((m) => (
              <AvatarCard key={m.name} {...m} />
            ))}
          </div>
        </div>
      </section>

      <footer className="relative z-10 flex flex-col items-center gap-3 border-t border-border px-6 py-8 text-center">
        <Link href="/docs" className="text-sm text-muted underline-offset-4 transition-colors hover:text-foreground hover:underline">
          {t("Documentation")}
        </Link>
        <p className="text-xs tracking-widest text-muted">{t("Sirius — data lending confidentiel sur EVM")}</p>
      </footer>
    </div>
  );
}

export default function Home() {
  const { t } = useLocale();
  const connected = useWalletStore((s) => s.connected);
  const heroRef = useRef<HTMLDivElement>(null);
  const connectRef = useRef<HTMLDivElement>(null);
  const uiOverlayRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const { setScrollDriven, setScrollProgress } = useBlobStore.getState();
    setScrollDriven(true);

    window.history.scrollRestoration = "manual";
    window.scrollTo({ top: 0, behavior: "instant" });
    document.documentElement.scrollTop = 0;

    // a11y : pas de scroll fluide forcé pour les utilisateurs "réduire les animations"
    // (risque vestibulaire). On retombe sur le scroll natif ; le zoom reste scroll-piloté.
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let lenis: Lenis | null = null;
    let rafFn: ((time: number) => void) | null = null;
    if (!reduced) {
      lenis = new Lenis({
        duration: 1.4,
        easing: (t: number) => Math.min(1, 1.001 - Math.pow(2, -10 * t)),
      });
      lenis.stop();
      lenis.scrollTo(0, { immediate: true });
      lenis.start();
      lenis.on("scroll", ScrollTrigger.update);
      rafFn = (time: number) => lenis!.raf(time * 1000);
      gsap.ticker.add(rafFn);
      gsap.ticker.lagSmoothing(0);
    }

    const trigger = ScrollTrigger.create({
      trigger: heroRef.current,
      start: "top top",
      end: "bottom bottom",
      pin: ".hero-pin",
      scrub: 0.8,
      onUpdate: (self) => {
        setScrollProgress(self.progress);

        const raw = Math.min(1, Math.max(0, (self.progress - 0.03) / 0.77));
        if (uiOverlayRef.current) {
          const zoom = 1 + raw * raw * 8;
          uiOverlayRef.current.style.transform = `scale(${zoom})`;
        }
        if (connectRef.current) {
          const btnProgress = Math.min(1, Math.max(0, (self.progress - 0.6) / 0.1));
          connectRef.current.style.opacity = String(btnProgress);
          connectRef.current.style.pointerEvents = self.progress >= 0.65 ? "auto" : "none";
        }
      },
    });

    return () => {
      setScrollDriven(false);
      setScrollProgress(0);
      if (lenis) {
        lenis.stop();
        lenis.destroy();
      }
      if (rafFn) {
        gsap.ticker.remove(rafFn);
        gsap.ticker.lagSmoothing(500, 33); // restaure le défaut GSAP
      }
      trigger.kill();
      ScrollTrigger.getAll().forEach((t) => t.kill());
      ScrollTrigger.clearScrollMemory();
      ScrollTrigger.refresh();
      document.querySelectorAll(".pin-spacer").forEach((el) => {
        const child = el.firstElementChild;
        if (child) el.parentNode?.replaceChild(child, el);
        else el.remove();
      });
      window.history.scrollRestoration = "auto";
      window.scrollTo({ top: 0, left: 0, behavior: "instant" });
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    };
  }, []);

  return (
    <main className="relative z-10 text-foreground">
      <div className="fixed right-0 top-0 z-30 flex items-center gap-2 p-6 sm:p-8">
        <LanguageToggle />
        <ConnectButton />
      </div>

      <div ref={heroRef} className="relative h-[700vh]">
        <div className="hero-pin pointer-events-none relative h-screen w-screen overflow-hidden">
          <div
            ref={uiOverlayRef}
            className="pointer-events-none absolute inset-0 z-10 flex flex-col justify-between"
            style={{ transformOrigin: "center center" }}
          >
            <div className="flex items-start justify-between p-8 md:p-12">
              <h1 className="text-4xl font-semibold tracking-tight text-foreground md:text-5xl">Sirius</h1>
            </div>
          </div>

          <div
            ref={connectRef}
            className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center px-6"
            style={{ opacity: 0 }}
          >
            <div className="flex max-w-xl flex-col items-center text-center">
              <h2 className="text-6xl font-semibold tracking-tight text-foreground md:text-7xl">Sirius</h2>
              <p className="mt-6 text-lg leading-snug text-muted md:text-xl">
                {t("Vos données, exploitables sans jamais les exposer.")}
              </p>
              <div className="mt-12 flex flex-col items-center gap-5">
                {connected ? (
                  <Link
                    href="/dashboard"
                    className="rounded-xl bg-accent px-8 py-4 text-base font-medium text-background transition-colors hover:bg-accent/90"
                  >
                    {t("Accéder à l’app")}
                  </Link>
                ) : (
                  <ConnectCta size="lg">{t("Connecter un wallet")}</ConnectCta>
                )}
                <Link
                  href="/docs"
                  className="text-sm font-medium text-muted underline-offset-4 transition-colors hover:text-foreground hover:underline"
                >
                  {t("Lire la documentation")}
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>

      <PageBottom />
    </main>
  );
}
