import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

/**
 * Garde-fous du build reproductible de l'image runner (audit REP-01, REP-02). Ils ne prouvent pas
 * la reproductibilité (voir scripts/operations/rebuild-runner.sh) mais empêchent de la perdre sans
 * le voir : base flottante, état pnpm horodaté, attestation horodatée dans le digest publié.
 */
const ROOT = resolve(__dirname, "..");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8").replaceAll("\r\n", "\n");

test("REP-01 : chaque FROM du runner et du worker est épinglé par digest, sur la même base", () => {
  const digests = new Set<string>();
  for (const file of ["Dockerfile.runner", "Dockerfile.worker"]) {
    const froms = read(file).split("\n").filter((line) => line.startsWith("FROM "));
    assert.ok(froms.length > 0, file);
    for (const line of froms) {
      const match = /^FROM node:22-bookworm-slim@(sha256:[0-9a-f]{64}) AS [a-z-]+$/.exec(line);
      assert.ok(match, `${file} : ${line}`);
      digests.add(match[1]);
    }
  }
  assert.equal(digests.size, 1, "runner et worker doivent partager le même digest de base");
});

test("REP-02 : l'état horodaté de pnpm est supprimé dans l'image runner", () => {
  assert.match(read("Dockerfile.runner"),
    /pnpm install --prod --frozen-lockfile --ignore-scripts \\\n\s+&& rm -f node_modules\/\.modules\.yaml node_modules\/\.pnpm-workspace-state-v1\.json\n/);
});

test("REP-02 : le CI construit le runner avec des dates figées et sans attestation dans le digest", () => {
  const pipeline = read(".github/workflows/pipeline.yml");
  const step = pipeline.slice(pipeline.indexOf("- name: Runner confidentiel"), pipeline.indexOf("- name: Rappeler le digest du runner"));
  assert.match(step, /SOURCE_DATE_EPOCH: \$\{\{ steps\.epoch\.outputs\.value \}\}/);
  assert.match(step, /provenance: false/);
  assert.match(step, /sbom: false/);
  assert.match(step, /outputs: type=image,push=true,oci-mediatypes=true,rewrite-timestamp=true/);
  assert.doesNotMatch(step, /^\s+push: true$/m);
  assert.match(pipeline, /git log -1 --format=%ct/);
});
