import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { CONTACT_EMAIL } from "@/lib/copy/disclaimers";

/**
 * Tests par inspection de source : la page des conditions est un composant serveur, on
 * vérifie que ses clauses clés sont présentes (docs/passage-mainnet/16, section 6) et que
 * les encarts d'avertissement sont branchés sur les pages concernées.
 */

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
// Les phrases du source tiennent sur une ligne ; on neutralise tout de même les espaces.
const terms = read("./page.tsx").replace(/\s+/g, " ");

test("conditions : traçage des accès et des empreintes de modèles déclaré", () => {
  assert.match(terms, /Sirius records dataset accesses and the fingerprint of each delivered model in order to detect and investigate leaks/);
});

test("conditions : consentement facultatif, décoché par défaut, enclave seule, révocable", () => {
  assert.match(terms, /inside the secure enclave only/);
  assert.match(terms, /optional and off by default/);
  assert.match(terms, /withdraw your consent at any time/);
  assert.match(terms, /Without your consent, Sirius does not use your dataset/);
});

test("conditions : suspension possible d'un compte en cas d'abus", () => {
  assert.match(terms, /Sirius can suspend an account in case of abuse/);
  // Honnêteté sur les limites : pas de saisie des fonds déjà dans l'escrow.
  assert.match(terms, /cannot seize or freeze funds already locked in the escrow contract/);
});

test("conditions : délai de sécurité de 3 jours et remboursement hors calcul consommé", () => {
  assert.match(terms, /safety period of 3 days/);
  assert.match(terms, /Only the compute actually used before the failure/);
  assert.match(terms, /Retraining is a new loan/);
  assert.doesNotMatch(terms, /safety period of (?!3 days)/, "un seul délai de sécurité est annoncé");
});

test("conditions : paiement en USDG émis par Paxos, qui peut geler des adresses, sans mention d'USDC", () => {
  assert.match(terms, /USDG, a stablecoin issued by Paxos/);
  assert.match(terms, /Paxos can freeze addresses/);
  assert.doesNotMatch(terms, /USDC/);
});

test("conditions : nature bêta, modèles de base, date de mise à jour et contact", () => {
  assert.match(terms, /access is by invitation/);
  assert.match(terms, /baseline models: linear and logistic regression/);
  const date = /Last updated \{LAST_UPDATED\}/.test(terms) && /const LAST_UPDATED = "(\d{1,2} [A-Z][a-z]+ \d{4})"/.exec(terms);
  assert.ok(date, "une date de mise à jour est affichée");
  assert.ok(Number.isFinite(Date.parse(`${date[1]} UTC`)), "la date est lisible");
  assert.match(terms, /CONTACT_EMAIL/);
  assert.match(CONTACT_EMAIL, /^[^@\s]+@[^@\s]+$/);
});

test("conditions : aucune promesse absolue sur les modèles ou la sécurité des fonds", () => {
  assert.doesNotMatch(terms, /\b(guarantee[sd]? (that )?(the )?(model|funds)|risk-free|100%|fully secure|unhackable)/i);
  assert.match(terms, /not been externally audited/);
});

test("pages : encarts d'avertissement branchés sur le tableau de bord, Train et la landing", () => {
  const dashboard = read("../(app)/dashboard/page.tsx");
  assert.match(dashboard, /<DisclaimerNote messages=\{\["betaLimits", "modelQuality", "contactUs"\]\}/);
  const train = read("../(app)/train/page.tsx");
  assert.match(train, /<DisclaimerNote messages=\{\["modelQuality", "retrainDeterministic", "betaLimits", "contactUs"\]\}/);
  const landing = read("../page.tsx");
  assert.match(landing, /<DisclaimerNote messages=\{\["betaLimits", "modelQuality"\]\}/);
});

test("landing : pied de page avec les liens conditions et état, et le réseau", () => {
  const landing = read("../page.tsx");
  const footer = landing.slice(landing.indexOf("<footer"), landing.indexOf("</footer>"));
  assert.match(footer, /href="\/terms"/);
  assert.match(footer, /href="\/status"/);
  assert.match(footer, /networkLine/);
  assert.match(landing, /Robinhood Chain/);
});

test("conditions : journal des accès conservé 24 mois puis supprimé", () => {
  assert.match(terms, /kept for 24 months after the access, then deleted/);
});

test("connexion : la mention des conditions accompagne chaque bouton de connexion", () => {
  const notice = read("../../components/wallet/TermsNotice.tsx");
  assert.match(notice, /href="\/terms"/);
  assert.match(notice, /rel="noopener noreferrer"/);
  for (const file of ["../../components/wallet/ConnectButton.tsx", "../../components/wallet/SignInCta.tsx"]) {
    assert.match(read(file), /<TermsNotice/, file);
  }
});
