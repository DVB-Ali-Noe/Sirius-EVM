import Link from "next/link";
import { Page, PageHeader } from "@/components/layout/Page";
import { Card } from "@/components/ui/Card";
import { SectionTitle } from "@/components/ui/Heading";

/**
 * Chaîne de confiance du runner Phala de démonstration. Composant sans état : il ne reçoit que
 * des empreintes publiques, jamais de secret. Chaque phrase correspond à un contrôle de
 * `attestTransport` (`src/lib/tee/ra-tls-client.ts`) ou est marquée comme déclaration. Textes
 * anglais écrits directement, comme le certificat d'exécution.
 */

export type ReleaseView =
  | { status: "proven"; image: string; commit: string | null }
  | { status: "declared"; image: string; commit: string }
  | { status: "unlisted" };

export interface AttestationViewProps {
  checkedAt: string;
  quoteBytes: number;
  mrTd: string;
  composeHash: string;
  release: ReleaseView;
  certificateSha256: string;
  ingressKeySha256: string;
  masterKeyChainSha256: string;
  settlementAddress: string;
}

type LinkState = "verified" | "declared" | "unlisted";

const STATE: Record<LinkState, { label: string; className: string }> = {
  verified: { label: "Verified", className: "border-positive/40 text-positive" },
  declared: { label: "Declared", className: "border-border text-muted" },
  unlisted: { label: "Not listed", className: "border-border text-muted" },
};

function Badge({ state }: { state: LinkState }) {
  return (
    <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[11px] uppercase tracking-wider ${STATE[state].className}`}>
      {STATE[state].label}
    </span>
  );
}

function Value({ label, state, children, note }: { label: string; state?: LinkState; children: React.ReactNode; note: string }) {
  return (
    <div className="flex flex-col gap-1 border-t border-border pt-3" data-value={label} data-state={state}>
      <p className="flex items-center justify-between gap-3 text-xs uppercase tracking-wider text-muted">
        <span>{label}</span>
        {state && <Badge state={state} />}
      </p>
      <p className="font-mono text-xs wrap-anywhere">{children}</p>
      <p className="text-xs text-muted">{note}</p>
    </div>
  );
}

function ChainLink(props: { index: number; title: string; claim: string; proves: string; children: React.ReactNode; last?: boolean }) {
  return (
    <li className="relative flex gap-3 sm:gap-4" data-link={props.title}>
      <div className="flex flex-col items-center" aria-hidden>
        <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-positive/50 text-xs font-medium text-positive">
          {props.index}
        </span>
        {!props.last && <span className="w-px flex-1 bg-border" />}
      </div>
      <Card className={`flex flex-1 flex-col gap-3 ${props.last ? "" : "mb-4"}`}>
        <div className="flex flex-col gap-1">
          <h3 className="font-medium">{props.title}</h3>
          <p className="text-sm">{props.claim}</p>
          <p className="text-sm text-muted">{props.proves}</p>
        </div>
        {props.children}
      </Card>
    </li>
  );
}

function formatDate(value: string): string {
  return `${value.slice(0, 16).replace("T", " ")} UTC`;
}

const IMAGE_NOTE: Record<ReleaseView["status"], string> = {
  proven: "Proven by the compose hash: the published app-compose.json hashes to the attested value and names this image for the runner service.",
  declared: "Declared by the pipeline for this compose hash, checkable by repository members. Not proven: the published app-compose.json is not available yet.",
  unlisted: "Version not listed: this compose hash is not in the list Sirius publishes, so no image or commit is shown.",
};

function verifyCommands(release: ReleaseView): string {
  const lines = [
    "# 1. Intel signature and TCB (Intel DCAP collateral, via dcap-qvl)",
    "cargo install dcap-qvl-cli",
    "jq -r .evidence.quote sirius-phala-attestation.json > quote.hex",
    "dcap-qvl verify --hex quote.hex | jq '{status, mr_td: (.report[]).mr_td, report_data: (.report[]).report_data}'",
    "# status must be UpToDate, mr_td the MRTD above,",
    "# report_data the TLS certificate SHA-256 followed by 64 zeros:",
    "jq -r .evidence.certificateSha256 sirius-phala-attestation.json",
  ];
  if (release.status === "proven") {
    lines.push(
      "# 2. The published compose must hash to the attested compose hash",
      "jq -j .appCompose sirius-phala-attestation.json | sha256sum",
      "jq -r .evidence.composeHash sirius-phala-attestation.json",
    );
  }
  return lines.join("\n");
}

export function AttestationView(props: AttestationViewProps) {
  const { release } = props;
  const imageState: LinkState = release.status === "proven" ? "verified" : release.status;
  return (
    <Page width="narrow">
      <PageHeader
        back={{ href: "/phala", label: "Back to training" }}
        eyebrow="Phala · runner attestation"
        title="Chain of trust"
        description="Before any dataset or training request reaches the Sirius runner, this server makes every check marked Verified below. If one fails, nothing is sent."
      />

      <Card className="flex flex-col gap-2 border-positive/40 bg-positive/5" data-verdict="verified">
        <p className="flex items-center gap-2 font-medium text-positive">
          <span aria-hidden className="inline-block size-2 rounded-full bg-positive" /> Attestation verified
        </p>
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm" aria-label="Chain summary">
          {["Intel chip", "Machine", "Code", "Connection"].map((name, index) => (
            <span key={name} className="flex items-center gap-2">
              {index > 0 && <span aria-hidden className="text-muted">→</span>}
              <span>
                <span className="text-positive">✓</span> {name}
                {name === "Code" && release.status !== "proven" && (
                  <span className="text-muted"> · image {release.status === "declared" ? "declared" : "not listed"}</span>
                )}
              </span>
            </span>
          ))}
        </p>
        <p className="text-sm text-muted">
          Last real verification: {formatDate(props.checkedAt)}. It stays valid five minutes; the next request after that verifies again.
        </p>
      </Card>

      <section className="flex flex-col gap-3" aria-labelledby="attestation-chain">
        <SectionTitle id="attestation-chain">Chain of trust</SectionTitle>
        <ol className="flex flex-col">
          <ChainLink
            index={1}
            title="Intel chip"
            claim="Quote signature verified, TCB status UpToDate."
            proves="The quote was signed by a genuine Intel TDX processor whose microcode and TDX module are up to date according to Intel. Its signatures chain to Intel's root certificate; the collateral comes from Phala's cache and is itself signed by Intel."
          >
            <Value label="TDX quote" state="verified" note="Any other TCB status than UpToDate is refused.">
              {Math.round(props.quoteBytes / 1024)} KB · TCB UpToDate
            </Value>
          </ChainLink>

          <ChainLink
            index={2}
            title="Machine"
            claim="MRTD read from the quote equals the value Sirius pins."
            proves="The virtual machine started from the expected virtual firmware. The kernel and operating system are measured in RTMR0–2, which this server does not check; the code that runs on top is covered by link 3."
          >
            <Value label="MRTD" state="verified" note="Read from the signed quote.">
              {props.mrTd}
            </Value>
          </ChainLink>

          <ChainLink
            index={3}
            title="Code"
            claim="Compose hash → runner image → source commit."
            proves="The compose hash covers the exact containers and configuration started in the enclave. dstack measures it once at boot; its event log is replayed into the quote's RTMR3."
          >
            <Value label="Compose hash" state="verified" note="Single boot-time event, replayed into RTMR3, equal to the pinned value.">
              {props.composeHash}
            </Value>
            <Value label="Runner image" state={imageState} note={IMAGE_NOTE[release.status]}>
              {release.status === "unlisted" ? "—" : release.image}
            </Value>
            {release.status !== "unlisted" && (
              <Value
                label="Source commit"
                state={release.commit ? "declared" : "unlisted"}
                note={
                  release.commit
                    ? "Declared by the pipeline tag sirius-runner:staging-<commit>, checkable by repository members. The repository is private."
                    : "No commit is declared for this image."
                }
              >
                {release.commit ?? "—"}
              </Value>
            )}
          </ChainLink>

          <ChainLink
            index={4}
            title="Connection"
            claim="The TLS certificate is bound to the quote."
            proves="The quote carries the SHA-256 of the certificate this server connects to, and only that certificate is accepted afterwards: the channel ends inside this enclave, not at a proxy."
            last
          >
            <Value label="TLS certificate (SHA-256)" state="verified" note="Found in the quote's report data.">
              {props.certificateSha256}
            </Value>
            <p className="border-t border-border pt-3 text-xs text-muted">
              The values below are not in the quote. They are announced by the runner over the attested channel and compared with the values
              pinned by Sirius.
            </p>
            <Value label="KMS key chain (SHA-256)" note="Keys derived by the Phala KMS for this application.">
              {props.masterKeyChainSha256}
            </Value>
            <Value label="Ingestion key (SHA-256)" note="Public key your browser encrypts the CSV for.">
              {props.ingressKeySha256}
            </Value>
            <Value label="Settlement signer" note="Also equal to the lock authorizer of the escrow contract on-chain.">
              {props.settlementAddress}
            </Value>
          </ChainLink>
        </ol>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="attestation-scope">
        <SectionTitle id="attestation-scope">What this proves</SectionTitle>
        <div className="grid gap-4 sm:grid-cols-2">
          <Card className="flex flex-col gap-2" data-scope="proves">
            <p className="text-sm font-medium">It proves</p>
            <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted">
              <li>Which code runs, on which kind of hardware.</li>
              <li>Your CSV is encrypted for a key announced by that code, and decrypted only inside the enclave.</li>
              <li>This server talks to that enclave directly.</li>
            </ul>
          </Card>
          <Card className="flex flex-col gap-2" data-scope="does-not-prove">
            <p className="text-sm font-medium">It does not prove</p>
            <ul className="flex list-disc flex-col gap-1.5 pl-5 text-sm text-muted">
              <li>The quality or correctness of the trained model.</li>
              <li>Anything if Intel&apos;s processor or signing keys are compromised: the whole chain rests on Intel.</li>
              <li>That the machine stays on: Phala can shut it down at any time.</li>
              <li>That the image was built from that commit: the link is declared, not proven.</li>
            </ul>
          </Card>
        </div>
      </section>

      <section className="flex flex-col gap-3" aria-labelledby="attestation-verify">
        <SectionTitle id="attestation-verify">Verify it yourself</SectionTitle>
        <Card className="flex min-w-0 flex-col items-start gap-3">
          <p className="text-sm text-muted">
            The checks above are made by this server. To check without trusting Sirius, download the raw proof (quote, event log,
            fingerprints{release.status === "proven" ? ", published app-compose.json" : ""}) and verify the quote with Intel DCAP tooling.
          </p>
          <a href="/api/phala-demo/attestation" download className="rounded-xl border border-border px-4 py-2 text-sm transition-colors hover:bg-surface">
            Download raw attestation (JSON)
          </a>
          <pre className="w-full max-w-full overflow-x-auto rounded-lg border border-border bg-background/60 p-3 text-xs leading-relaxed">
            <code>{verifyCommands(release)}</code>
          </pre>
          <p className="text-xs text-muted">
            The event log is included: replayed, it must give the quote&apos;s RTMR3 with a single compose-hash event.
          </p>
        </Card>
      </section>
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
        description="Either the enclave is powered off between demo sessions, or this server could not verify it. In both cases, no dataset or training request is sent to it."
      />
      <Card className="flex flex-col items-start gap-3" data-verdict="unavailable">
        <p className="text-sm text-muted">Come back during a demo session, or try again in a minute if one has just opened.</p>
        <Link href="/phala" className="rounded-xl bg-accent px-5 py-2.5 text-sm font-medium text-background transition-colors hover:bg-accent/90">
          Go to Phala training
        </Link>
      </Card>
    </Page>
  );
}

export function AttestationBusy() {
  return (
    <Page width="narrow">
      <PageHeader
        back={{ href: "/phala", label: "Back to training" }}
        eyebrow="Phala · runner attestation"
        title="Too many checks right now"
        description="This page is limited to a few views per minute. Try again in a minute."
      />
    </Page>
  );
}
