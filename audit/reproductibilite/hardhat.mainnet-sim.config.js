// Audit REP-B : nœud Hardhat LOCAL qui annonce le chainId de Robinhood mainnet (4663).
// Sert uniquement à exécuter contracts/scripts/deploy.ts tel quel, sans réseau réel, avec les
// comptes jetables de Hardhat. Aucune compilation : les artefacts viennent de `pnpm contracts:compile`.
module.exports = {
  solidity: "0.8.24",
  networks: { hardhat: { chainId: 4663, hardfork: "merge" } },
};
