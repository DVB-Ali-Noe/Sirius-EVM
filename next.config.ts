import type { NextConfig } from "next";

const development = process.env.NODE_ENV !== "production";

const securityHeaders = [
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), usb=()" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  ...(development
    ? []
    : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains; preload" }]),
];

const nextConfig: NextConfig = {
  // Indicateur dev en bas-droite (par défaut bas-gauche : chevauche le logo/bouton de la sidebar).
  devIndicators: { position: "bottom-right" },
  // SDK dstack (socket natif) + dcap-qvl (vérif de quote) → laissés externes (pas de bundling serveur).
  serverExternalPackages: ["@phala/dstack-sdk", "@phala/dcap-qvl"],
  experimental: {
    proxyClientMaxBodySize: "24mb",
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
