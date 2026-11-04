import { expect } from "chai";
import hre from "hardhat";
import type { Abi, Address, Hex } from "viem";
import { estimateDeploymentGas, type EstimateClient } from "../scripts/deploy-estimate";

const artifact = (name: string) => {
  const { abi, bytecode } = hre.artifacts.readArtifactSync(name);
  return { abi: abi as Abi, bytecode: bytecode as Hex };
};

describe("estimation du déploiement (simulation de deploy.ts)", () => {
  async function setup() {
    const [deployer, signer] = await hre.viem.getWalletClients();
    const publicClient = await hre.viem.getPublicClient();
    const usdc = await hre.viem.deployContract("MockEscrowToken", [18]);
    const kyb = await hre.viem.deployContract("SiriusOpenKybRegistry", []);
    const reference = await hre.viem.deployContract("SiriusDatasetRegistry", [kyb.address, deployer.account.address, "0x0000000000000000000000000000000000000000"]);
    const input = {
      account: deployer.account.address, artifact, kyb: { existing: kyb.address as Address },
      referenceDatasets: reference.address as Address, escrowContract: "SiriusEscrowV7", usdc: usdc.address as Address,
      lockAuthorizer: signer.account.address, addedProfiles: ["gradient_boosted_trees"],
    };
    return { deployer, publicClient, usdc, kyb, signer, input, client: publicClient as unknown as EstimateClient };
  }

  it("estime l'escrow contre un registre de référence et couvre le gas réellement consommé", async () => {
    const { deployer, publicClient, usdc, kyb, signer, input, client } = await setup();
    const estimates = new Map(await estimateDeploymentGas(client, input));
    expect([...estimates.keys()]).to.deep.equal(["SiriusDatasetRegistry", "SiriusEscrowV7", "bindEscrow", "addTrainingProfile(gradient_boosted_trees)"]);

    // Déploiement réel de la même paire : l'estimation ne doit pas sous-évaluer le coût.
    const registryHash = await deployer.deployContract({ ...artifact("SiriusDatasetRegistry"), args: [kyb.address, deployer.account.address, "0x0000000000000000000000000000000000000000"] });
    const registryReceipt = await publicClient.waitForTransactionReceipt({ hash: registryHash });
    const escrowHash = await deployer.deployContract({ ...artifact("SiriusEscrowV7"), args: [usdc.address, kyb.address, registryReceipt.contractAddress!, signer.account.address] });
    const escrowReceipt = await publicClient.waitForTransactionReceipt({ hash: escrowHash });
    expect(escrowReceipt.status).to.equal("success");
    expect(estimates.get("SiriusEscrowV7")! >= escrowReceipt.gasUsed).to.equal(true);
    expect(estimates.get("SiriusDatasetRegistry")! >= registryReceipt.gasUsed).to.equal(true);
  });

  it("estime aussi un nouveau KYB, et refuse une référence qui n'est pas un registre", async () => {
    const { deployer, input, client } = await setup();
    const fresh = await estimateDeploymentGas(client, { ...input, kyb: { deploy: "SiriusOpenKybRegistry", args: [] } });
    expect(fresh[0][0]).to.equal("SiriusOpenKybRegistry");
    let error: unknown;
    try { await estimateDeploymentGas(client, { ...input, referenceDatasets: deployer.account.address }); } catch (caught) { error = caught; }
    expect(String(error)).to.match(/SIRIUS_DEPLOY_ESTIMATE_DATASETS/);
  });
});
