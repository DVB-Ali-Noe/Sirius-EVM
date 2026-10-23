// Mutation d'algorithme à constantes égales dans train-gbdt.ts (une coupe presque aussi bonne remplace la meilleure) :
//   NODE_OPTIONS="--conditions=react-server" node --require ./audit/exactitude/tests/mutate-train-gbdt.cjs --import tsx --test audit/exactitude/tests/profile-version.test.ts
process.env.MUTATE_FILE = "tee/train-gbdt.ts";
process.env.MUTATE_FROM = "if (gain > bestGain)";
process.env.MUTATE_TO = "if (gain > bestGain || (best !== null && gain > bestGain * 0.999))";
require("./mutate-gbdt.cjs");
