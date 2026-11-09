"use client";

import { useState } from "react";
import Link from "next/link";
import { useLocale } from "@/components/i18n/LocaleProvider";
import { isModelOffered } from "@/lib/models/registry";
import { CodeBlock, DocSection, DocsShell, Hint, HERO_PRIMARY, HERO_SECONDARY } from "../DocsShell";

const API_EN: Record<string, string> = {
  "API développeurs": "Developer API",
  "Appelle depuis ton code le modèle que tu loues sur Sirius. Le modèle reste scellé dans l’enclave ; chaque réponse est signée par elle. Les requêtes sont signées avec ta clé : ni Sirius ni le serveur web ne peuvent appeler à ta place.":
    "Call the model you rent on Sirius from your code. The model stays sealed in the enclave, and every answer is signed by it. Requests are signed with your key: neither Sirius nor the web server can call on your behalf.",
  "Démarrer": "Get started",
  "Où tourne le modèle": "Where the model runs",
  "Ton modèle tourne dans une Confidential VM Intel TDX sur Phala Cloud, construite avec dstack. Le site vérifie son attestation RA-TLS à chaque appel, et la clé qui signe les réponses ne sort jamais de l’enclave.":
    "Your model runs in an Intel TDX Confidential VM on Phala Cloud, built with dstack. The site checks its RA-TLS attestation on every call, and the key that signs the answers never leaves the enclave.",
  "La CVM est allumée à la demande : le premier appel après une pause peut attendre son réveil (voir « Délais et réessais »).":
    "The CVM runs on demand: the first call after a pause may wait for it to wake up (see “Delays and retries”).",
  "Spécification OpenAPI": "OpenAPI specification",
  "Authentification": "Authentication",
  "Signature pas à pas": "Signing step by step",
  "Routes": "Routes",
  "Codes d’erreur": "Error codes",
  "Délais et réessais": "Delays and retries",
  "Quotas et packs": "Quotas and packs",
  "Limites": "Limits",
  "SDK": "SDKs",
  "Quand la page Train suit le règlement de ton emprunt, elle crée une clé par défaut ; sinon, ouvre l’emprunt réglé, puis « Créer une clé API ». La clé complète, sk_live_<keyId>.<secret>, n’est affichée qu’une fois : copie-la dans ton gestionnaire de secrets. Elle est générée dans ton navigateur et son secret est chiffré pour l’enclave ; Sirius ne le conserve pas en clair.":
    "When the Train page follows your loan’s settlement, it creates a default key; otherwise, open the settled loan, then “Create an API key”. The full key, sk_live_<keyId>.<secret>, is shown only once: copy it into your secret manager. It is generated in your browser and its secret is encrypted for the enclave; Sirius never stores it in clear.",
  "Chaque requête porte quatre en-têtes :": "Every request carries four headers:",
  "identifiant de la clé (22 caractères), sans le préfixe ni le secret ;": "key identifier (22 characters), without the prefix or the secret;",
  "heure Unix en secondes ;": "Unix time in seconds;",
  "chaîne aléatoire à usage unique, 16 à 64 caractères base64url ;": "single-use random string, 16 to 64 base64url characters;",
  "HMAC-SHA256 en hexadécimal minuscule de la chaîne canonique.": "lowercase hex HMAC-SHA256 of the canonical string.",
  "Jusqu’à 5 clés actives par emprunt. Révoque une clé depuis la page Train : elle est refusée aussitôt par l’enclave.":
    "Up to 5 active keys per loan. Revoke a key from the Train page: the enclave refuses it immediately.",
  "Calcule le SHA-256 du corps brut, octet par octet, en hexadécimal minuscule. Corps vide (GET) : e3b0c442…b855.":
    "Compute the SHA-256 of the raw body, byte for byte, as lowercase hex. Empty body (GET): e3b0c442…b855.",
  "Assemble six lignes séparées par \\n, sans saut de ligne final : préfixe, méthode en majuscules, chemin public sans query, horodatage, nonce, empreinte du corps.":
    "Join six lines with \\n, no trailing newline: prefix, upper-case method, public path without query, timestamp, nonce, body hash.",
  "Signe cette chaîne en HMAC-SHA256 avec les 32 octets du secret (décodé depuis le base64url), et envoie la signature en hexadécimal minuscule.":
    "Sign this string with HMAC-SHA256 keyed with the 32 bytes of the secret (decoded from base64url), and send the signature as lowercase hex.",
  "Envoie exactement les octets que tu as hachés : un corps reformaté invalide la signature.":
    "Send exactly the bytes you hashed: a re-formatted body invalidates the signature.",
  "Le chemin signé est toujours le chemin public, /v1/models/<loanId>…, même si tu appelles https://sirius-data.tech/api/v1/… : une signature d’un emprunt ou d’une route ne vaut pour aucun autre.":
    "The signed path is always the public path, /v1/models/<loanId>…, even if you call https://sirius-data.tech/api/v1/…: a signature for one loan or route is valid for no other.",
  "Profil du modèle, variables attendues, fin de location et appels restants. Ne consomme pas de quota.":
    "Model profile, expected features, rental end and remaining calls. Does not consume quota.",
  "Prédiction signée par l’enclave. Corps : {\"features\": {…}} avec exactement les variables du modèle, en nombres finis (16 Kio au plus). Consomme un appel.":
    "Prediction signed by the enclave. Body: {\"features\": {…}} with exactly the model's features, as finite numbers (16 KiB at most). Consumes one call.",
  "Réponse de prédiction :": "Prediction response:",
  "Les erreurs ont la forme {\"error\": {\"code\", \"message\"}}. Le code est stable ; le message peut changer.":
    "Errors look like {\"error\": {\"code\", \"message\"}}. The code is stable; the message may change.",
  "Code": "Code",
  "Statut": "Status",
  "Signification": "Meaning",
  "Signature invalide (secret, chemin, méthode ou corps différents).": "Invalid signature (different secret, path, method or body).",
  "Horodatage à plus de 300 s de l’horloge de l’enclave.": "Timestamp more than 300 s away from the enclave clock.",
  "Nonce déjà utilisé : chaque requête en demande un nouveau.": "Nonce already used: every request needs a new one.",
  "Clé inconnue ou rattachée à un autre emprunt.": "Unknown key, or one attached to another loan.",
  "Clé révoquée.": "Revoked key.",
  "Location expirée : prolonge-la depuis la page Train.": "Rental expired: extend it from the Train page.",
  "Accès API non payé pour cette période : active l’API (pass journalier) depuis la page Entraîner.":
    "API access not paid for this period: activate the API (daily pass) from the Train page.",
  "Accès payé au jour": "Daily paid access",
  "L’API est payée au jour et incluse dans toute location : le devis d’emprunt ajoute jours loués × prix journalier de l’API du tarif en vigueur aux frais de calcul, sur une ligne à part. Un seul devis, un seul paiement, remboursé avec le reste si l’entraînement échoue (hors frais d’exécution mesurés). Sans prix journalier dans le tarif, aucune location n’est possible.":
    "The API is paid per day and included in every rental: the borrow quote adds rented days × the API daily price of the current tariff to the compute fees, on a separate line. One quote, one payment, refunded with the rest if training fails (except measured execution fees). Without a daily price in the tariff, no rental is possible.",
  "L’accès couvre la location jusqu’à sa fin, et une prolongation l’inclut d’office pour les jours ajoutés. Sans accès payé couvrant l’instant présent, l’API répond 403 api_access_required et aucune clé ne peut être créée.":
    "Access covers the rental up to its end, and an extension automatically includes it for the added days. Without paid access covering the current time, the API answers 403 api_access_required and no key can be created.",
  "Locations ouvertes avant le 8 novembre 2026 sans API : sur la page Entraîner, un pass journalier payé à Sirius au prix par jour du tarif en vigueur (plus 0,001 USDC au fournisseur : le contrat refuse une part fournisseur nulle) couvre la location jusqu’à sa fin ; après une prolongation non couverte, un pass complémentaire paie les jours ajoutés. Le devis signé affiche le nombre de jours et le total avant tout paiement.":
    "Rentals opened before November 8, 2026 without the API: on the Train page, a daily pass paid to Sirius at the daily price of the current tariff (plus 0.001 USDC to the provider: the contract refuses a zero provider share) covers the rental up to its end; after an uncovered extension, a top-up pass pays for the added days. The signed quote shows the number of days and the total before any payment.",
  "Les prédictions depuis le site restent incluses. Le quota du jour et les packs s’appliquent en plus de l’accès API.":
    "Predictions from the website stay included. The daily quota and packs apply on top of API access.",
  "Quota du jour épuisé et plus aucun appel prépayé.": "Today's quota used up and no prepaid call left.",
  "Profil sans API (régression linéaire).": "Profile without API (linear regression).",
  "Variables absentes, en trop ou non numériques.": "Missing, extra or non-numeric features.",
  "Trop de requêtes : 120 par minute par clé (réponses de l’enclave après authentification, refus liés à la location) ; 60 par minute par adresse IP (par /64 en IPv6) pour le trafic invalide seul (en-têtes ou corps invalides, clé inconnue ou révoquée, signature, horodatage ou nonce refusés), au-delà toute requête de cette adresse est refusée ; 120 par modèle dans l’enclave, dont 60 descriptions, comptées avant la signature. enclave_starting, controller_unavailable et runner_busy ne comptent nulle part.": "Too many requests: 120 per minute per key (enclave answers after authentication, rental-related refusals); 60 per minute per IP address (per /64 for IPv6) for invalid traffic only (malformed headers or body, unknown or revoked key, rejected signature, timestamp or nonce), beyond which every request from that address is refused; 120 per model in the enclave, including 60 descriptions, counted before the signature. enclave_starting, controller_unavailable and runner_busy count nowhere.",
  "L’enclave démarre : réessaie après Retry-After.": "The enclave is starting: retry after Retry-After.",
  "Emprunt inconnu, ou ligne de prolongation ou de pack.": "Unknown loan, or an extension or pack line.",
  "Emprunt pas encore réglé, ou en revue de finalité.": "Loan not settled yet, or under finality review.",
  "Corps de plus de 16 Kio.": "Body larger than 16 KiB.",
  "Requête mal formée (corps non UTF-8, longueur incohérente).": "Malformed request (non UTF-8 body, inconsistent length).",
  "Corps de requête pas reçu à temps.": "Request body not received in time.",
  "Conflit passager côté enclave (règlement on-chain pas encore confirmé, lecture RPC en échec) : réessaie plus tard avec une nouvelle signature.": "Transient conflict in the enclave (on-chain settlement not confirmed yet, RPC read failure): retry later with a new signature.",
  "Sortie numériquement instable pour ces variables ; l’appel est décompté.": "Numerically unstable output for these features; the call is counted.",
  "Enclave saturée : rien n’a été décompté, réessaie après Retry-After.": "Enclave saturated: nothing was counted, retry after Retry-After.",
  "Gestion de l’enclave momentanément indisponible ou maintenance : rien n’a été décompté, réessaie après Retry-After (60 s).": "Enclave management briefly unavailable or under maintenance: nothing was counted, retry after Retry-After (60 s).",
  "Enclave injoignable : l’appel a pu être décompté, ne le renvoie pas aveuglément.": "Enclave unreachable: the call may have been counted, do not resend it blindly.",
  "Réponse de l’enclave invalide ou en erreur : réessaie plus tard.": "Invalid or failing enclave response: retry later.",
  "Pour réduire ses coûts, Sirius n’allume la machine confidentielle que lorsqu’elle sert : elle s’arrête environ une heure après la dernière activité (appel API, prédiction ou paiement sur le site). Le premier appel après une pause la redémarre et peut prendre environ 2 minutes : il reçoit 503 enclave_starting avec Retry-After, et les SDK réessaient seuls. Une clé inconnue ou révoquée, ou une location échue, ne la démarre jamais.":
    "To keep costs down, Sirius only runs the confidential machine while it is used: it stops about one hour after the last activity (API call, prediction or payment on the website). The first call after a pause starts it again and can take about 2 minutes: it gets 503 enclave_starting with Retry-After, and the SDKs retry on their own. An unknown or revoked key, or an expired rental, never starts it.",
  "Pendant un démarrage (environ 2 minutes, jusqu’à 5 exceptionnellement), l’API répond 503 avec le code enclave_starting et un en-tête Retry-After en secondes. Attends ce délai, puis renvoie la requête avec un nouvel horodatage, un nouveau nonce et une nouvelle signature : rien n’a été décompté.":
    "During a start (about 2 minutes, up to 5 in rare cases), the API answers 503 with code enclave_starting and a Retry-After header in seconds. Wait that long, then send the request again with a new timestamp, a new nonce and a new signature: nothing was counted.",
  "Les SDK le font pour toi, jusqu’à un délai maximal réglable (8 minutes par défaut), ainsi que pour 503 runner_busy, avec un recul exponentiel et une gigue, et pour 503 controller_unavailable (gestion de l’enclave momentanément indisponible, Retry-After de 60 s). Ils ne renvoient jamais seuls un autre 503 (runner_unavailable) ni un appel resté sans réponse : l’enclave a pu le décompter. Prévois un délai client supérieur à 60 s, l’attente maximale de l’API envers l’enclave.": "The SDKs do it for you, up to a configurable maximum wait (8 minutes by default), and also for 503 runner_busy, with exponential backoff and jitter, and for 503 controller_unavailable (enclave management briefly unavailable, 60 s Retry-After). They never resend another 503 (runner_unavailable) or a call left without an answer on their own: the enclave may have counted it. Use a client timeout above 60 s, the API's maximum wait for the enclave.",
  "Chaque emprunt inclut un quota d’appels par jour (jour UTC), commun au site et à l’API : 50 pour la régression logistique, 100 pour les arbres boostés (valeurs de la politique de facturation en vigueur).":
    "Each loan includes a daily call quota (UTC day), shared by the website and the API: 50 for logistic regression, 100 for boosted trees (values from the current billing policy).",
  "Au-delà, achète des packs de 100, 1 000 ou 10 000 appels depuis la page Train. Ils sont cumulables, consommés après le quota du jour, expirent avec la location et ne sont pas remboursables.":
    "Beyond that, buy packs of 100, 1,000 or 10,000 calls from the Train page. They stack, are used after the daily quota, expire with the rental and are not refundable.",
  "Prix d’un appel = prix par jour du dataset ÷ quota du jour, arrondi au supérieur ; un pack coûte sa taille × ce prix, plus les frais de calcul de Sirius à prix coûtant. Le devis signé affiche le total avant tout paiement.":
    "Price per call = dataset daily price ÷ daily quota, rounded up; a pack costs its size × that price, plus Sirius compute fees at cost. The signed quote shows the total before any payment.",
  "Chaque réponse donne remaining.today et remaining.credits : c’est le compteur qui fait foi.":
    "Every response gives remaining.today and remaining.credits: that is the authoritative counter.",
  "Pas de probabilité : la sortie est une décision 0/1 ou une valeur arrondie, signée.": "No probability: the output is a 0/1 decision or a rounded value, signed.",
  "La régression linéaire n’est plus proposée pour de nouveaux datasets. Même réactivée, elle n’aurait pas d’API : quelques appels suffiraient à reconstruire le modèle. Les prêts linéaires existants restent interrogeables depuis le site.":
    "Linear regression is no longer offered for new datasets. Even if re-enabled, it would have no API: a few calls would be enough to reconstruct the model. Existing linear loans can still be queried from the website.",
  "La régression linéaire n’a pas d’API : quelques appels suffiraient à reconstruire le modèle. Ses prêts restent interrogeables depuis le site.":
    "Linear regression has no API: a few calls would be enough to reconstruct the model. Its loans can still be queried from the website.",
  "Le nombre d’appels par jour borne ce qu’un emprunteur peut apprendre du modèle.": "The number of calls per day bounds what a borrower can learn from the model.",
  "Le serveur web de Sirius relaie la requête et voit donc les variables envoyées ; il ne peut pas fabriquer d’appel, faute du secret.":
    "The Sirius web server relays the request and therefore sees the features you send; it cannot forge a call, since it lacks the secret.",
  "L’enclave peut être en cours de démarrage : prévois les réessais (503 + Retry-After).": "The enclave may be starting: plan for retries (503 + Retry-After).",
  "Deux SDK d’un seul fichier, sans dépendance : ils signent, réessaient seuls sur 503 enclave_starting, runner_busy et controller_unavailable (rien n’a été décompté) et renvoient des erreurs typées par code ; une autre erreur, réseau comprise, remonte sans réessai.":
    "Two single-file SDKs, without dependencies: they sign, retry on their own on 503 enclave_starting, runner_busy and controller_unavailable (nothing was counted) and raise errors typed by code; any other error, network errors included, is raised without retrying.",
  "Signature à la main (curl et openssl) :": "Signing by hand (curl and openssl):",
  "Spécification complète :": "Full specification:",
  "Comment fonctionne Sirius": "How Sirius works",
  "Copier": "Copy",
  "Copié": "Copied",
  "Bon à savoir": "Good to know",
};

const TOC = [
  { id: "authentification", label: "Authentification" },
  { id: "signature", label: "Signature pas à pas" },
  { id: "routes", label: "Routes" },
  { id: "erreurs", label: "Codes d’erreur" },
  { id: "reessais", label: "Délais et réessais" },
  { id: "acces", label: "Accès payé au jour" },
  { id: "quotas", label: "Quotas et packs" },
  { id: "limites", label: "Limites" },
  { id: "sdk", label: "SDK" },
];

const CANONICAL = `SIRIUS-HMAC-SHA256
POST
/v1/models/<loanId>/predict
1762500000
bm9uY2UtZml4dHVyZS0wMQ
57665e54ca62e7da7eb5f145cd03f39926d866917cbbc315d58693a45618168e`;

const JS_EXAMPLE = `import { SiriusClient, SiriusApiError } from "./sirius-api";

const sirius = new SiriusClient({ apiKey: process.env.SIRIUS_API_KEY! });
const info = await sirius.info("<loanId>");           // features, remaining
try {
  const result = await sirius.predict("<loanId>", { age: 42, income: 51000 });
  console.log(result.outputKind, result.decision ?? result.value, result.remaining);
} catch (error) {
  if (error instanceof SiriusApiError && error.code === "quota_exceeded") {
    // buy a call pack on the Train page
  }
  throw error;
}`;

const PY_EXAMPLE = `import os
from sirius_api import SiriusClient, SiriusApiError

sirius = SiriusClient(api_key=os.environ["SIRIUS_API_KEY"])
info = sirius.info("<loanId>")
try:
    result = sirius.predict("<loanId>", {"age": 42, "income": 51000})
    print(result["outputKind"], result.get("decision", result.get("value")), result["remaining"])
except SiriusApiError as error:
    if error.code == "quota_exceeded":
        pass  # buy a call pack on the Train page
    raise`;

const CURL_EXAMPLE = `KEY="sk_live_<keyId>.<secret>"
KEY_ID="\${KEY#sk_live_}"; KEY_ID="\${KEY_ID%%.*}"; SECRET="\${KEY##*.}"
LOAN="<loanId>"; PATH_="/v1/models/$LOAN/predict"
BODY='{"features":{"age":42,"income":51000}}'
TS=$(date +%s); NONCE=$(openssl rand -base64 18 | tr '+/' '-_' | tr -d '=')
BODY_SHA=$(printf '%s' "$BODY" | openssl dgst -sha256 -hex | sed 's/^.* //')
HEX_KEY=$(printf '%s' "$SECRET" | tr '_-' '/+' | base64 -d 2>/dev/null | xxd -p -c 256)
SIG=$(printf 'SIRIUS-HMAC-SHA256\\nPOST\\n%s\\n%s\\n%s\\n%s' "$PATH_" "$TS" "$NONCE" "$BODY_SHA" \\
  | openssl dgst -sha256 -mac HMAC -macopt hexkey:$HEX_KEY -hex | sed 's/^.* //')
curl -sS "https://api.sirius-data.tech$PATH_" -H 'Content-Type: application/json' \\
  -H "Sirius-Key: $KEY_ID" -H "Sirius-Timestamp: $TS" -H "Sirius-Nonce: $NONCE" \\
  -H "Sirius-Signature: $SIG" --data-raw "$BODY"`;

const RESPONSE_EXAMPLE = `{
  "outputKind": "decision",
  "decision": "1",
  "counter": 12,
  "remaining": { "today": 38, "credits": 1000 },
  "expiresAt": "2026-11-14T08:00:00.000Z",
  "modelId": "logistic_regression",
  "modelVersion": "1.0.0",
  "signature": "0x…",
  "signer": "0x…",
  "domain": { "name": "SiriusPrediction", "version": "2", "chainId": 4663 },
  "signedMessage": { "…": "…" }
}`;

const ERRORS: readonly [string, string, string][] = [
  ["invalid_signature", "401", "Signature invalide (secret, chemin, méthode ou corps différents)."],
  ["request_expired", "401", "Horodatage à plus de 300 s de l’horloge de l’enclave."],
  ["unknown_key", "401", "Clé inconnue ou rattachée à un autre emprunt."],
  ["key_revoked", "401", "Clé révoquée."],
  ["rental_expired", "403", "Location expirée : prolonge-la depuis la page Train."],
  ["api_access_required", "403", "Accès API non payé pour cette période : active l’API (pass journalier) depuis la page Entraîner."],
  ["replayed_request", "409", "Nonce déjà utilisé : chaque requête en demande un nouveau."],
  ["api_not_available_for_profile", "409", "Profil sans API (régression linéaire)."],
  ["invalid_features", "400", "Variables absentes, en trop ou non numériques."],
  ["quota_exceeded", "429", "Quota du jour épuisé et plus aucun appel prépayé."],
  ["rate_limited", "429", "Trop de requêtes : 120 par minute par clé (réponses de l’enclave après authentification, refus liés à la location) ; 60 par minute par adresse IP (par /64 en IPv6) pour le trafic invalide seul (en-têtes ou corps invalides, clé inconnue ou révoquée, signature, horodatage ou nonce refusés), au-delà toute requête de cette adresse est refusée ; 120 par modèle dans l’enclave, dont 60 descriptions, comptées avant la signature. enclave_starting, controller_unavailable et runner_busy ne comptent nulle part."],
  ["not_found", "404", "Emprunt inconnu, ou ligne de prolongation ou de pack."],
  ["model_unavailable", "409", "Emprunt pas encore réglé, ou en revue de finalité."],
  ["payload_too_large", "413", "Corps de plus de 16 Kio."],
  ["invalid_request", "400", "Requête mal formée (corps non UTF-8, longueur incohérente)."],
  ["enclave_starting", "503", "L’enclave démarre : réessaie après Retry-After."],
  ["request_timeout", "408", "Corps de requête pas reçu à temps."],
  ["conflict", "409", "Conflit passager côté enclave (règlement on-chain pas encore confirmé, lecture RPC en échec) : réessaie plus tard avec une nouvelle signature."],
  ["prediction_unstable", "422", "Sortie numériquement instable pour ces variables ; l’appel est décompté."],
  ["runner_busy", "503", "Enclave saturée : rien n’a été décompté, réessaie après Retry-After."],
  ["controller_unavailable", "503", "Gestion de l’enclave momentanément indisponible ou maintenance : rien n’a été décompté, réessaie après Retry-After (60 s)."],
  ["runner_unavailable", "503", "Enclave injoignable : l’appel a pu être décompté, ne le renvoie pas aveuglément."],
  ["runner_error", "502", "Réponse de l’enclave invalide ou en erreur : réessaie plus tard."],
];

const SDKS = ["JavaScript", "Python", "curl"] as const;
type Sdk = (typeof SDKS)[number];

export default function ApiDocsPage() {
  const { locale } = useLocale();
  const d = (value: string) => locale === "en" ? API_EN[value] ?? value : value;
  const [sdk, setSdk] = useState<Sdk>("JavaScript");
  const copy = d("Copier");
  const copied = d("Copié");

  return (
    <DocsShell
      title={d("API développeurs")}
      lead={<p>{d("Appelle depuis ton code le modèle que tu loues sur Sirius. Le modèle reste scellé dans l’enclave ; chaque réponse est signée par elle. Les requêtes sont signées avec ta clé : ni Sirius ni le serveur web ne peuvent appeler à ta place.")}</p>}
      actions={(
        <>
          <a href="#authentification" className={HERO_PRIMARY}>{d("Démarrer")}</a>
          <a href="/openapi/v1.yaml" className={HERO_SECONDARY}>{d("Spécification OpenAPI")}</a>
        </>
      )}
      toc={TOC}
      tocLabel={d}
    >
      <Hint title={d("Où tourne le modèle")}>
        <p>{d("Ton modèle tourne dans une Confidential VM Intel TDX sur Phala Cloud, construite avec dstack. Le site vérifie son attestation RA-TLS à chaque appel, et la clé qui signe les réponses ne sort jamais de l’enclave.")}</p>
        <p className="mt-2">{d("La CVM est allumée à la demande : le premier appel après une pause peut attendre son réveil (voir « Délais et réessais »).")}</p>
      </Hint>

      <DocSection id="authentification" title={d("Authentification")}>
        <p>{d("Quand la page Train suit le règlement de ton emprunt, elle crée une clé par défaut ; sinon, ouvre l’emprunt réglé, puis « Créer une clé API ». La clé complète, sk_live_<keyId>.<secret>, n’est affichée qu’une fois : copie-la dans ton gestionnaire de secrets. Elle est générée dans ton navigateur et son secret est chiffré pour l’enclave ; Sirius ne le conserve pas en clair.")}</p>
        <p>{d("Chaque requête porte quatre en-têtes :")}</p>
        <ul className="ml-5 list-disc space-y-1.5 marker:text-muted">
          <li><code className="font-mono text-xs text-foreground">Sirius-Key</code> : {d("identifiant de la clé (22 caractères), sans le préfixe ni le secret ;")}</li>
          <li><code className="font-mono text-xs text-foreground">Sirius-Timestamp</code> : {d("heure Unix en secondes ;")}</li>
          <li><code className="font-mono text-xs text-foreground">Sirius-Nonce</code> : {d("chaîne aléatoire à usage unique, 16 à 64 caractères base64url ;")}</li>
          <li><code className="font-mono text-xs text-foreground">Sirius-Signature</code> : {d("HMAC-SHA256 en hexadécimal minuscule de la chaîne canonique.")}</li>
        </ul>
        <p>{d("Jusqu’à 5 clés actives par emprunt. Révoque une clé depuis la page Train : elle est refusée aussitôt par l’enclave.")}</p>
      </DocSection>

      <DocSection id="signature" title={d("Signature pas à pas")}>
        <ol className="ml-5 list-decimal space-y-2 marker:text-muted">
          <li>{d("Calcule le SHA-256 du corps brut, octet par octet, en hexadécimal minuscule. Corps vide (GET) : e3b0c442…b855.")}</li>
          <li>{d("Assemble six lignes séparées par \\n, sans saut de ligne final : préfixe, méthode en majuscules, chemin public sans query, horodatage, nonce, empreinte du corps.")}</li>
          <li>{d("Signe cette chaîne en HMAC-SHA256 avec les 32 octets du secret (décodé depuis le base64url), et envoie la signature en hexadécimal minuscule.")}</li>
        </ol>
        <CodeBlock code={CANONICAL} copy={copy} copied={copied} />
        <Hint title={d("Bon à savoir")}>
          <p>{d("Envoie exactement les octets que tu as hachés : un corps reformaté invalide la signature.")}</p>
          <p className="mt-2">{d("Le chemin signé est toujours le chemin public, /v1/models/<loanId>…, même si tu appelles https://sirius-data.tech/api/v1/… : une signature d’un emprunt ou d’une route ne vaut pour aucun autre.")}</p>
        </Hint>
      </DocSection>

      <DocSection id="routes" title={d("Routes")}>
        <div className="overflow-hidden rounded-[1.25rem] border border-white/10 bg-surface/50 backdrop-blur-xl">
          {[
            ["GET /v1/models/{loanId}", d("Profil du modèle, variables attendues, fin de location et appels restants. Ne consomme pas de quota.")],
            ["POST /v1/models/{loanId}/predict", d("Prédiction signée par l’enclave. Corps : {\"features\": {…}} avec exactement les variables du modèle, en nombres finis (16 Kio au plus). Consomme un appel.")],
          ].map(([route, effect]) => (
            <div key={route} className="border-b border-border/60 px-4 py-3 last:border-b-0 sm:grid sm:grid-cols-[17rem_1fr] sm:gap-4">
              <code className="font-mono text-xs text-foreground">{route}</code>
              <p className="mt-1 text-sm sm:mt-0">{effect}</p>
            </div>
          ))}
        </div>
        <p>{d("Réponse de prédiction :")}</p>
        <CodeBlock code={RESPONSE_EXAMPLE} copy={copy} copied={copied} />
      </DocSection>

      <DocSection id="erreurs" title={d("Codes d’erreur")}>
        <p>{d("Les erreurs ont la forme {\"error\": {\"code\", \"message\"}}. Le code est stable ; le message peut changer.")}</p>
        <div className="overflow-hidden rounded-[1.25rem] border border-white/10 bg-surface/50 backdrop-blur-xl">
          <div className="hidden grid-cols-[16rem_4rem_1fr] gap-4 border-b border-border bg-surface/70 px-4 py-2.5 text-xs font-medium text-muted sm:grid">
            <span>{d("Code")}</span>
            <span>{d("Statut")}</span>
            <span>{d("Signification")}</span>
          </div>
          {ERRORS.map(([code, status, meaning]) => (
            <div key={code} className="border-b border-border/60 px-4 py-3 last:border-b-0 sm:grid sm:grid-cols-[16rem_4rem_1fr] sm:gap-4">
              <code className="font-mono text-xs text-foreground">{code}</code>
              <span className="font-mono text-xs text-muted">{status}</span>
              <p className="mt-1 text-sm sm:mt-0">{d(meaning)}</p>
            </div>
          ))}
        </div>
      </DocSection>

      <DocSection id="reessais" title={d("Délais et réessais")}>
        <p>{d("Pour réduire ses coûts, Sirius n’allume la machine confidentielle que lorsqu’elle sert : elle s’arrête environ une heure après la dernière activité (appel API, prédiction ou paiement sur le site). Le premier appel après une pause la redémarre et peut prendre environ 2 minutes : il reçoit 503 enclave_starting avec Retry-After, et les SDK réessaient seuls. Une clé inconnue ou révoquée, ou une location échue, ne la démarre jamais.")}</p>
        <p>{d("Pendant un démarrage (environ 2 minutes, jusqu’à 5 exceptionnellement), l’API répond 503 avec le code enclave_starting et un en-tête Retry-After en secondes. Attends ce délai, puis renvoie la requête avec un nouvel horodatage, un nouveau nonce et une nouvelle signature : rien n’a été décompté.")}</p>
        <p>{d("Les SDK le font pour toi, jusqu’à un délai maximal réglable (8 minutes par défaut), ainsi que pour 503 runner_busy, avec un recul exponentiel et une gigue, et pour 503 controller_unavailable (gestion de l’enclave momentanément indisponible, Retry-After de 60 s). Ils ne renvoient jamais seuls un autre 503 (runner_unavailable) ni un appel resté sans réponse : l’enclave a pu le décompter. Prévois un délai client supérieur à 60 s, l’attente maximale de l’API envers l’enclave.")}</p>
      </DocSection>

      <DocSection id="acces" title={d("Accès payé au jour")}>
        <p>{d("L’API est payée au jour et incluse dans toute location : le devis d’emprunt ajoute jours loués × prix journalier de l’API du tarif en vigueur aux frais de calcul, sur une ligne à part. Un seul devis, un seul paiement, remboursé avec le reste si l’entraînement échoue (hors frais d’exécution mesurés). Sans prix journalier dans le tarif, aucune location n’est possible.")}</p>
        <p>{d("L’accès couvre la location jusqu’à sa fin, et une prolongation l’inclut d’office pour les jours ajoutés. Sans accès payé couvrant l’instant présent, l’API répond 403 api_access_required et aucune clé ne peut être créée.")}</p>
        <p>{d("Locations ouvertes avant le 8 novembre 2026 sans API : sur la page Entraîner, un pass journalier payé à Sirius au prix par jour du tarif en vigueur (plus 0,001 USDC au fournisseur : le contrat refuse une part fournisseur nulle) couvre la location jusqu’à sa fin ; après une prolongation non couverte, un pass complémentaire paie les jours ajoutés. Le devis signé affiche le nombre de jours et le total avant tout paiement.")}</p>
        <p>{d("Les prédictions depuis le site restent incluses. Le quota du jour et les packs s’appliquent en plus de l’accès API.")}</p>
      </DocSection>

      <DocSection id="quotas" title={d("Quotas et packs")}>
        <p>{d("Chaque emprunt inclut un quota d’appels par jour (jour UTC), commun au site et à l’API : 50 pour la régression logistique, 100 pour les arbres boostés (valeurs de la politique de facturation en vigueur).")}</p>
        <p>{d("Au-delà, achète des packs de 100, 1 000 ou 10 000 appels depuis la page Train. Ils sont cumulables, consommés après le quota du jour, expirent avec la location et ne sont pas remboursables.")}</p>
        <p>{d("Prix d’un appel = prix par jour du dataset ÷ quota du jour, arrondi au supérieur ; un pack coûte sa taille × ce prix, plus les frais de calcul de Sirius à prix coûtant. Le devis signé affiche le total avant tout paiement.")}</p>
        <p>{d("Chaque réponse donne remaining.today et remaining.credits : c’est le compteur qui fait foi.")}</p>
      </DocSection>

      <DocSection id="limites" title={d("Limites")}>
        <ul className="ml-5 list-disc space-y-1.5 marker:text-muted">
          <li>{d("Pas de probabilité : la sortie est une décision 0/1 ou une valeur arrondie, signée.")}</li>
          <li>{isModelOffered("linear_regression")
            ? d("La régression linéaire n’a pas d’API : quelques appels suffiraient à reconstruire le modèle. Ses prêts restent interrogeables depuis le site.")
            : d("La régression linéaire n’est plus proposée pour de nouveaux datasets. Même réactivée, elle n’aurait pas d’API : quelques appels suffiraient à reconstruire le modèle. Les prêts linéaires existants restent interrogeables depuis le site.")}</li>
          <li>{d("Le nombre d’appels par jour borne ce qu’un emprunteur peut apprendre du modèle.")}</li>
          <li>{d("Le serveur web de Sirius relaie la requête et voit donc les variables envoyées ; il ne peut pas fabriquer d’appel, faute du secret.")}</li>
          <li>{d("L’enclave peut être en cours de démarrage : prévois les réessais (503 + Retry-After).")}</li>
        </ul>
      </DocSection>

      <DocSection id="sdk" title={d("SDK")}>
        <p>
          {d("Deux SDK d’un seul fichier, sans dépendance : ils signent, réessaient seuls sur 503 enclave_starting, runner_busy et controller_unavailable (rien n’a été décompté) et renvoient des erreurs typées par code ; une autre erreur, réseau comprise, remonte sans réessai.")}{" "}
          <code className="font-mono text-xs text-foreground">sdk/js/sirius-api.ts</code> · <code className="font-mono text-xs text-foreground">sdk/python/sirius_api.py</code>
        </p>
        <div role="tablist" aria-label={d("SDK")} className="flex gap-5 overflow-x-auto border-b border-border [scrollbar-width:none]">
          {SDKS.map((name) => (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={sdk === name}
              onClick={() => setSdk(name)}
              className={`-mb-px whitespace-nowrap border-b-2 pb-2.5 text-sm font-medium transition-colors ${
                sdk === name ? "border-foreground text-foreground" : "border-transparent text-muted hover:text-foreground"
              }`}
            >
              {name}
            </button>
          ))}
        </div>
        <div role="tabpanel" className="space-y-3">
          {sdk === "JavaScript" && <CodeBlock code={JS_EXAMPLE} copy={copy} copied={copied} />}
          {sdk === "Python" && <CodeBlock code={PY_EXAMPLE} copy={copy} copied={copied} />}
          {sdk === "curl" && (
            <>
              <p>{d("Signature à la main (curl et openssl) :")}</p>
              <CodeBlock code={CURL_EXAMPLE} copy={copy} copied={copied} />
            </>
          )}
        </div>
        <p>
          {d("Spécification complète :")}{" "}
          <a href="/openapi/v1.yaml" className="font-medium text-foreground underline underline-offset-2">/openapi/v1.yaml</a>
          {" · "}
          <Link href="/docs" className="font-medium text-foreground underline underline-offset-2">{d("Comment fonctionne Sirius")}</Link>
        </p>
      </DocSection>
    </DocsShell>
  );
}
