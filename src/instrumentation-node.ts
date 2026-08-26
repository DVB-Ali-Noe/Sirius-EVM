/**
 * Mode démonstration : construit comme la production, configuré pour un réseau de
 * test, sans enclave réelle.
 *
 * Il existe parce que `NODE_ENV=production` ne dit qu'une chose — le code est compilé
 * pour être servi — là où les contrôles ci-dessous en supposaient une autre : que
 * l'instance EST le produit final, sur mainnet, derrière un TEE attesté dont les
 * mesures sont épinglées. Tant que les deux notions sont confondues, aucune
 * démonstration publique n'est possible avant que le TEE tourne sur du vrai matériel,
 * puisque tout hébergeur impose `NODE_ENV=production`.
 *
 * Le drapeau vaut une chaîne exacte plutôt qu'un booléen : une variable laissée à
 * « 1 », « true » ou « yes » par mégarde n'active rien.
 */
const DEMO = process.env.SIRIUS_DEPLOYMENT_MODE === "demo";

export async function registerNode() {
  if (process.env.NODE_ENV === "production") {
    if (process.env.NEXT_PUBLIC_SIRIUS_E2E === "1") {
      throw new Error("NEXT_PUBLIC_SIRIUS_E2E interdit en production");
    }

    // Verrou principal. Les assouplissements du mode démonstration ne doivent jamais
    // s'appliquer à de l'argent réel : sur mainnet, l'instance repasse par la porte
    // stricte ou ne démarre pas du tout.
    if (DEMO && (process.env.EVM_NETWORK === "mainnet" || process.env.NEXT_PUBLIC_EVM_NETWORK === "mainnet")) {
      throw new Error("SIRIUS_DEPLOYMENT_MODE=demo est interdit sur mainnet");
    }

    // L'interface doit annoncer ce qu'elle est. Une démonstration qui se fait passer
    // pour le produit final est pire que pas de démonstration du tout.
    if (DEMO && process.env.NEXT_PUBLIC_SIRIUS_DEPLOYMENT_MODE !== "demo") {
      throw new Error(
        "NEXT_PUBLIC_SIRIUS_DEPLOYMENT_MODE=demo obligatoire : le navigateur doit savoir qu'il affiche une démonstration",
      );
    }

    if (!DEMO) {
      if (process.env.TEE_MODE !== "phala") throw new Error("TEE_MODE=phala obligatoire en production");
      if (process.env.DSTACK_SIMULATOR_ENDPOINT) throw new Error("Simulateur dstack interdit en production");
    }

    // Ce que toute instance servie publiquement exige, démonstration comprise :
    // de quoi signer les sessions, se désigner elle-même, et pointer sans ambiguïté
    // sur des contrats déployés.
    const requises = [
      "SIRIUS_SESSION_SECRET",
      "SIRIUS_APP_ORIGIN",
      "SIRIUS_ESCROW_ADDRESS",
      "SIRIUS_USDC_ADDRESS",
      "SIRIUS_KYB_ADDRESS",
      "SIRIUS_DATASET_ADDRESS",
      "NEXT_PUBLIC_SIRIUS_ESCROW_ADDRESS",
      "NEXT_PUBLIC_SIRIUS_USDC_ADDRESS",
      "NEXT_PUBLIC_SIRIUS_KYB_ADDRESS",
      "NEXT_PUBLIC_SIRIUS_DATASET_ADDRESS",
    ];

    // Ce que seule une instance adossée à une enclave réelle peut fournir. En
    // démonstration ces valeurs n'existent pas encore — les exiger reviendrait à
    // interdire la démonstration.
    if (!DEMO) {
      requises.push(
        "RUNNER_URL",
        "RUNNER_TRANSPORT_SECRET",
        "SIRIUS_EXPECTED_MRTD",
        "SIRIUS_EXPECTED_RTMR3",
        "SIRIUS_EXPECTED_COMPOSE_HASH",
        "SIRIUS_EXPECTED_MASTER_KEY_CHAIN_SHA256",
        "NEXT_PUBLIC_SIRIUS_INGRESS_KEY_SHA256",
      );
    }

    for (const name of requises) {
      if (!process.env[name]) throw new Error(`${name} obligatoire en production`);
    }

    // Le reaper tourne désormais comme worker autonome, hors du processus web. En
    // démonstration sur un hébergeur serverless, aucun processus ne lui survivrait
    // de toute façon.
    if (!DEMO && process.env.SIRIUS_REAPER_ENABLED !== "true") {
      throw new Error("SIRIUS_REAPER_ENABLED=true obligatoire en production");
    }
    if (process.env.SIRIUS_TRUST_PROXY_HEADERS !== "true") {
      throw new Error("SIRIUS_TRUST_PROXY_HEADERS=true obligatoire en production");
    }
    if (process.env.SIRIUS_INGRESS_RATE_LIMITED !== "true") {
      throw new Error("SIRIUS_INGRESS_RATE_LIMITED=true obligatoire en production");
    }

    if (!DEMO && (process.env.EVM_NETWORK !== "mainnet" || process.env.NEXT_PUBLIC_EVM_NETWORK !== "mainnet")) {
      throw new Error("EVM_NETWORK et NEXT_PUBLIC_EVM_NETWORK doivent être mainnet en production");
    }
    if (DEMO && (process.env.EVM_NETWORK !== "testnet" || process.env.NEXT_PUBLIC_EVM_NETWORK !== "testnet")) {
      throw new Error("Le mode démonstration exige EVM_NETWORK et NEXT_PUBLIC_EVM_NETWORK sur testnet");
    }

    // Contrôle conservé dans les deux modes : une valeur serveur et sa jumelle
    // publique qui divergent produiraient une interface affichant un contrat pendant
    // que le serveur en interroge un autre.
    for (const [privateName, publicName] of [
      ["SIRIUS_ESCROW_ADDRESS", "NEXT_PUBLIC_SIRIUS_ESCROW_ADDRESS"],
      ["SIRIUS_USDC_ADDRESS", "NEXT_PUBLIC_SIRIUS_USDC_ADDRESS"],
      ["SIRIUS_KYB_ADDRESS", "NEXT_PUBLIC_SIRIUS_KYB_ADDRESS"],
      ["SIRIUS_DATASET_ADDRESS", "NEXT_PUBLIC_SIRIUS_DATASET_ADDRESS"],
    ]) {
      if (process.env[privateName]?.toLowerCase() !== process.env[publicName]?.toLowerCase()) {
        throw new Error(`${privateName} et ${publicName} doivent désigner le même contrat`);
      }
    }
  }

  if (
    process.env.NODE_ENV !== "production" &&
    process.env.TEE_MODE === "phala" &&
    !process.env.RUNNER_URL
  ) {
    const { initEnclave } = await import("@/lib/tee/dstack");
    await initEnclave();
  }

  if (process.env.SIRIUS_REAPER_ENABLED === "true") {
    const { startLoanReaper } = await import("@/lib/sirius/reaper");
    startLoanReaper();
  }
}
