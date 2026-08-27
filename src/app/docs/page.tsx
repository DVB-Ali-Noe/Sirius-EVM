"use client";

import { useEffect } from "react";
import Link from "next/link";
import { ConnectButton } from "@/components/wallet/ConnectButton";
import { APP_BACKGROUND_BLOB_Z, useBlobStore } from "@/stores/blob";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { LANDING_RETURN_KEY } from "@/lib/landing-navigation";

const C = {
  fill: "#131313",
  stroke: "#2a2a2a",
  strokeStrong: "#fafafa",
  text: "#e8e8e8",
  muted: "#888888",
};

const ARROW_ID = "sirius-arrow";

const DOCUMENTATION_EN: Record<string, string> = {
  "propriétaire du dataset": "dataset owner",
  "entraîne un modèle": "trains a model",
  "dataset AES-256 chiffré": "AES-256 encrypted dataset",
  "chiffre + pin": "encrypts + pins",
  "publie le titre": "publishes the title",
  "blob chiffré": "encrypted blob",
  "verrouille des USDC": "locks USDC",
  "modèle chiffré": "encrypted model",
  "release + préimage": "release + preimage",
  "provider crédité": "provider credited",
  "TEE termine": "TEE completes",
  "modèle prêt ?": "model ready?",
  "Capsule verrouillée": "Locked capsule",
  "persistée chez le borrower": "stored by the borrower",
  "release → provider crédité": "release → provider credited",
  "préimage → capsule ouverte": "preimage → capsule unlocked",
  "⟵ même transaction EVM": "⟵ same EVM transaction",
  "Rien d'exploitable": "Nothing usable",
  "ou échec du job": "or failed job",
  "borrower remboursé après échéance": "borrower refunded after expiry",
  "signé par le borrower": "signed by the borrower",
  "USDC verrouillés": "USDC locked",
  "hashlock + échéance": "hashlock + expiry",
  "préimage public → provider crédité": "public preimage → provider credited",
  "échéance atteinte → borrower remboursé": "expiry reached → borrower refunded",
  "État de l’implémentation": "Implementation status",
  "Garanties & limites de sécurité": "Security guarantees & limits",
  "Sirius est un protocole de": "Sirius is a protocol for",
  "data lending confidentiel sur une chaîne EVM": "confidential data lending on an EVM chain",
  "Le provider monétise son dataset sans livrer sa donnée brute ; le borrower n’obtient que le modèle entraîné dans un TEE.": "The provider monetizes its dataset without delivering raw data; the borrower only receives the model trained inside a TEE.",
  "Le règlement est libellé en": "Settlement is denominated in",
  "et vérifiable on-chain.": "and verifiable on-chain.",
  "L’attestation du runner tourne en simulation sur testnet ; le déploiement Phala sur matériel attesté est le prochain jalon.": "Runner attestation is running in simulation on testnet; hardware-attested Phala deployment is the next milestone.",
  "Cette instance de test ne vérifie aucune entreprise : l’escrow pointe sur un registre ouvert qui accepte toute adresse. Le registre KYB gouverné existe dans les contrats et sera activé avant toute utilisation réelle.": "This test instance verifies no business: the escrow points at an open registry that accepts every address. The governed KYB registry exists in the contracts and will be enabled before any real use.",
  "le code est validé localement, mais les contrats doivent être redéployés puis testés sur Robinhood Chain. L’émetteur KYB externe et le runner Phala restent à configurer.": "the code is validated locally, but the contracts must be redeployed and tested on Robinhood Chain. The external KYB issuer and Phala runner still need to be configured.",
  "Les données les plus précieuses sont aussi les plus verrouillées : santé, finance, données personnelles ou secrets métier. Elles ne peuvent pas être partagées en clair sans perdre le contrôle.": "The most valuable data is often the most restricted: health, finance, personal data, or trade secrets. It cannot be shared in plaintext without losing control.",
  "Sirius inverse le flux :": "Sirius reverses the flow:",
  "le modèle vient à la donnée": "the model comes to the data",
  ", dans une enclave où ni Sirius, ni le borrower, ni le provider ne peuvent lire le dataset pendant le calcul.": ", inside an enclave where Sirius, the borrower, and the provider cannot read the dataset during computation.",
  "Le navigateur chiffre le dataset avant son envoi. Le runner TEE le traite, produit un modèle chiffré et ne révèle le secret de livraison qu’au moment du règlement. Les contrats EVM rendent le paiement et l’audit vérifiables.": "The browser encrypts the dataset before upload. The TEE runner processes it, produces an encrypted model, and reveals the delivery secret only at settlement. EVM contracts make payment and audit verifiable.",
  "Le CSV en clair n’existe que dans l’enclave ; seuls le modèle chiffré et les preuves sortent du runner.": "The plaintext CSV exists only inside the enclave; only the encrypted model and proofs leave the runner.",
  "publie un dataset chiffré et reçoit le règlement.": "publishes an encrypted dataset and receives settlement.",
  "choisit un dataset, finance le prêt et récupère le modèle.": "chooses a dataset, funds the loan, and receives the model.",
  "ouvre le dataset, calcule, atteste et détient le préimage.": "opens the dataset, computes, attests, and holds the preimage.",
  "orchestre sans custodie des fonds, du CSV en clair ou des secrets de règlement.": "orchestrates without custody of funds, plaintext CSV, or settlement secrets.",
  "Dataset chiffré": "Encrypted dataset",
  "blob AES-256-GCM sur IPFS.": "AES-256-GCM blob on IPFS.",
  "Titre de dataset": "Dataset title",
  "hash du CID, Merkle root et taille inscrits publiquement dans": "CID hash, Merkle root, and size publicly registered in",
  "Attestation KYB": "KYB attestation",
  "credential EIP-712 consenti par le wallet, émis par un vérificateur externe et requis par le registre comme par l’escrow.": "EIP-712 credential consented to by the wallet, issued by an external verifier, and required by both the registry and escrow.",
  "Capsule modèle": "Model capsule",
  "clé de livraison chiffrée pour le navigateur et liée au préimage.": "delivery key encrypted for the browser and tied to the preimage.",
  "Déposer": "Upload",
  "Entraîner": "Train",
  "Le navigateur chiffre le CSV pour le runner. Le TEE calcule le Merkle root, scelle une clé par dataset et envoie le blob chiffré sur IPFS.": "The browser encrypts the CSV for the runner. The TEE computes the Merkle root, seals one key per dataset, and uploads the encrypted blob to IPFS.",
  "Publier": "Publish",
  "Le provider, après KYB, inscrit le titre du dataset dans le registre EVM. Le CSV chiffré reste hors chaîne ; le hash du CID, le Merkle root et la taille sont publics et permanents.": "After KYB, the provider registers the dataset title in the EVM registry. The encrypted CSV stays off-chain; the CID hash, Merkle root, and size are public and permanent.",
  "Verrouiller": "Lock",
  "Le borrower approuve puis verrouille des USDC exacts dans l’escrow. Les KYB du borrower et du provider, le hashlock et l’échéance définissent les seules issues possibles.": "The borrower approves and locks the exact USDC amount in escrow. The borrower and provider KYB, hashlock, and expiry define the only possible outcomes.",
  "Le runner vérifie les KYB, la portée du titre de dataset et les termes de l’escrow avant d’ouvrir le dataset dans le TEE.": "The runner verifies KYB, dataset-title scope, and escrow terms before opening the dataset in the TEE.",
  "Régler": "Settle",
  "Le borrower persiste la capsule. Le runner appelle `release`, publie le préimage et crédite le provider ; la capsule devient alors ouvrable.": "The borrower persists the capsule. The runner calls `release`, publishes the preimage, and credits the provider; the capsule can then be opened.",
  "Implémenté": "Implemented",
  "Hashlock SHA-256, transferts USDC exacts, KYB des deux parties, remboursement et retraits pull-only.": "SHA-256 hashlock, exact USDC transfers, KYB for both parties, refunds, and pull-only withdrawals.",
  "Attestations EIP-712, expiration, révocation durable et consentement du wallet ; l’émetteur est externe.": "EIP-712 attestations, expiry, durable revocation, and wallet consent; the issuer is external.",
  "Contrôles croisés": "Cross-checks",
  "L’escrow contrôle le KYB ; le runner contrôle KYB, titre de dataset et termes de l’escrow avant déchiffrement.": "The escrow checks KYB; the runner checks KYB, dataset title, and escrow terms before decryption.",
  "Cette distinction est volontaire : la documentation décrit le comportement déployable du code, pas seulement la cible produit.": "This distinction is deliberate: the documentation describes deployable code behavior, not just the product target.",
  "Le problème": "The problem",
  "La solution en un coup d'œil": "The solution at a glance",
  "Les acteurs & artefacts": "Actors & artifacts",
  "Le parcours complet": "The complete flow",
  "Le fair-exchange atomique": "Atomic fair exchange",
  "Cycle de vie de l'escrow": "Escrow lifecycle",
  "Confidentialité : qui voit quoi": "Confidentiality: who sees what",
  "Custody : qui détient quoi": "Custody: who holds what",
  "Les contrats EVM": "EVM contracts",
  "Limites & feuille de route": "Limits & roadmap",
  "Le runner TEE contrôle le release, pas les deux contreparties. Le borrower possède d’abord une capsule inutilisable ; le préimage qui l’ouvre n’est publié qu’avec le crédit du provider.": "The TEE runner controls release, not either counterparty. The borrower first holds an unusable capsule; its opening preimage is published only when the provider is credited.",
  "`release` est autorisé uniquement avant l’échéance. Après celle-ci, seul `refund` peut créditer le borrower : aucun préimage ne peut alors être publié par l’escrow.": "`release` is allowed only before expiry. After that, only `refund` can credit the borrower: the escrow can no longer publish a preimage.",
  "Scénario": "Scenario",
  "Issue": "Outcome",
  "Calcul réussi": "Successful computation",
  "Provider crédité et capsule ouverte par la même transaction EVM.": "The provider is credited and the capsule is opened by the same EVM transaction.",
  "Job invalide ou infructueux": "Invalid or unsuccessful job",
  "Aucun préimage n’est révélé ; le borrower récupère les fonds après échéance.": "No preimage is revealed; the borrower recovers the funds after expiry.",
  "Tentative d'obtenir le modèle sans payer": "Attempt to obtain the model without paying",
  "Impossible : la capsule exige le préimage publié au règlement.": "Impossible: the capsule requires the preimage published at settlement.",
  "Litige subjectif sur la qualité": "Subjective quality dispute",
  "Non tranché par l’escrow seul ; arbitrage à venir.": "Not resolved by escrow alone; arbitration is a future extension.",
  "Le borrower signe le verrouillage depuis son wallet. `SiriusEscrow` ne connaît que trois états : verrouillé, réglé ou remboursé ; `release` et `refund` sont donc mutuellement exclusifs.": "The borrower signs the lock from their wallet. `SiriusEscrow` has only three states: locked, released, or refunded; `release` and `refund` are mutually exclusive.",
  "Les crédits sont retirés séparément, par `withdraw` ou `withdrawFor`. Un wallet de provider qui refuse un transfert ne peut pas bloquer la transition du prêt.": "Credits are withdrawn separately with `withdraw` or `withdrawFor`. A provider wallet that rejects a transfer cannot block the loan transition.",
  "Appel": "Call",
  "Qui peut l’appeler": "Who can call it",
  "Effet vérifiable": "Verifiable effect",
  "Le borrower": "The borrower",
  "Crée un prêt unique en USDC, fixe provider, montant, hashlock et échéance de 1 à 30 jours ; les deux KYB doivent être valides.": "Creates a unique USDC loan and fixes the provider, amount, hashlock, and 1-to-30-day expiry; both KYB attestations must be valid.",
  "Toute adresse qui connaît le préimage, avant l’échéance": "Any address knowing the preimage, before expiry",
  "Révèle le préimage et crédite le provider, sans transfert externe dans cette transaction.": "Reveals the preimage and credits the provider, without an external transfer in this transaction.",
  "Toute adresse, après échéance": "Any address, after expiry",
  "Crédite uniquement le borrower ; cet appel ferme définitivement la fenêtre de release.": "Credits only the borrower; this call permanently closes the release window.",
  "Toute adresse": "Any address",
  "Transfère le crédit uniquement au compte désigné, avec protection anti-réentrance.": "Transfers the credit only to the designated account, with reentrancy protection.",
  "Artefact": "Artifact",
  "Donnée brute": "Raw data",
  "oui (la sienne)": "yes (their own)",
  "non": "no",
  "oui, en enclave": "yes, in the enclave",
  "oui": "yes",
  "DEK et préimage": "DEK and preimage",
  "Titre et événements EVM": "EVM title and events",
  "Modèle déchiffré": "Decrypted model",
  "oui, pendant le job": "yes, during the job",
  "Les fonds": "Funds",
  "restent dans le wallet ou dans `SiriusEscrow` ; Sirius ne peut pas les déplacer discrétionnairement.": "remain in the wallet or `SiriusEscrow`; Sirius cannot move them at its discretion.",
  "Le titre du dataset": "The dataset title",
  "reste lié au provider. Le contenu est chiffré ; seul le hash de son CID, son Merkle root et sa taille sont publics.": "remains bound to the provider. The content is encrypted; only its CID hash, Merkle root, and size are public.",
  "Les clés": "Keys",
  "restent dans le runner TEE ; la master key est scellée par dstack en production.": "remain in the TEE runner; the master key is sealed by dstack in production.",
  "La suppression": "Deletion",
  "détruit la clé de dataset et laisse un tombstone vérifiable, sans rendre le contenu récupérable.": "destroys the dataset key and leaves a verifiable tombstone without making the content recoverable.",
  "Règlement": "Settlement",
  "Pas d’admin, pas d’upgrade ni de frais. USDC exact, hashlock SHA-256, KYB des deux parties, échéance stricte et crédits pull-only.": "No admin, upgrade, or fees. Exact USDC, SHA-256 hashlock, KYB for both parties, strict expiry, and pull-only credits.",
  "Attestations EIP-712 avec consentement, nonce anti-rejeu, expiration, révocation et époque de vérificateur. L’admin pilote les vérificateurs.": "EIP-712 attestations with consent, anti-replay nonce, expiry, revocation, and verifier epoch. The admin manages verifiers.",
  "Provenance": "Provenance",
  "Titre déterministe, KYB bloquant à la publication, hash du CID, Merkle root, taille et tombstone permanent après destruction.": "Deterministic title, KYB required for publication, CID hash, Merkle root, size, and permanent tombstone after deletion.",
  "Le rail USDC et les parcours EVM sont implémentés. Il reste un redéploiement testnet, un émetteur KYB externe et une validation avec le runner Phala.": "The USDC rail and EVM flows are implemented. A testnet redeployment, external KYB issuer, and Phala runner validation remain.",
  "Ce que la chaîne garantit": "What the chain guarantees",
  "Un prêt ne passe qu’une fois de `Locked` vers `Released` ou `Refunded`.": "A loan transitions only once from `Locked` to `Released` or `Refunded`.",
  "Le provider ne peut être crédité sans que le préimage soit rendu public, et réciproquement.": "The provider cannot be credited without the preimage becoming public, and vice versa.",
  "Le retrait ne peut pas modifier un prêt ni rediriger un crédit vers une autre adresse.": "Withdrawal cannot alter a loan or redirect a credit to another address.",
  "Le registre considère un titre détruit comme inactif et une attestation KYB comme invalide après expiration, révocation ou retrait du vérificateur.": "The registry treats a destroyed title as inactive and a KYB attestation as invalid after expiry, revocation, or verifier removal.",
  "Ce qui reste hors contrat": "What remains outside the contracts",
  "La qualité, la licéité du dataset et la qualité du modèle restent hors de portée des contrats.": "Dataset quality and legality, and model quality, remain outside the scope of the contracts.",
  "Le hash du CID, le Merkle root, la taille et les identifiants de prêt sont publics et permanents : ils ne doivent contenir aucune donnée sensible.": "The CID hash, Merkle root, size, and loan identifiers are public and permanent: they must not contain sensitive data.",
  "L’émetteur KYB, sa clé de signature et l’administration du registre sont des points de gouvernance à protéger hors de Next et du runner.": "The KYB issuer, its signing key, and registry administration are governance points to protect outside Next and the runner.",
  "Le code n’a pas encore fait l’objet d’une revue indépendante ni d’une validation testnet complète.": "The code has not yet received an independent review or complete testnet validation.",
  "Les contrats, les parcours wallet/API et le rail EVM du runner sont présents. Avant une utilisation publique, il reste le redéploiement testnet, l’émetteur KYB externe, le déploiement Phala et un parcours réel complet avec deux wallets.": "The contracts, wallet/API flows, and runner EVM rail are in place. Before public use, testnet redeployment, the external KYB issuer, Phala deployment, and a complete real flow with two wallets remain.",
  "Déploiement Phala avec RA-TLS, capture des mesures et épinglage côté Next.": "Deploy Phala with RA-TLS, capture measurements, and pin them in Next.",
  "Redéployer le rail USDC puis valider sur testnet : KYB, publication, verrouillage, release, refund et crypto-shredding.": "Redeploy the USDC rail, then validate KYB, publication, lock, release, refund, and crypto-shredding on testnet.",
  "Connecter un émetteur KYB externe avec une clé HSM/KMS et borner les identifiants publics avant mainnet.": "Connect an external KYB issuer with an HSM/KMS key and bound public identifiers before mainnet.",
  "Revue indépendante des contrats avant toute utilisation avec des fonds réels.": "Independently review the contracts before any use with real funds.",
  "Post-MVP : jobs asynchrones, confidentialité différentielle et arbitrage de qualité.": "Post-MVP: asynchronous jobs, differential privacy, and quality arbitration.",
  "← Retour à l’accueil": "← Back to home",
};

type Translate = (value: string) => string;

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
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  title: string;
  sub?: string;
  strong?: boolean;
}) {
  return (
    <g>
      <rect x={x} y={y} width={w} height={h} rx={10} fill={C.fill} stroke={strong ? C.strokeStrong : C.stroke} strokeWidth={strong ? 1.5 : 1} />
      <text x={x + w / 2} y={sub ? y + h / 2 - 4 : y + h / 2 + 5} textAnchor="middle" fill={C.text} fontSize="15" fontWeight="600">
        {title}
      </text>
      {sub && <text x={x + w / 2} y={y + h / 2 + 15} textAnchor="middle" fill={C.muted} fontSize="12">{sub}</text>}
    </g>
  );
}

function DiagramFrame({ children, height }: { children: React.ReactNode; height: number }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-border bg-surface/40 p-4">
      <svg viewBox={`0 0 760 ${height}`} className="h-auto w-full" style={{ minWidth: 620 }} fill="none" role="img" aria-hidden>
        {children}
      </svg>
    </div>
  );
}

const edge = { stroke: C.muted, strokeWidth: 1.2, markerEnd: `url(#${ARROW_ID})` } as const;

function EdgeLabel({ x, y, children }: { x: number; y: number; children: string }) {
  return <text x={x} y={y} textAnchor="middle" fill={C.muted} fontSize="11.5">{children}</text>;
}

function OverviewDiagram({ d }: { d: Translate }) {
  return (
    <DiagramFrame height={440}>
      <Box x={30} y={28} w={175} h={62} title="Provider" sub={d("propriétaire du dataset")} />
      <Box x={555} y={28} w={175} h={62} title="Borrower" sub={d("entraîne un modèle")} />
      <Box x={30} y={190} w={175} h={56} title="IPFS / Pinata" sub={d("dataset AES-256 chiffré")} />
      <Box x={280} y={165} w={200} h={100} title="Runner TEE" sub="Phala dstack" strong />
      <rect x={30} y={360} width={700} height={62} rx={10} fill={C.fill} stroke={C.stroke} />
      <text x={45} y={385} fill={C.text} fontSize="14" fontWeight="600">Robinhood Chain · EVM</text>
      <text x={45} y={404} fill={C.muted} fontSize="12">SiriusDatasetRegistry · SiriusKybRegistry · SiriusEscrow · USDC ERC-20</text>

      <path d="M105 92 L110 186" {...edge} />
      <EdgeLabel x={165} y={140}>{d("chiffre + pin")}</EdgeLabel>
      <path d="M150 92 L230 356" {...edge} />
      <EdgeLabel x={252} y={330}>{d("publie le titre")}</EdgeLabel>
      <path d="M207 216 L276 220" {...edge} />
      <EdgeLabel x={242} y={208}>{d("blob chiffré")}</EdgeLabel>
      <path d="M640 92 L560 356" {...edge} />
      <EdgeLabel x={655} y={230}>{d("verrouille des USDC")}</EdgeLabel>
      <path d="M482 200 L610 92" {...edge} />
      <EdgeLabel x={560} y={150}>{d("modèle chiffré")}</EdgeLabel>
      <path d="M380 267 L380 356" {...edge} />
      <EdgeLabel x={380} y={318}>{d("release + préimage")}</EdgeLabel>
      <path d="M55 360 L95 94" {...edge} />
      <EdgeLabel x={100} y={330}>{d("provider crédité")}</EdgeLabel>
    </DiagramFrame>
  );
}

function FairExchangeDiagram({ d }: { d: Translate }) {
  return (
    <DiagramFrame height={300}>
      <Box x={20} y={118} w={170} h={64} title={d("TEE termine")} sub={d("modèle prêt ?")} strong />
      <path d="M190 140 L250 60" {...edge} />
      <path d="M190 160 L250 240" {...edge} />
      <Box x={252} y={30} w={210} h={60} title={d("Capsule verrouillée")} sub={d("persistée chez le borrower")} />
      <path d="M462 60 L512 60" {...edge} />
      <Box x={514} y={22} w={222} h={38} title={d("release → provider crédité")} />
      <path d="M462 78 L512 100" {...edge} />
      <Box x={514} y={82} w={222} h={38} title={d("préimage → capsule ouverte")} />
      <text x={520} y={140} fill={C.strokeStrong} fontSize="12" fontWeight="600">{d("⟵ même transaction EVM")}</text>
      <Box x={252} y={210} w={210} h={60} title={d("Rien d'exploitable")} sub={d("ou échec du job")} />
      <path d="M462 240 L512 240" {...edge} />
      <Box x={514} y={210} w={222} h={60} title="refund" sub={d("borrower remboursé après échéance")} />
    </DiagramFrame>
  );
}

function EscrowLifecycleDiagram({ d }: { d: Translate }) {
  return (
    <DiagramFrame height={210}>
      <Box x={20} y={78} w={150} h={56} title="lock" sub={d("signé par le borrower")} />
      <path d="M170 106 L212 106" {...edge} />
      <Box x={214} y={70} w={180} h={72} title={d("USDC verrouillés")} sub={d("hashlock + échéance")} strong />
      <path d="M394 96 L446 40" {...edge} />
      <Box x={448} y={16} w={288} h={52} title="release" sub={d("préimage public → provider crédité")} />
      <path d="M394 118 L446 168" {...edge} />
      <Box x={448} y={146} w={288} h={52} title="refund" sub={d("échéance atteinte → borrower remboursé")} />
    </DiagramFrame>
  );
}

const TOC = [
  { id: "probleme", label: "Le problème" },
  { id: "solution", label: "La solution en un coup d'œil" },
  { id: "acteurs", label: "Les acteurs & artefacts" },
  { id: "parcours", label: "Le parcours complet" },
  { id: "etat", label: "État de l’implémentation" },
  { id: "fair-exchange", label: "Le fair-exchange atomique" },
  { id: "escrow", label: "Cycle de vie de l'escrow" },
  { id: "confidentialite", label: "Confidentialité : qui voit quoi" },
  { id: "custody", label: "Custody : qui détient quoi" },
  { id: "evm", label: "Les contrats EVM" },
  { id: "securite", label: "Garanties & limites de sécurité" },
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
  const { locale, t } = useLocale();
  const d: Translate = (value) => locale === "en" ? DOCUMENTATION_EN[value] ?? value : value;
  const returnToLanding = () => window.sessionStorage.setItem(LANDING_RETURN_KEY, "true");

  useEffect(() => {
    setTargetZ(APP_BACKGROUND_BLOB_Z);
    return () => setTargetZ(null);
  }, [setTargetZ]);

  return (
    <div className="relative z-10 min-h-full text-foreground">
      <ArrowDefs />
      <header className="sticky top-0 z-30 flex h-16 items-center justify-between border-b border-border bg-background/80 px-4 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <Link href="/" onClick={returnToLanding} className="text-lg font-semibold tracking-tight">Sirius</Link>
          <span className="hidden text-sm text-muted sm:inline">/ {t("Documentation")}</span>
        </div>
        <div className="flex items-center gap-2">
          <ConnectButton />
        </div>
      </header>

      <div className="mx-auto flex w-full max-w-6xl gap-10 px-4 py-12 sm:px-8">
        <aside className="hidden w-56 shrink-0 lg:block">
          <nav className="sticky top-24 space-y-1">
            <p className="mb-3 text-xs uppercase tracking-widest text-muted">{t("Sommaire")}</p>
            {TOC.map((item) => <a key={item.id} href={`#${item.id}`} className="block rounded-lg px-3 py-1.5 text-sm text-muted transition-colors hover:bg-white/5 hover:text-foreground">{d(t(item.label))}</a>)}
          </nav>
        </aside>

        <main className="min-w-0 flex-1">
          <details className="mb-8 rounded-xl border border-border bg-surface/40 p-4 lg:hidden">
            <summary className="cursor-pointer text-sm font-medium text-foreground">{t("Sommaire")}</summary>
            <nav className="mt-3 space-y-1">
              {TOC.map((item) => <a key={item.id} href={`#${item.id}`} className="block rounded-lg px-3 py-1.5 text-sm text-muted transition-colors hover:bg-white/5 hover:text-foreground">{d(t(item.label))}</a>)}
            </nav>
          </details>

          <div className="max-w-3xl">
            <h1 className="text-3xl font-semibold tracking-tight sm:text-4xl">{t("Comment fonctionne Sirius")}</h1>
            <p className="mt-4 text-lg leading-relaxed text-muted">
              {d("Sirius est un protocole de")} <span className={strong}>{d("data lending confidentiel sur une chaîne EVM")}</span>.
              {d("Le provider monétise son dataset sans livrer sa donnée brute ; le borrower n’obtient que le modèle entraîné dans un TEE.")}
              {d("Le règlement est libellé en")} <span className={strong}>USDC</span> {d("et vérifiable on-chain.")}
            </p>

            <div className="mt-12 space-y-12">
              <Section id="probleme" title={d("Le problème")}>
                <p>{d("Les données les plus précieuses sont aussi les plus verrouillées : santé, finance, données personnelles ou secrets métier. Elles ne peuvent pas être partagées en clair sans perdre le contrôle.")}</p>
                <p>{d("Sirius inverse le flux :")} <span className={strong}>{d("le modèle vient à la donnée")}</span>{d(", dans une enclave où ni Sirius, ni le borrower, ni le provider ne peuvent lire le dataset pendant le calcul.")}</p>
              </Section>

              <Section id="solution" title={d("La solution en un coup d'œil")}>
                <p>{d("Le navigateur chiffre le dataset avant son envoi. Le runner TEE le traite, produit un modèle chiffré et ne révèle le secret de livraison qu’au moment du règlement. Les contrats EVM rendent le paiement et l’audit vérifiables.")}</p>
                <OverviewDiagram d={d} />
                <Caption>{d("Le CSV en clair n’existe que dans l’enclave ; seuls le modèle chiffré et les preuves sortent du runner.")}</Caption>
              </Section>

              <Section id="acteurs" title={d("Les acteurs & artefacts")}>
                <ul className="ml-5 list-disc space-y-2 marker:text-muted">
                  <li><span className={strong}>Provider</span> — {d("publie un dataset chiffré et reçoit le règlement.")}</li>
                  <li><span className={strong}>Borrower</span> — {d("choisit un dataset, finance le prêt et récupère le modèle.")}</li>
                  <li><span className={strong}>Runner TEE</span> — {d("ouvre le dataset, calcule, atteste et détient le préimage.")}</li>
                  <li><span className={strong}>Sirius</span> — {d("orchestre sans custodie des fonds, du CSV en clair ou des secrets de règlement.")}</li>
                </ul>
                <ul className="ml-5 list-disc space-y-2 marker:text-muted">
                  <li><span className={strong}>{d("Dataset chiffré")}</span> — {d("blob AES-256-GCM sur IPFS.")}</li>
                  <li><span className={strong}>{d("Titre de dataset")}</span> — {d("hash du CID, Merkle root et taille inscrits publiquement dans")} `SiriusDatasetRegistry`.</li>
                  <li><span className={strong}>{d("Attestation KYB")}</span> — {d("credential EIP-712 consenti par le wallet, émis par un vérificateur externe et requis par le registre comme par l’escrow.")}</li>
                  <li><span className={strong}>{d("Capsule modèle")}</span> — {d("clé de livraison chiffrée pour le navigateur et liée au préimage.")}</li>
                </ul>
              </Section>

              <Section id="parcours" title={d("Le parcours complet")}>
                <ol className="space-y-5">
                  {[
                    ["01", d("Déposer"), d("Le navigateur chiffre le CSV pour le runner. Le TEE calcule le Merkle root, scelle une clé par dataset et envoie le blob chiffré sur IPFS.")],
                    ["02", d("Publier"), d("Le provider, après KYB, inscrit le titre du dataset dans le registre EVM. Le CSV chiffré reste hors chaîne ; le hash du CID, le Merkle root et la taille sont publics et permanents.")],
                    ["03", d("Verrouiller"), d("Le borrower approuve puis verrouille des USDC exacts dans l’escrow. Les KYB du borrower et du provider, le hashlock et l’échéance définissent les seules issues possibles.")],
                    ["04", d("Entraîner"), d("Le runner vérifie les KYB, la portée du titre de dataset et les termes de l’escrow avant d’ouvrir le dataset dans le TEE.")],
                    ["05", d("Régler"), d("Le borrower persiste la capsule. Le runner appelle `release`, publie le préimage et crédite le provider ; la capsule devient alors ouvrable.")],
                  ].map(([n, title, description]) => (
                    <li key={n} className="flex gap-4">
                      <span className="shrink-0 text-2xl font-semibold tracking-tight text-muted">{n}</span>
                      <div><div className="font-semibold text-foreground">{title}</div><p className="mt-1">{description}</p></div>
                    </li>
                  ))}
                </ol>
              </Section>

              <Section id="etat" title={d("État de l’implémentation")}>
                <div className="grid gap-3 sm:grid-cols-3">
                  {[
                    ["Escrow USDC", d("Implémenté"), d("Hashlock SHA-256, transferts USDC exacts, KYB des deux parties, remboursement et retraits pull-only.")],
                    ["KYB", d("Implémenté"), d("Attestations EIP-712, expiration, révocation durable et consentement du wallet ; l’émetteur est externe.")],
                    [d("Contrôles croisés"), d("Implémenté"), d("L’escrow contrôle le KYB ; le runner contrôle KYB, titre de dataset et termes de l’escrow avant déchiffrement.")],
                  ].map(([name, state, description]) => <div key={name} className="rounded-xl border border-border bg-surface/40 p-4"><div className="text-xs font-medium tracking-widest text-muted">{state}</div><div className="mt-1 font-semibold text-foreground">{name}</div><p className="mt-1 text-sm text-muted">{description}</p></div>)}
                </div>
                <p>{d("Cette distinction est volontaire : la documentation décrit le comportement déployable du code, pas seulement la cible produit.")}</p>
              </Section>

              <Section id="fair-exchange" title={d("Le fair-exchange atomique")}>
                <p>{d("Le runner TEE contrôle le release, pas les deux contreparties. Le borrower possède d’abord une capsule inutilisable ; le préimage qui l’ouvre n’est publié qu’avec le crédit du provider.")}</p>
                <FairExchangeDiagram d={d} />
                <p>{d("`release` est autorisé uniquement avant l’échéance. Après celle-ci, seul `refund` peut créditer le borrower : aucun préimage ne peut alors être publié par l’escrow.")}</p>
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full border-collapse text-sm">
                    <thead><tr className="border-b border-border text-left text-muted"><th className="py-2 pr-4 font-medium">{d("Scénario")}</th><th className="py-2 font-medium">{d("Issue")}</th></tr></thead>
                    <tbody className="align-top">
                      {[
                        [d("Calcul réussi"), d("Provider crédité et capsule ouverte par la même transaction EVM.")],
                        [d("Job invalide ou infructueux"), d("Aucun préimage n’est révélé ; le borrower récupère les fonds après échéance.")],
                        [d("Tentative d'obtenir le modèle sans payer"), d("Impossible : la capsule exige le préimage publié au règlement.")],
                        [d("Litige subjectif sur la qualité"), d("Non tranché par l’escrow seul ; arbitrage à venir.")],
                      ].map(([scenario, outcome]) => <tr key={scenario} className="border-b border-border/60"><td className="py-2.5 pr-4 text-foreground">{scenario}</td><td className="py-2.5">{outcome}</td></tr>)}
                    </tbody>
                  </table>
                </div>
              </Section>

              <Section id="escrow" title={d("Cycle de vie de l'escrow")}>
                <p>{d("Le borrower signe le verrouillage depuis son wallet. `SiriusEscrow` ne connaît que trois états : verrouillé, réglé ou remboursé ; `release` et `refund` sont donc mutuellement exclusifs.")}</p>
                <EscrowLifecycleDiagram d={d} />
                <p>{d("Les crédits sont retirés séparément, par `withdraw` ou `withdrawFor`. Un wallet de provider qui refuse un transfert ne peut pas bloquer la transition du prêt.")}</p>
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full min-w-[640px] border-collapse text-sm">
                    <thead><tr className="border-b border-border text-left text-muted"><th className="py-2 pr-4 font-medium">{d("Appel")}</th><th className="py-2 pr-4 font-medium">{d("Qui peut l’appeler")}</th><th className="py-2 font-medium">{d("Effet vérifiable")}</th></tr></thead>
                    <tbody className="align-top">
                      {[
                        ["lock", d("Le borrower"), d("Crée un prêt unique en USDC, fixe provider, montant, hashlock et échéance de 1 à 30 jours ; les deux KYB doivent être valides.")],
                        ["release", d("Toute adresse qui connaît le préimage, avant l’échéance"), d("Révèle le préimage et crédite le provider, sans transfert externe dans cette transaction.")],
                        ["refund", d("Toute adresse, après échéance"), d("Crédite uniquement le borrower ; cet appel ferme définitivement la fenêtre de release.")],
                        ["withdrawFor", d("Toute adresse"), d("Transfère le crédit uniquement au compte désigné, avec protection anti-réentrance.")],
                      ].map(([action, caller, effect]) => <tr key={action} className="border-b border-border/60"><td className="py-2.5 pr-4 font-mono text-foreground">{action}</td><td className="py-2.5 pr-4">{caller}</td><td className="py-2.5">{effect}</td></tr>)}
                    </tbody>
                  </table>
                </div>
              </Section>

              <Section id="confidentialite" title={d("Confidentialité : qui voit quoi")}>
                <div className="mt-4 overflow-x-auto">
                  <table className="w-full min-w-[560px] border-collapse text-sm">
                    <thead><tr className="border-b border-border text-left text-muted"><th className="py-2 pr-4 font-medium">{d("Artefact")}</th><th className="py-2 pr-4 font-medium">Provider</th><th className="py-2 pr-4 font-medium">Borrower</th><th className="py-2 pr-4 font-medium">Sirius</th><th className="py-2 font-medium">TEE</th></tr></thead>
                    <tbody className="align-top">
                      {[
                        [d("Donnée brute"), d("oui (la sienne)"), d("non"), d("non"), d("oui, en enclave")],
                        [d("Dataset chiffré"), d("oui"), d("oui"), d("oui"), d("oui")],
                        [d("DEK et préimage"), d("non"), d("non"), d("non"), d("oui")],
                        [d("Titre et événements EVM"), d("oui"), d("oui"), d("oui"), d("oui")],
                        [d("Modèle déchiffré"), d("non"), d("oui"), d("non"), d("oui, pendant le job")],
                      ].map((row) => <tr key={row[0]} className="border-b border-border/60"><td className="py-2.5 pr-4 text-foreground">{row[0]}</td>{row.slice(1).map((cell, index) => <td key={`${row[0]}-${index}`} className="py-2.5 pr-4">{cell}</td>)}</tr>)}
                    </tbody>
                  </table>
                </div>
              </Section>

              <Section id="custody" title={d("Custody : qui détient quoi")}>
                <ul className="ml-5 list-disc space-y-2 marker:text-muted">
                  <li><span className={strong}>{d("Les fonds")}</span> {d("restent dans le wallet ou dans `SiriusEscrow` ; Sirius ne peut pas les déplacer discrétionnairement.")}</li>
                  <li><span className={strong}>{d("Le titre du dataset")}</span> {d("reste lié au provider. Le contenu est chiffré ; seul le hash de son CID, son Merkle root et sa taille sont publics.")}</li>
                  <li><span className={strong}>{d("Les clés")}</span> {d("restent dans le runner TEE ; la master key est scellée par dstack en production.")}</li>
                  <li><span className={strong}>{d("La suppression")}</span> {d("détruit la clé de dataset et laisse un tombstone vérifiable, sans rendre le contenu récupérable.")}</li>
                </ul>
              </Section>

              <Section id="evm" title={d("Les contrats EVM")}>
                <div className="grid gap-3 sm:grid-cols-3">
                  {[
                    ["SiriusEscrow", d("Règlement"), d("Pas d’admin, pas d’upgrade ni de frais. USDC exact, hashlock SHA-256, KYB des deux parties, échéance stricte et crédits pull-only.")],
                    ["SiriusKybRegistry", "KYB", d("Attestations EIP-712 avec consentement, nonce anti-rejeu, expiration, révocation et époque de vérificateur. L’admin pilote les vérificateurs.")],
                    ["SiriusDatasetRegistry", d("Provenance"), d("Titre déterministe, KYB bloquant à la publication, hash du CID, Merkle root, taille et tombstone permanent après destruction.")],
                  ].map(([name, role, description]) => <div key={name} className="rounded-xl border border-border bg-surface/40 p-4"><div className="text-xs font-medium tracking-widest text-muted">{role}</div><div className="mt-1 font-semibold text-foreground">{name}</div><p className="mt-1 text-sm text-muted">{description}</p></div>)}
                </div>
                <p>{d("Le rail USDC et les parcours EVM sont implémentés. Il reste un redéploiement testnet, un émetteur KYB externe et une validation avec le runner Phala.")}</p>
              </Section>

              <Section id="securite" title={d("Garanties & limites de sécurité")}>
                <div className="grid gap-6 lg:grid-cols-2">
                  <div>
                    <h3 className="font-semibold text-foreground">{d("Ce que la chaîne garantit")}</h3>
                    <ul className="mt-3 ml-5 list-disc space-y-2 marker:text-muted">
                      <li>{d("Un prêt ne passe qu’une fois de `Locked` vers `Released` ou `Refunded`.")}</li>
                      <li>{d("Le provider ne peut être crédité sans que le préimage soit rendu public, et réciproquement.")}</li>
                      <li>{d("Le retrait ne peut pas modifier un prêt ni rediriger un crédit vers une autre adresse.")}</li>
                      <li>{d("Le registre considère un titre détruit comme inactif et une attestation KYB comme invalide après expiration, révocation ou retrait du vérificateur.")}</li>
                    </ul>
                  </div>
                  <div>
                    <h3 className="font-semibold text-foreground">{d("Ce qui reste hors contrat")}</h3>
                    <ul className="mt-3 ml-5 list-disc space-y-2 marker:text-muted">
                      <li>{d("La qualité, la licéité du dataset et la qualité du modèle restent hors de portée des contrats.")}</li>
                      <li>{d("Le hash du CID, le Merkle root, la taille et les identifiants de prêt sont publics et permanents : ils ne doivent contenir aucune donnée sensible.")}</li>
                      <li>{d("L’émetteur KYB, sa clé de signature et l’administration du registre sont des points de gouvernance à protéger hors de Next et du runner.")}</li>
                      <li>{d("Le code n’a pas encore fait l’objet d’une revue indépendante ni d’une validation testnet complète.")}</li>
                    </ul>
                  </div>
                </div>
              </Section>

              <div className="border-t border-border pt-12">
                {/*
                  Dit ici plutôt que découvert ailleurs. La page d'accueil promet un
                  modèle entraîné dans un TEE ; tant que l'enclave n'est pas adossée à
                  du matériel attesté, l'écart doit être annoncé par nous et non
                  constaté par un lecteur du code.
                */}
                <p className="text-xs leading-relaxed text-muted">
                  {d("L’attestation du runner tourne en simulation sur testnet ; le déploiement Phala sur matériel attesté est le prochain jalon.")}
                  {" "}
                  {d("Cette instance de test ne vérifie aucune entreprise : l’escrow pointe sur un registre ouvert qui accepte toute adresse. Le registre KYB gouverné existe dans les contrats et sera activé avant toute utilisation réelle.")}
                </p>
                <p className="mt-6 text-sm">
                  <Link href="/" onClick={returnToLanding} className="text-foreground underline underline-offset-4 hover:text-muted">{d("← Retour à l’accueil")}</Link>
                </p>
              </div>
            </div>
          </div>
        </main>
      </div>
    </div>
  );
}
