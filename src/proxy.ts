import { NextResponse, type NextRequest } from "next/server";

function contentSecurityPolicy(nonce: string): string {
  const development = process.env.NODE_ENV !== "production";
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic' https://*.web3auth.io https://*.tor.us${development ? " 'unsafe-eval'" : ""}`,
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https://xrpl.org https://*.web3auth.io https://*.tor.us",
    "font-src 'self' data:",
    "connect-src 'self' https://xrplcluster.com wss://xrplcluster.com https://s.altnet.rippletest.net:51234 wss://s.altnet.rippletest.net:51233 https://s.devnet.rippletest.net:51234 wss://s.devnet.rippletest.net:51233 https://*.web3auth.io wss://*.web3auth.io https://*.tor.us wss://*.tor.us https://*.walletconnect.com wss://*.walletconnect.com https://*.walletconnect.org wss://*.walletconnect.org https://buy.moonpay.com https://buy-sandbox.moonpay.com",
    "frame-src https://*.web3auth.io https://*.tor.us",
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
