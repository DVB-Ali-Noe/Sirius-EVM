"use client";

import { useEffect } from "react";
import Link from "next/link";
import { ConnectButton } from "@/components/wallet/ConnectButton";
import { APP_BACKGROUND_BLOB_Z, useBlobStore } from "@/stores/blob";
import { LanguageToggle } from "@/components/i18n/LanguageToggle";
import { useLocale } from "@/components/i18n/LocaleProvider";

/* ------------------------------------------------------------------ */
/* Schémas — SVG monochromes, viewBox responsive (scale à 100%).       */
/* ------------------------------------------------------------------ */

const C = {
  fill: "#131313",
  stroke: "#2a2a2a",
  strokeStrong: "#fafafa",
  text: "#e8e8e8",
  muted: "#888888",
};

const ARROW_ID = "sirius-arrow";

/** Marqueur flèche partagé, défini une seule fois au niveau page (url() résout
 *  à l'échelle du document → pas d'id dupliqué entre les 3 diagrammes). */
function ArrowDefs() {
  return (
    <svg width="0" height="0" aria-hidden className="absolute">
      <defs>
        <marker id={ARROW_ID} markerWidth="9" markerHeight="9" refX="7" refY="3" orient="auto">
          <path d="M0,0 L7,3 L0,6 Z" fill={C.muted} />
        </marker>
      </defs>
    </svg>
  );
}

function Box({
  x,
  y,
  w,
  h,
  title,
  sub,
  strong,
  dashed,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub?: string;
  strong?: boolean;
  dashed?: boolean;
}) {
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={10}
        fill={C.fill}
        stroke={strong ? C.strokeStrong : C.stroke}
        strokeWidth={strong ? 1.5 : 1}
        strokeDasharray={dashed ? "5 4" : undefined}
      />
      <text x={x + w / 2} y={sub ? y + h / 2 - 4 : y + h / 2 + 5} textAnchor="middle" fill={C.text} fontSize="15" fontWeight="600">
        {title}
      </text>
      {sub && (
        <text x={x + w / 2} y={y + h / 2 + 15} textAnchor="middle" fill={C.muted} fontSize="12">
          {sub}
        </text>
      )}
    </g>
  );
}

function DiagramFrame({ children, width = 760, height }: { children: React.ReactNode; width?: number; height: number }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-border bg-surface/40 p-4">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="h-auto w-full"
        style={{ minWidth: 620 }}
        fill="none"
        role="img"
        aria-hidden
      >
        {children}
      </svg>
    </div>
  );
}

const edge = { stroke: C.muted, strokeWidth: 1.2, markerEnd: `url(#${ARROW_ID})` } as const;

function EdgeLabel({ x, y, children }: { x: number; y: number; children: string }) {
  return (
    <text x={x} y={y} textAnchor="middle" fill={C.muted} fontSize="11.5">
      {children}
    </text>
  );
}

function OverviewDiagram() {
  return (
    <DiagramFrame height={440}>
      <Box x={30} y={28} w={175} h={62} title="Provider" sub="propriétaire du dataset" />
      <Box x={555} y={28} w={175} h={62} title="Borrower" sub="veut un modèle" />
      <Box x={30} y={190} w={175} h={56} title="IPFS / Pinata" sub="chiffré (AES-256)" />
      <Box x={280} y={165} w={200} h={100} title="Runner TEE" sub="Phala dstack en production" strong dashed />
      <rect x={30} y={360} width={700} height={62} rx={10} fill={C.fill} stroke={C.stroke} />
      <text x={45} y={385} fill={C.text} fontSize="14" fontWeight="600">
        XRPL
      </text>
      <text x={45} y={404} fill={C.muted} fontSize="12">
        MPT · Credentials · TokenEscrow · reçu d&apos;audit
      </text>

      {/* Provider → IPFS */}
      <path d="M105 92 L110 186" {...edge} />
      <EdgeLabel x={165} y={140}>
        chiffre + pin
      </EdgeLabel>
      {/* Provider → XRPL (mint MPT) */}
      <path d="M150 92 L230 356" {...edge} />
      <EdgeLabel x={250} y={210}>
        mint MPT
      </EdgeLabel>
      {/* IPFS → TEE */}
      <path d="M207 216 L276 220" {...edge} />
      <EdgeLabel x={242} y={208}>
        données + clé
      </EdgeLabel>
      {/* Borrower → XRPL (escrow) */}
      <path d="M640 92 L560 356" {...edge} />
      <EdgeLabel x={655} y={230}>
        escrow conditionnel
      </EdgeLabel>
      {/* TEE → Borrower (modèle) */}
      <path d="M482 200 L610 92" {...edge} />
      <EdgeLabel x={560} y={150}>
        modèle chiffré
      </EdgeLabel>
      {/* TEE → XRPL (finish) */}
      <path d="M380 267 L380 356" {...edge} />
      <EdgeLabel x={380} y={318}>
        révèle le fulfillment
      </EdgeLabel>
      {/* XRPL → Provider (paiement) */}
      <path d="M55 360 L95 94" {...edge} />
      <EdgeLabel x={55} y={230}>
        paiement
      </EdgeLabel>
    </DiagramFrame>
  );
}

function FairExchangeDiagram() {
  return (
    <DiagramFrame height={300}>
      <Box x={20} y={118} w={170} h={64} title="TEE termine" sub="modèle prêt ?" strong />

      {/* split */}
      <path d="M190 140 L250 60" {...edge} />
      <path d="M190 160 L250 240" {...edge} />

      {/* success lane */}
      <Box x={252} y={30} w={210} h={60} title="Capsule verrouillée" sub="persistée chez le Borrower" />
      <path d="M462 60 L512 60" {...edge} />
      <Box x={514} y={22} w={222} h={38} title="EscrowFinish → Provider payé" />
      <path d="M462 78 L512 100" {...edge} />
      <Box x={514} y={82} w={222} h={38} title="Fulfillment → capsule ouverte" />
      <text x={520} y={140} fill={C.strokeStrong} fontSize="12" fontWeight="600">
        ⟵ même transaction XRPL
      </text>

      {/* failure lane */}
      <Box x={252} y={210} w={210} h={60} title="Rien d'exploitable" sub="ou échec du job" />
      <path d="M462 240 L512 240" {...edge} />
      <Box x={514} y={210} w={222} h={60} title="CancelAfter" sub="Borrower remboursé" />
    </DiagramFrame>
  );
}

function EscrowLifecycleDiagram() {
  return (
    <DiagramFrame height={210}>
      <Box x={20} y={78} w={150} h={56} title="EscrowCreate" sub="signé par le Borrower" />
      <path d="M170 106 L212 106" {...edge} />
      <Box x={214} y={70} w={180} h={72} title="Fonds verrouillés" sub="Condition + CancelAfter" strong />

      <path d="M394 96 L446 40" {...edge} />
      <Box x={448} y={16} w={288} h={52} title="EscrowFinish" sub="fulfillment révélé par le TEE → Provider payé" />

      <path d="M394 118 L446 168" {...edge} />
      <Box x={448} y={146} w={288} h={52} title="EscrowCancel" sub="délai CancelAfter atteint → Borrower remboursé" />
    </DiagramFrame>
  );
}

/* ------------------------------------------------------------------ */

const TOC = [
  { id: "probleme", label: "Le problème" },
  { id: "solution", label: "La solution en un coup d'œil" },
  { id: "acteurs", label: "Les acteurs & artefacts" },
  { id: "parcours", label: "Le parcours complet" },
  { id: "fair-exchange", label: "Le fair-exchange atomique" },
  { id: "escrow", label: "Cycle de vie de l'escrow" },
  { id: "confidentialite", label: "Confidentialité : qui voit quoi" },
  { id: "custody", label: "Custody : qui détient quoi" },
  { id: "xrpl", label: "Les primitives XRPL" },
  { id: "limites", label: "Statut & feuille de route" },
];

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="scroll-mt-24 border-t border-border pt-12">
      <h2 className="text-2xl font-semibold tracking-tight text-foreground sm:text-3xl">{title}</h2>
      <div className="mt-5 space-y-4 text-sm leading-relaxed text-muted">{children}</div>
    </section>
  );
}

function Caption({ children }: { children: React.ReactNode }) {
  return <p className="mt-3 text-center text-xs text-muted">{children}</p>;
}

const strong = "text-foreground";

export default function DocsPage() {
  const setTargetZ = useBlobStore((s) => s.setTargetZ);
  const { t } = useLocale();

  useEffect(() => {
    setTargetZ(APP_BACKGROUND_BLOB_Z);
    return () => setTargetZ(null);
  }, [setTargetZ]);

  return (
    <div className="relative z-10 min-h-full text-foreground">
      <ArrowDefs />
      <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-border bg-background/80 px-4 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <Link href="/" className="text-lg font-semibold tracking-tight">
            Sirius
          </Link>
          <span className="hidden text-sm text-muted sm:inline">/ {t("Documentation")}</span>
        </div>
        <div className="flex items-center gap-2">
          <LanguageToggle />
          <ConnectButton />
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-6xl gap-10 px-4 py-12 sm:px-8">
        {/* Sommaire desktop */}
        <aside className="hidden w-56 shrink-0 lg:block">
          <nav className="sticky top-24 space-y-1">
            <p className="mb-3 text-xs uppercase tracking-widest text-muted">{t("Sommaire")}</p>
            {TOC.map((item) => (
              <a
                key={item.id}
                href={`#${item.id}`}
                className="block rounded-lg px-3 py-1.5 text-sm text-muted transition-colors hover:bg-white/5 hover:text-foreground"
              >
                {t(item.label)}
              </a>
            ))}
          </nav>
        </aside>

        {/* Contenu */}
        <main className="min-w-0 flex-1">
          {/* Sommaire mobile/tablette (l'aside n'existe qu'en ≥lg) */}
          <details className="mb-8 rounded-xl border border-border bg-surface/40 p-4 lg:hidden">
            <summary className="cursor-pointer text-sm font-medium text-foreground">{t("Sommaire")}</summary>
            <nav className="mt-3 space-y-1">
              {TOC.map((item) => (
                <a
                  key={item.id}
                  href={`#${item.id}`}
                  className="block rounded-lg px-3 py-1.5 text-sm text-muted transition-colors hover:bg-white/5 hover:text-foreground"
                >
                  {t(item.label)}
                </a>
              ))}
            </nav>
          </details>

          <div className="max-w-3xl">
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{t("Comment fonctionne Sirius")}</h1>
            <p className="mt-4 text-lg leading-relaxed text-muted">
              Sirius est un protocole de <span className={strong}>data lending confidentiel</span> sur XRPL. Le
              propriétaire d&apos;un dataset le monétise <span className={strong}>sans jamais livrer la donnée brute</span> ;
              l&apos;emprunteur entraîne un modèle dans une enclave sécurisée (TEE) et n&apos;en récupère que le résultat.
              Le règlement et l&apos;audit passent par XRPL. Ce document détaille chaque brique.
            </p>

            <div className="mt-12 space-y-12">
              <Section id="probleme" title="Le problème">
                <p>
                  Les données les plus précieuses sont aussi les plus verrouillées : dossiers de santé, transactions
                  financières, données personnelles. Elles sont soumises au RGPD, à des secrets métier, à des risques
                  de fuite. Résultat : <span className={strong}>elles ne sont jamais partagées en clair</span>, et
                  restent inexploitées.
                </p>
                <p>
                  Les approches classiques échouent. Livrer la donnée (même sous contrat) = perte de contrôle
                  irréversible dès le premier téléchargement. Un watermark ne résiste pas à la copie. Un tiers de
                  confiance centralisé recrée exactement le risque qu&apos;on veut éviter.
                </p>
                <p>
                  Sirius renverse le problème : <span className={strong}>ce n&apos;est pas la donnée qui va au modèle,
                  c&apos;est le modèle qui vient à la donnée</span> — dans une enclave où personne, pas même Sirius, ne
                  peut la lire.
                </p>
              </Section>

              <Section id="solution" title="La solution en un coup d'œil">
                <p>
                  La donnée est chiffrée et stockée hors-chaîne (IPFS). Elle n&apos;est déchiffrée qu&apos;à
                  l&apos;intérieur d&apos;un <span className={strong}>TEE</span> (Trusted Execution Environment), le
                  temps de l&apos;entraînement. Le TEE ne laisse sortir que le modèle. XRPL sert de couche de{" "}
                  <span className={strong}>règlement conditionnel et d&apos;audit infalsifiable</span>.
                </p>
                <OverviewDiagram />
                <Caption>
                  Vue d&apos;ensemble : le navigateur chiffre le CSV pour le runner avant tout transit. Le CSV en clair
                  n&apos;est visible que dans l&apos;enclave ; seuls le modèle chiffré et les preuves circulent.
                </Caption>
              </Section>

              <Section id="acteurs" title="Les acteurs & artefacts">
                <p>Quatre rôles, à ne pas confondre :</p>
                <ul className="ml-5 list-disc space-y-2 marker:text-muted">
                  <li>
                    <span className={strong}>Provider</span> — dépose et tokenise un dataset ; est payé quand un modèle
                    est entraîné dessus.
                  </li>
                  <li>
                    <span className={strong}>Borrower</span> — soumet un job d&apos;entraînement et récupère le modèle.
                  </li>
                  <li>
                    <span className={strong}>TEE (vérificateur)</span> — l&apos;enclave neutre qui exécute le calcul et
                    détient la clé du règlement. Ni le provider ni le borrower ne la contrôlent.
                  </li>
                  <li>
                    <span className={strong}>Sirius</span> — l&apos;orchestrateur. L&apos;application coordonne, mais ne
                    custodie ni les fonds, ni le CSV en clair, ni les clés de déchiffrement ou de règlement : elles
                    restent dans le runner TEE.
                  </li>
                </ul>
                <p>Et les artefacts qui circulent :</p>
                <ul className="ml-5 list-disc space-y-2 marker:text-muted">
                  <li>
                    <span className={strong}>Le dataset chiffré</span> (AES-256-GCM) sur IPFS — rescellé par le TEE
                    et inutile sans sa clé.
                  </li>
                  <li>
                    <span className={strong}>Le MPT</span> (jeton XLS-33) — l&apos;identité on-chain du dataset :
                    empreinte IPFS, racine Merkle, volumes globaux. Ce n&apos;est pas la donnée.
                  </li>
                  <li>
                    <span className={strong}>La clé de déchiffrement</span> — une DEK aléatoire par dataset,
                    enveloppée pour le runner TEE ; elle n&apos;est jamais livrée au borrower ni à Next.
                  </li>
                  <li>
                    <span className={strong}>Le modèle entraîné</span> + une <span className={strong}>attestation</span>{" "}
                    de calcul ; le modèle reste chiffré jusqu&apos;à son déverrouillage par le règlement.
                  </li>
                </ul>
              </Section>

              <Section id="parcours" title="Le parcours complet">
                <p>De bout en bout, en cinq phases :</p>
                <ol className="space-y-5">
                  {[
                    {
                      n: "01",
                      t: "Déposer",
                      d: "Le navigateur chiffre le CSV pour la clé d’ingestion du runner avant tout transit. Le runner l’ouvre seulement dans l’enclave, calcule la racine Merkle et les seuls volumes publics (lignes et colonnes), puis le rescelle sous une DEK aléatoire avant l’épinglage IPFS.",
                    },
                    {
                      n: "02",
                      t: "Tokeniser",
                      d: "Le provider signe le mint d’un MPT (XLS-33) sur XRPL, portant l’empreinte IPFS, la racine Merkle et les volumes globaux. Les acceptations KYB (XLS-70) sont elles aussi signées par leur titulaire. La donnée reste chiffrée hors-chaîne.",
                    },
                    {
                      n: "03",
                      t: "Emprunter",
                      d: "Le borrower parcourt la marketplace (métadonnées et volumes globaux), passe son KYB, puis signe un EscrowCreate (XLS-85) conditionnel vers le provider. Le runner détient la condition PREIMAGE-SHA-256 ; un CancelAfter borne le délai et permet le remboursement.",
                    },
                    {
                      n: "04",
                      t: "Entraîner",
                      d: "Le runner TEE récupère le dataset chiffré sur IPFS, l’ouvre dans l’enclave, exécute le job sur la vraie donnée, puis produit un modèle chiffré et son attestation. À aucun moment le CSV n’est exposé à Next, au provider ou au borrower.",
                    },
                    {
                      n: "05",
                      t: "Régler",
                      d: "L'attestation est vérifiée et le navigateur persiste une capsule verrouillée. Le runner soumet EscrowFinish : la même transaction paie le provider et publie le fulfillment qui ouvre cette capsule. Un hash attesté est gravé on-chain comme reçu d'audit.",
                    },
                  ].map((s) => (
                    <li key={s.n} className="flex gap-4">
                      <span className="shrink-0 text-2xl font-semibold tracking-tight text-muted">{s.n}</span>
                      <div>
                        <div className="font-semibold text-foreground">{s.t}</div>
                        <p className="mt-1">{s.d}</p>
                      </div>
                    </li>
                  ))}
                </ol>
              </Section>

              <Section id="fair-exchange" title="Le fair-exchange atomique">
                <p>
                  C&apos;est le cœur de Sirius. Un escrow classique basé sur le temps ne protège que le borrower. Ici,
                  le release n&apos;est contrôlé <span className={strong}>ni par le borrower ni par le provider</span>,
                  mais par le runner TEE. Le borrower reçoit d&apos;abord une capsule inutilisable ; l&apos;EscrowFinish
                  paie ensuite le provider et publie le fulfillment qui la déverrouille. Ce sont les deux effets du
                  <span className={strong}> même événement on-chain</span>.
                </p>
                <FairExchangeDiagram />
                <Caption>Deux issues possibles, aucune ne lèse une partie.</Caption>
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-muted">
                        <th className="py-2 pr-4 font-medium">Scénario</th>
                        <th className="py-2 font-medium">Issue</th>
                      </tr>
                    </thead>
                    <tbody className="align-top">
                      {[
                        ["Tout se passe bien", "Provider payé et capsule ouverte par la même transaction XRPL."],
                        ["Provider fournit une donnée fausse/inexploitable", "Le TEE ne produit rien → cancel → borrower remboursé."],
                        ["Borrower veut le modèle sans payer", "Impossible : la capsule exige le fulfillment publié au paiement."],
                        ["Litige subjectif sur la qualité", "Non tranché par l'escrow seul → challenge period + arbitrage (roadmap)."],
                      ].map(([a, b]) => (
                        <tr key={a} className="border-b border-border/60">
                          <td className="py-2.5 pr-4 text-foreground">{a}</td>
                          <td className="py-2.5 text-muted">{b}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </Section>

              <Section id="escrow" title="Cycle de vie de l'escrow">
                <p>
                  L&apos;escrow (TokenEscrow, XLS-85) est signé côté borrower — Sirius ne détient pas ses fonds. Une
                  fois créé, il ne peut se dénouer que de deux façons :
                </p>
                <EscrowLifecycleDiagram />
                <p>
                  La <span className={strong}>condition</span> est une crypto-condition PREIMAGE-SHA-256. Le{" "}
                  <span className={strong}>fulfillment</span> (le secret qui la satisfait) n&apos;est jamais stocké : il
                  se régénère au moment du release, côté vérificateur. Le <span className={strong}>CancelAfter</span> est
                  la porte de sortie du borrower si rien n&apos;est produit dans les temps.
                </p>
              </Section>

              <Section id="confidentialite" title="Confidentialité : qui voit quoi">
                <p>
                  La règle d&apos;or : la donnée brute n&apos;est visible que dans l&apos;enclave. Voici ce que chaque
                  acteur peut réellement lire.
                </p>
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full min-w-[560px] border-collapse text-sm">
                    <thead>
                      <tr className="border-b border-border text-left text-muted">
                        <th className="py-2 pr-4 font-medium">Artefact</th>
                        <th className="py-2 pr-4 font-medium">Provider</th>
                        <th className="py-2 pr-4 font-medium">Borrower</th>
                        <th className="py-2 pr-4 font-medium">Sirius</th>
                        <th className="py-2 font-medium">TEE</th>
                      </tr>
                    </thead>
                    <tbody className="align-top">
                      {[
                        ["Donnée brute", "oui (la sienne)", "non", "non", "oui (en enclave)"],
                        ["Dataset chiffré (IPFS)", "oui", "oui", "oui", "oui"],
                        ["Clé d’ingestion / DEK", "non", "non", "non", "oui"],
                        ["Volumes publics (lignes / colonnes)", "oui", "oui", "oui", "oui"],
                        ["Modèle entraîné déchiffré", "non", "oui", "non", "oui (pendant le job)"],
                      ].map((row) => (
                        <tr key={row[0]} className="border-b border-border/60">
                          <td className="py-2.5 pr-4 text-foreground">{row[0]}</td>
                          {row.slice(1).map((cell, i) => (
                            <td key={i} className={`py-2.5 pr-4 ${cell.startsWith("oui") ? "text-foreground" : "text-muted"}`}>
                              {cell}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="text-sm text-muted">
                  Next ne reçoit jamais le CSV en clair ni les clés. En production, la master key est scellée dans la
                  CVM Phala ; le mode stub est réservé au développement local.
                </p>
              </Section>

              <Section id="custody" title="Custody : qui détient quoi">
                <p>
                  Sirius est <span className={strong}>non-custodial</span> : il ne détient ni les fonds des
                  utilisateurs, ni le jeton du dataset, ni la donnée en clair.
                </p>
                <ul className="ml-5 list-disc space-y-2 marker:text-muted">
                  <li>
                    <span className={strong}>Le MPT</span> est minté et détenu par le provider (c&apos;est lui qui
                    signe), pas par Sirius.
                  </li>
                  <li>
                    <span className={strong}>Les fonds</span> vivent on-chain : dans le wallet de l&apos;utilisateur ou
                    verrouillés dans l&apos;escrow. Le wallet embarqué (login Google) est en MPC{" "}
                    <span className={strong}>2-sur-3</span> — la clé n&apos;est jamais reconstituée, personne ne peut
                    signer seul. Une sortie « Envoyer / Retirer » garantit que les fonds ne sont jamais piégés.
                  </li>
                  <li>
                    <span className={strong}>La donnée chiffrée</span> est sur IPFS public — inutile sans la clé.
                  </li>
                  <li>
                    <span className={strong}>Chaque DEK</span> est aléatoire, enveloppée pour le runner et détruite lors
                    du crypto-shredding. La master key du runner est scellée dans la CVM Phala en production.
                  </li>
                </ul>
              </Section>

              <Section id="xrpl" title="Les primitives XRPL">
                <p>
                  Sirius n&apos;utilise que des primitives <span className={strong}>activées sur XRPL mainnet</span> —
                  aucune dépendance à un amendment non déployé.
                </p>
                <div className="mt-2 grid gap-3 sm:grid-cols-2">
                  {[
                    ["XLS-33", "MPT", "Tokenise le dataset : identité et provenance on-chain (empreinte IPFS, racine Merkle, volumes globaux)."],
                    ["XLS-70", "Credentials", "KYB provider & borrower : attestation d'entité, gating bloquant avant toute action."],
                    ["XLS-80", "Permissioned Domains", "Gating de conformité (posé léger au MVP, valeur pleine en roadmap)."],
                    ["XLS-85", "TokenEscrow", "Le pilier du règlement : escrow conditionnel (crypto-condition + CancelAfter), en XRP d'abord."],
                  ].map(([tag, name, desc]) => (
                    <div key={tag} className="rounded-xl border border-border bg-surface/40 p-4">
                      <div className="text-xs font-medium tracking-widest text-muted">{tag}</div>
                      <div className="mt-1 font-semibold text-foreground">{name}</div>
                      <p className="mt-1 text-sm text-muted">{desc}</p>
                    </div>
                  ))}
                </div>
                <p>
                  Le règlement stable cible est <span className={strong}>RLUSD</span> (escrow-able via XLS-85) ; le MVP
                  valide le mécanisme en XRP natif (ni issuer ni trustline = zéro friction).
                </p>
              </Section>

              <Section id="limites" title="Statut & feuille de route">
                <p>
                  Le flux local est fonctionnel : runner isolé, clés par dataset, crypto-shredding, sortie de modèle
                  bornée et attestations sont en place. Avant une mise en production, il reste :
                </p>
                <ul className="ml-5 list-disc space-y-2 marker:text-muted">
                  <li>
                    <span className={strong}>Déploiement CVM Phala</span> — image runner de production, RA-TLS et
                    capture puis épinglage des mesures réelles de l&apos;enclave.
                  </li>
                  <li>
                    <span className={strong}>Validation testnet réelle</span> — parcours complet avec deux wallets et
                    Pinata : onboarding, ingestion, MPT, escrow, entraînement, règlement, récupération et
                    crypto-shredding.
                  </li>
                  <li>
                    <span className={strong}>Litiges de qualité</span> — l&apos;escrow rembourse mécaniquement en cas
                    d&apos;échec, mais ne tranche pas encore un désaccord subjectif sur la qualité du modèle.
                  </li>
                  <li>
                    <span className={strong}>Post-MVP</span> — jobs asynchrones, differential privacy avec budget ε,
                    ZK metrics, arbitrage et règlement en RLUSD.
                  </li>
                </ul>
                <p className="pt-2">
                  <Link href="/" className="text-foreground underline underline-offset-4 hover:text-muted">
                    ← Retour à l&apos;accueil
                  </Link>
                </p>
              </Section>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
