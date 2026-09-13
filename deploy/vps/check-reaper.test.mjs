import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("./check-reaper.sh", import.meta.url));

function check(state, missing = false) {
  const directory = mkdtempSync(join(tmpdir(), "sirius-reaper-check-"));
  try {
    const bin = join(directory, "bin");
    mkdirSync(bin);
    writeFileSync(join(directory, ".env.vps"), "DATABASE_URL=SECRET_SYNTHETIQUE\n");
    writeFileSync(join(bin, "docker"), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.REAPER_TEST_CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'inspect') console.log(process.env.REAPER_TEST_STATE);
else if (args.includes('logs')) console.log('[reaper] arrêt : contrats incompatibles');
else if (args.includes('--quiet')) {
  if (process.env.REAPER_TEST_MISSING !== 'true') console.log('container-staging');
} else if (args.includes('ps')) console.log('sirius-staging-reaper-1');
else process.exit(2);
`, { mode: 0o700 });
    const callsFile = join(directory, "calls.jsonl");
    const result = spawnSync("bash", [script, directory, "sirius-staging"], {
      encoding: "utf8",
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, REAPER_TEST_STATE: state,
        REAPER_TEST_MISSING: String(missing), REAPER_TEST_CALLS: callsFile },
    });
    const calls = readFileSync(callsFile, "utf8").trim().split("\n").map(JSON.parse);
    assert.ok(!result.stdout.includes("SECRET_SYNTHETIQUE"));
    for (const call of calls.filter((args) => args[0] === "compose")) {
      assert.deepEqual(call.slice(0, 5), ["compose", "-p", "sirius-staging", "--env-file", ".env.vps"]);
      assert.equal(call.at(-1), "reaper");
    }
    return { ...result, calls };
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

test("le contrôle VPS accepte le processus running de staging", () => {
  const result = check("running 0 false 0");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /statut=running/);
  assert.ok(!result.calls.some((args) => args.includes("logs")));
});

test("le contrôle VPS explique un redémarrage et affiche les logs du seul reaper", () => {
  const result = check("restarting 1 true 3");
  assert.equal(result.status, 1);
  assert.match(result.stdout, /mémoire_dépassée=true redémarrages=3/);
  assert.match(result.stdout, /arrêt : contrats incompatibles/);
  assert.match(result.stdout, /::error::Le reaper ne tourne pas/);
});

test("le contrôle VPS refuse un conteneur absent", () => {
  const result = check("", true);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Aucun conteneur reaper/);
  assert.ok(!result.calls.some((args) => args[0] === "inspect"));
});
