"use client";

import { useLocale, type Locale } from "./LocaleProvider";

const LOCALES: Locale[] = ["fr", "en"];

export function LanguageToggle() {
  const { locale, setLocale } = useLocale();

  return (
    <div className="flex rounded-[2rem] border border-white/[0.1] bg-background/50 p-1 text-xs font-semibold tracking-wide shadow-[0_8px_24px_rgba(0,0,0,0.2)] backdrop-blur-xl" role="group" aria-label="Language">
      {LOCALES.map((item) => (
        <button
          key={item}
          type="button"
          onClick={() => setLocale(item)}
          aria-pressed={locale === item}
          className={`rounded-[2rem] px-2.5 py-1.5 transition-colors ${
            locale === item ? "bg-accent text-background" : "text-muted hover:text-foreground"
          }`}
        >
          {item.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
