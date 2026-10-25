// Nœud Hardhat LOCAL qui annonce le chainId de Robinhood (mainnet 4663 ou testnet 46630), pour
// exécuter contracts/scripts/deploy.ts tel quel dans les tests (contracts/test/deploy-script.test.ts),
// sans réseau réel et avec les seuls comptes jetables de Hardhat. Pas de compilation ici : les
// artefacts viennent de `hardhat compile` (lancé par `hardhat test`).
const chainId = Number(process.env.SIRIUS_SIM_CHAIN_ID);
if (chainId !== 4663 && chainId !== 46630) {
  throw new Error("SIRIUS_SIM_CHAIN_ID doit valoir 4663 ou 46630");
}

module.exports = {
  solidity: "0.8.24",
  networks: { hardhat: { chainId, hardfork: "merge" } },
};
