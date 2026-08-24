import assert from "node:assert/strict";
import test from "node:test";
import type { MPTokenIssuanceCreate, MPTokenIssuanceDestroy } from "xrpl";
import {
  assertDatasetMptCreateScope,
  assertDatasetMptDestroyScope,
  encodedDatasetMptMetadata,
  type DatasetMptMetadata,
} from "./mpt";

const issuer = "rProvider";
const metadata: DatasetMptMetadata = {
  datasetId: "dataset-1",
  name: "Dataset",
  ipfsCid: "bafy-test",
  merkleRoot: "abc123",
  sizeBytes: 42,
};
const create: MPTokenIssuanceCreate = {
  TransactionType: "MPTokenIssuanceCreate",
  Account: issuer,
  AssetScale: 0,
  MaximumAmount: "1",
  MPTokenMetadata: encodedDatasetMptMetadata(metadata),
  Sequence: 7,
  LastLedgerSequence: 100,
  Fee: "12",
};
const destroy: MPTokenIssuanceDestroy = {
  TransactionType: "MPTokenIssuanceDestroy",
  Account: issuer,
  MPTokenIssuanceID: "0000AABB",
  Sequence: 8,
  LastLedgerSequence: 110,
  Fee: "12",
};

test("le mint MPT client est lié exactement au dataset", () => {
  assert.doesNotThrow(() => assertDatasetMptCreateScope(create, issuer, metadata));
  assert.throws(
    () => assertDatasetMptCreateScope({ ...create, MaximumAmount: "2" }, issuer, metadata),
    /hors scope/,
  );
  assert.throws(
    () => assertDatasetMptCreateScope({ ...create, TransferFee: 100 }, issuer, metadata),
    /hors scope/,
  );
});

test("la destruction MPT client cible uniquement l'émission du provider", () => {
  assert.doesNotThrow(() => assertDatasetMptDestroyScope(destroy, issuer, "0000AABB"));
  assert.throws(
    () => assertDatasetMptDestroyScope({ ...destroy, MPTokenIssuanceID: "FFFF" }, issuer, "0000AABB"),
    /hors scope/,
  );
  assert.throws(
    () => assertDatasetMptDestroyScope({ ...destroy, Account: "rOther" }, issuer, "0000AABB"),
    /hors scope/,
  );
});
