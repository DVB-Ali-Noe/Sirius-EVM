import Link from "next/link";
import { Page, PageHeader } from "@/components/layout/Page";
import { Card } from "@/components/ui/Card";
import { SectionTitle } from "@/components/ui/Heading";

/**
 * Lecture humaine de l'attestation du runner Phala de démonstration. Composant sans état :
 * il ne reçoit que des empreintes publiques, jamais de secret. Textes anglais écrits
 * directement, comme `/phala` côté serveur et le certificat d'exécution.
 */

export interface AttestationViewProps {
  checkedAt: string;
  mrtd: string | null;
  composeHash: string;
  certificateSha256: string;
  ingressKeySha256: string;
  masterKeyChainSha256: string;
  settlementAddress: string;
  quoteBytes: number;
}

const CHECKS = [
  {
    label: "Genuine Intel TDX hardware",
    detail: "The quote signature was checked against Intel's collateral, with an up-to-date platform (TCB status UpToDate).",
  },
  {
    label: "Secure channel bound to the enclave",
    detail: "The quote carries the SHA-256 of the TLS certificate the runner presented: this server talks to that enclave, not to an intermediary.",
  },
  {
    label: "Expected Sirius code",
    detail: "MRTD and compose hash equal the values Sirius pins for this release, and the event log replays to the RTMR3 of the quote.",
  },
  {
    label: "Enclave keys",
    detail: "The key chain derived by the Phala KMS, the dataset ingestion key and the settlement account are the ones Sirius expects.",
  },
] as const;

function Row({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="flex flex-col gap-1 border-b border-border py-3 last:border-b-0 sm:flex-row sm:items-baseline sm:gap-6">
      <dt className="shrink-0 text-xs uppercase tracking-wider text-muted sm:w-48">{label}</dt>
      <dd className="min-w-0 text-sm">
        <span className="block font-mono wrap-anywhere">{children}</span>
        {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
      </dd>
    </div>
  );
}

function formatDate(value: string): string {
  return `${value.slice(0, 16).replace("T", " ")} UTC`;
}

export function AttestationView(props: AttestationViewProps) {
  return (
    <Page width="narrow">
      <PageHeader
        back={{ href: "/phala", label: "Back to training" }}
        eyebrow="Phala · runner attestation"
        title="Running inside an Intel TDX enclave"
        description="Before sending any dataset or training request, this server checks the hardware attestation of the Sirius runner on Phala Cloud. Every check below passed."
      />

      <Card className="flex flex-col gap-2 border-positive/40 bg-positive/5" data-verdict="verified">
        <p className="flex items-center gap-2 font-medium text-positive">
          <span aria-hidden className="inline-block size-2 rounded-full bg-positive" /> Attestation verified
        </p>
        <p className="text-sm text-muted">
          Last checked {formatDate(props.checkedAt)}. The check is renewed at least every five minutes while the demo is open.
        </p>
      </Card>

      <section className="flex flex-col gap-3" aria-labelledby="attestation-plain">
        <SectionTitle id="attestation-plain">In plain words</SectionTitle>
        <Card>
          <ul className="flex list-disc flex-col gap-2 pl-5 text-sm">
            <li>Your CSV is encrypted in your browser for a key that only exists inside this enclave.</li>
            <li>The training runs on a sealed Intel TDX machine on Phala Cloud. Your data is only decrypted inside it.</li>
            <li>You receive the trained model, encrypted for your browser. The measurements below let anyone check which code ran.</li>
          </ul>
        </Card>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="attestation-checks">
        <SectionTitle id="attestation-checks">Checks</SectionTitle>
        <Card className="py-1">
          <ul>
            {CHECKS.map((check) => (
              <li key={check.label} className="flex flex-col gap-1 border-b border-border py-3 last:border-b-0" data-check-state="pass">
                <p className="flex items-baseline justify-between gap-4 text-sm">
                  <span className="font-medium">{check.label}</span>
                  <span className="text-xs uppercase tracking-wider text-positive">Passed</span>
                </p>
                <p className="text-sm text-muted">{check.detail}</p>
              </li>
            ))}
          </ul>
        </Card>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="attestation-measurements">
        <SectionTitle id="attestation-measurements">Enclave measurements</SectionTitle>
        <Card className="py-1">
          <dl>
            {props.mrtd && <Row label="MRTD" hint="Base image of the virtual machine.">{props.mrtd}</Row>}
            <Row label="Compose hash" hint="Exact containers and configuration started in the enclave.">{props.composeHash}</Row>
            <Row label="TLS certificate (SHA-256)" hint="Bound to the quote: the secure channel ends inside the enclave.">{props.certificateSha256}</Row>
            <Row label="Ingestion key (SHA-256)" hint="Public key your browser encrypts the CSV for.">{props.ingressKeySha256}</Row>
            <Row label="KMS key chain (SHA-256)" hint="Keys derived by the Phala KMS for this application.">{props.masterKeyChainSha256}</Row>
            <Row label="Settlement account" hint="Signing address held by the enclave.">{props.settlementAddress}</Row>
          </dl>
        </Card>
      </section>

      <Card className="flex flex-col items-start gap-3">
        <p className="text-sm text-muted">
          To check it without trusting Sirius, download the raw attestation ({Math.round(props.quoteBytes / 1024)} KB quote and event
          log) and verify the quote with Intel DCAP tooling.
        </p>
        <a href="/api/phala-demo/attestation" download className="rounded-xl border border-border px-4 py-2 text-sm transition-colors hover:bg-surface">
          Download raw attestation (JSON)
        </a>
      </Card>
    </Page>
  );
}

export function AttestationUnavailable() {
  return (
    <Page width="narrow">
      <PageHeader
        back={{ href: "/phala", label: "Back to training" }}
        eyebrow="Phala · runner attestation"
        title="Attestation not available right now"
        description="The enclave only runs while the demo is open: between sessions the machine is powered off, so there is nothing to attest."
      />
      <Card className="flex flex-col items-start gap-3">
        <p className="text-sm text-muted">Come back during a demo session, or try again in a minute if one has just opened.</p>
        <Link href="/phala" className="rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-background transition-colors hover:bg-accent/90">
          Go to Phala training
        </Link>
      </Card>
    </Page>
  );
}
