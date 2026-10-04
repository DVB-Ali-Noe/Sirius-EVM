/**
 * Rendu HTML statique des tutos, pour `tour-dialog.test.ts`.
 *
 * Tourne dans un processus à part, sans la condition `react-server` de `pnpm test` (sous
 * cette condition React n'expose ni contexte ni `react-dom/server`), comme
 * `src/components/ui/shared-components.render.tsx`.
 *
 * Sortie : un objet JSON { nom du cas: HTML } sur la sortie standard.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { LocaleProvider } from "@/components/i18n/LocaleProvider";
import { ProductTour } from "@/components/layout/ProductTour";
import { PAGE_TOURS, WELCOME_STEPS } from "@/lib/tour/content";
import { TOUR_PAGE_KEYS } from "@/lib/tour/keys";
import { PageTour } from "./PageTour";
import { TourDialog } from "./TourDialog";

const noop = () => {};

const cases: Record<string, React.ReactNode> = {
  welcome: <TourDialog eyebrow="Guided tour" steps={WELCOME_STEPS} onClose={noop} />,
  "welcome-last": <TourDialog eyebrow="Guided tour" steps={WELCOME_STEPS.slice(-1)} onClose={noop} />,
  "welcome-beta": <TourDialog eyebrow="Guided tour" steps={[WELCOME_STEPS[4]]} onClose={noop} />,
  "empty-steps": <TourDialog eyebrow="Guided tour" steps={[]} onClose={noop} />,
  // Rendu serveur des composants montés par le layout : rien tant que le client n'a pas démarré.
  "server-product-tour": <ProductTour />,
  "server-page-tour": <PageTour />,
};
for (const key of TOUR_PAGE_KEYS) {
  cases[`page-${key}`] = <TourDialog eyebrow="Page guide" steps={[PAGE_TOURS[key]]} onClose={noop} />;
}

const out: Record<string, string> = {};
for (const [name, node] of Object.entries(cases)) {
  out[name] = renderToStaticMarkup(<LocaleProvider>{node}</LocaleProvider>);
}
process.stdout.write(JSON.stringify(out));
