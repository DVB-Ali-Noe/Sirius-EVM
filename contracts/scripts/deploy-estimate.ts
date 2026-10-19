import { encodeDeployData, type Abi, type Address, type Hex } from "viem";

/** Majoration des appels après déploiement : ~48 000 (`bindEscrow`) et ~46 000 (`addTrainingProfile`) mesurés sur Hardhat. */
export const BIND_ESCROW_GAS = 60_000n;
export const ADD_PROFILE_GAS = 60_000n;

const registryKybAbi = [{ type: "function", name: "kyb", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;

export interface EstimateClient {
  estimateGas(args: { account: Address; data: Hex }): Promise<bigint>;
  readContract(args: { address: Address; abi: typeof registryKybAbi; functionName: "kyb" }): Promise<Address>;
}

export interface DeploymentEstimateInput {
  account: Address;
  artifact: (name: string) => { abi: Abi; bytecode: Hex };
  /** KYB à déployer (nom et arguments) ou adresse d'un KYB réutilisé. */
  kyb: { deploy: string; args: unknown[] } | { existing: Address };
  /**
   * Registre de datasets déjà déployé servant de référence à l'estimation de l'escrow : son
   * constructeur refuse (`InvalidRegistry`) un registre sans code ou dont `kyb()` diffère, et le
   * nouveau registre n'existe pas encore. Code et écritures identiques : même coût.
   */
  referenceDatasets: Address;
  escrowContract: string;
  usdc: Address;
  lockAuthorizer: Address;
  addedProfiles: readonly string[];
}

/** Estimations `eth_estimateGas`, sans signature ni transaction, dans l'ordre du déploiement. */
export async function estimateDeploymentGas(client: EstimateClient, input: DeploymentEstimateInput): Promise<[string, bigint][]> {
  const deployGas = (name: string, args: unknown[]) =>
    client.estimateGas({ account: input.account, data: encodeDeployData({ ...input.artifact(name), args } as never) });
  const estimates: [string, bigint][] = [];
  if ("deploy" in input.kyb) estimates.push([input.kyb.deploy, await deployGas(input.kyb.deploy, input.kyb.args)]);
  // Le constructeur du registre ne refuse que l'adresse nulle : le déployeur tient lieu de KYB à venir.
  const registryKyb = "existing" in input.kyb ? input.kyb.existing : input.account;
  estimates.push(["SiriusDatasetRegistry", await deployGas("SiriusDatasetRegistry", [registryKyb, input.account])]);
  let referenceKyb: Address;
  try {
    referenceKyb = await client.readContract({ address: input.referenceDatasets, abi: registryKybAbi, functionName: "kyb" });
  } catch {
    throw new Error("SIRIUS_DEPLOY_ESTIMATE_DATASETS doit désigner un registre de datasets déjà déployé sur ce réseau");
  }
  estimates.push([input.escrowContract,
    await deployGas(input.escrowContract, [input.usdc, referenceKyb, input.referenceDatasets, input.lockAuthorizer])]);
  estimates.push(["bindEscrow", BIND_ESCROW_GAS]);
  for (const id of input.addedProfiles) estimates.push([`addTrainingProfile(${id})`, ADD_PROFILE_GAS]);
  return estimates;
}
