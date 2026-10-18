/**
 * Rendu HTML statique de `/phala/attestation`, pour `attestation-view.test.ts`. Processus à part,
 * sans la condition `react-server`, comme `certificate-view.render.tsx`.
 *
 * Sortie : un objet JSON { nom du cas: HTML } sur la sortie standard.
 */
import { renderToStaticMarkup } from "react-dom/server";
import {
  AttestationBusy,
  AttestationUnavailable,
  AttestationView,
  type AttestationViewProps,
} from "@/components/phala-demo/AttestationView";

const IMAGE = `ghcr.io/dvb-ali-noe/sirius-runner@sha256:${"78".repeat(32)}`;

const base: AttestationViewProps = {
  checkedAt: "2026-10-18T15:40:12.000Z",
  quoteBytes: 5006,
  mrTd: "f0".repeat(48),
  composeHash: "61".repeat(32),
  release: { status: "declared", image: IMAGE, commit: "712fbb2" },
  certificateSha256: "ce".repeat(32),
  ingressKeySha256: "c0".repeat(32),
  masterKeyChainSha256: "19".repeat(32),
  settlementAddress: `0x${"3b".repeat(20)}`,
};

const cases: Record<string, React.ReactElement> = {
  declared: <AttestationView {...base} />,
  proven: <AttestationView {...base} release={{ status: "proven", image: IMAGE, commit: "712fbb2" }} />,
  provenWithoutCommit: <AttestationView {...base} release={{ status: "proven", image: IMAGE, commit: null }} />,
  unlisted: <AttestationView {...base} release={{ status: "unlisted" }} />,
  unavailable: <AttestationUnavailable />,
  busy: <AttestationBusy />,
};

process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(cases).map(([name, node]) => [name, renderToStaticMarkup(node)]))));
