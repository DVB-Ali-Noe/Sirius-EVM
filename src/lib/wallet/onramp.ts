"use client";

/**
 * Ouvre le widget d'achat MoonPay. La fenêtre est ouverte de façon SYNCHRONE dans le
 * handler de clic (l'activation utilisateur ne survit pas à un `await` sur Safari →
 * popup bloquée), puis redirigée vers l'URL signée récupérée du serveur.
 */
export async function openMoonpay(): Promise<void> {
  const win = window.open("about:blank", "moonpay", "popup,width=460,height=720");
  try {
    const res = await fetch("/api/onramp");
    const body = await res.json();
    if (!res.ok) throw new Error(body.error ?? "On-ramp indisponible");
    if (win) win.location.href = body.url;
  } catch {
    // Config manquante (503) ou popup bloquée : on referme la fenêtre vide.
    win?.close();
  }
}
