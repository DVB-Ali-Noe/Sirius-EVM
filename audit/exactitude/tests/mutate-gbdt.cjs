// Mutation à la volée, sans toucher au fichier source : quand src/lib/models/gbdt.ts est lu, une constante du
// profil est remplacée (par défaut `GBDT_TREES = 150` → `GBDT_TREES = 149`). Sert à montrer que
// profile-version.test.ts échoue bien si une constante change sans nouvelle version :
//   NODE_OPTIONS="--conditions=react-server" node --require ./audit/exactitude/tests/mutate-gbdt.cjs --import tsx --test audit/exactitude/tests/profile-version.test.ts
// MUTATE_FROM / MUTATE_TO choisissent une autre mutation ; MUTATE_FILE (ex. `tee/train-gbdt.ts`) un autre fichier de src/lib.
const fs = require("node:fs");
const from = process.env.MUTATE_FROM || "GBDT_TREES = 150";
const to = process.env.MUTATE_TO || "GBDT_TREES = 149";
const suffix = `/src/lib/${process.env.MUTATE_FILE || "models/gbdt.ts"}`;
const target = { test: (name) => name.replace(/\\/g, "/").endsWith(suffix) };
const read = fs.readFileSync;
fs.readFileSync = function (path, options) {
  const result = read.apply(this, arguments);
  const name = typeof path === "string" ? path : path instanceof URL ? path.pathname : String(path);
  if (!target.test(name)) return result;
  const text = typeof result === "string" ? result : result.toString("utf8");
  if (!text.includes(from)) throw new Error(`mutation introuvable : ${from}`);
  const mutated = text.replace(from, to);
  return typeof result === "string" ? mutated : Buffer.from(mutated);
};
