import { keccak256, stringToBytes, type Hex } from "viem";

const MAX_DATASET_ID_BYTES = 128;
const MAX_CID_BYTES = 128;

function hash(value: string, maximum: number, field: string): Hex {
  const bytes = stringToBytes(value);
  if (bytes.length === 0 || bytes.length > maximum) throw new Error(`${field} invalide`);
  return keccak256(bytes);
}

export function datasetIdHash(datasetId: string): Hex {
  return hash(datasetId, MAX_DATASET_ID_BYTES, "Identifiant dataset");
}

export function cidHash(cid: string): Hex {
  return hash(cid, MAX_CID_BYTES, "CID");
}
