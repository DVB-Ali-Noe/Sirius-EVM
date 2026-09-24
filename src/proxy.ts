import { NextResponse, type NextRequest } from "next/server";

/**
 * Origines du portefeuille embarqué, ajoutées seulement là où il est proposé.
 *
 * Le SDK appelle son API de configuration, le réseau de nœuds qui détiennent les parts de
 * clé, et un service de métadonnées. Ces appels partent du navigateur : sans eux dans
 * `connect-src`, notre propre politique les bloque et l'initialisation échoue sur un
 * « Failed to fetch » qui n'accuse personne.
 *
 * Le joker est scopé à un seul domaine, celui du fournisseur auquel on confie déjà la clé.
 * L'énumération nœud par nœud serait plus étroite d'un cheveu et casserait le jour où ils
 * en ajoutent un.
 *
 * L'authentification passe par des iframes servies depuis ce même domaine — `auth.` et
 * `wallet.` — d'où l'ouverture de `frame-src`. Sans elle le connecteur reste « not ready »
 * et la connexion attend indéfiniment, sans erreur.
 *
 * `cdn.segment.com` reste fermé délibérément : le SDK y envoie de la télémétrie, et un
 * produit bâti sur la confidentialité n'expédie pas les gestes de ses utilisateurs chez un
 * tiers. L'option `disableAnalytics` coupe l'appel à la source.
 *
 * Conditionné au Client ID : une instance qui ne propose pas la connexion sociale garde sa
 * politique d'origine, sans élargissement pour une fonctionnalité qu'elle n'expose pas.
 */
const ORIGINES_EMBARQUEES = process.env.NEXT_PUBLIC_WEB3AUTH_CLIENT_ID?.trim()
  ? " https://*.web3auth.io https://metadata.tor.us"
  : "";

function contentSecurityPolicy(nonce: string): string {
  const development = process.env.NODE_ENV !== "production";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ""}`,
    "script-src-attr 'none'",
    `style-src 'self' 'unsafe-inline'${ORIGINES_EMBARQUEES ? " https://fonts.googleapis.com" : ""}`,
    `img-src 'self' data: blob:${ORIGINES_EMBARQUEES ? " https://*.web3auth.io https://images.toruswallet.io" : ""}`,
    `font-src 'self' data:${ORIGINES_EMBARQUEES ? " https://fonts.gstatic.com" : ""}`,
    `connect-src 'self' https://rpc.mainnet.chain.robinhood.com https://rpc.testnet.chain.robinhood.com https://robinhoodchain.blockscout.com https://explorer.testnet.chain.robinhood.com https://buy.moonpay.com https://buy-sandbox.moonpay.com${ORIGINES_EMBARQUEES}`,
    `frame-src ${ORIGINES_EMBARQUEES ? "https://*.web3auth.io" : "'none'"}`,
    "worker-src 'self' blob:",
    "media-src 'none'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
    ...(development ? [] : ["upgrade-insecure-requests"]),
  ].join("; ");
}

export function proxy(request: NextRequest) {
  const nonce = Buffer.from(crypto.randomUUID()).toString("base64");
  const policy = contentSecurityPolicy(nonce);
  const headers = new Headers(request.headers);
  headers.set("Content-Security-Policy", policy);
  headers.set("x-nonce", nonce);

  const response = NextResponse.next({ request: { headers } });
  response.headers.set("Content-Security-Policy", policy);
  return response;
}

export const config = {
  matcher: [
    {
      source: "/((?!api|_next/static|_next/image|favicon.ico).*)",
      missing: [
        { type: "header", key: "next-router-prefetch" },
        { type: "header", key: "purpose", value: "prefetch" },
      ],
    },
  ],
};
