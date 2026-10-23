// Abaisse le plancher du profil à 2 000 lignes au chargement (sans toucher au fichier) pour vérifier
// l'affirmation de gbdt.ts « sous 10 000 lignes, les arbres font moins bien que la logistique » :
//   NODE_OPTIONS="--conditions=react-server" node --require ./audit/exactitude/tests/mutate-min-rows.cjs --import tsx audit/exactitude/sirius-run.ts <csv> <sortie.json> [test.csv]
process.env.MUTATE_FROM = "GBDT_MIN_ROWS = 10_000";
process.env.MUTATE_TO = "GBDT_MIN_ROWS = 2_000";
require("./mutate-gbdt.cjs");
