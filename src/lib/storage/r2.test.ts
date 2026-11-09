import assert from "node:assert/strict";
import { test } from "node:test";
import { presignR2Put, presignedQuery, r2ConfigFromEnv, r2GetObject, r2ListObjects, signedHeaders, type R2Config } from "./r2";

// Exemples publiés par AWS (« Signature Calculations for the Authorization Header » et « Query
// String Authentication ») : mêmes identifiants, même date, signatures attendues connues.
const AWS = {
  accessKeyId: "AKIAIOSFODNN7EXAMPLE",
  secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  host: "examplebucket.s3.amazonaws.com",
  region: "us-east-1",
  now: new Date("2013-05-24T00:00:00Z"),
};

test("la signature d'en-tête suit l'exemple GET d'AWS", () => {
  const headers = signedHeaders({
    method: "GET",
    host: AWS.host,
    path: "/test.txt",
    headers: { range: "bytes=0-9" },
    payloadHash: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    region: AWS.region,
    accessKeyId: AWS.accessKeyId,
    secretAccessKey: AWS.secretAccessKey,
    now: AWS.now,
  });
  assert.equal(
    headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
      "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, " +
      "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
  assert.equal(headers.host, undefined);
});

test("l'URL pré-signée suit l'exemple d'AWS", () => {
  const query = presignedQuery(
    { method: "GET", host: AWS.host, path: "/test.txt", region: AWS.region, accessKeyId: AWS.accessKeyId, secretAccessKey: AWS.secretAccessKey, now: AWS.now },
    86400,
  );
  assert.match(query, /&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404$/);
});

const CONFIG: R2Config = {
  accountId: "0123456789abcdef0123456789abcdef",
  accessKeyId: "key",
  secretAccessKey: "secret",
  bucket: "sirius-staging",
};

test("une URL d'envoi R2 vise le bon bucket, la bonne partie, et expire vite", () => {
  const url = new URL(presignR2Put(CONFIG, "datasets/d1/u1/chunks/3", 600, { uploadId: "mp-1", partNumber: 4 }));
  assert.equal(url.host, "0123456789abcdef0123456789abcdef.r2.cloudflarestorage.com");
  assert.equal(url.pathname, "/sirius-staging/datasets/d1/u1/chunks/3");
  assert.equal(url.searchParams.get("partNumber"), "4");
  assert.equal(url.searchParams.get("uploadId"), "mp-1");
  assert.equal(url.searchParams.get("X-Amz-Expires"), "600");
  assert.ok(!url.href.includes("secret"));
  assert.throws(() => presignR2Put(CONFIG, "k", 7200), /Durée de validité invalide/);
});

test("la configuration incomplète est refusée", () => {
  assert.throws(() => r2ConfigFromEnv({}), /Stockage R2 non configuré/);
  assert.throws(() => r2ConfigFromEnv({ R2_ACCOUNT_ID: "x", R2_ACCESS_KEY_ID: "a", R2_SECRET_ACCESS_KEY: "b", R2_BUCKET: "c" }), /non configuré/);
  assert.deepEqual(
    r2ConfigFromEnv({ R2_ACCOUNT_ID: CONFIG.accountId, R2_ACCESS_KEY_ID: "key", R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET: "sirius-staging" }),
    CONFIG,
  );
});

test("la lecture réessaie les erreurs passagères mais pas un refus", async () => {
  const statuses = [503, 500, 200];
  let calls = 0;
  const flaky: typeof fetch = async () => {
    const status = statuses[calls++];
    return new Response(status === 200 ? new Uint8Array([1, 2, 3]) : "err", { status });
  };
  assert.deepEqual(await r2GetObject(CONFIG, "k", { fetchImpl: flaky, retryDelayMs: 1 }), new Uint8Array([1, 2, 3]));
  assert.equal(calls, 3);

  let denied = 0;
  const forbidden: typeof fetch = async () => {
    denied++;
    return new Response("<Error><Code>AccessDenied</Code></Error>", { status: 403 });
  };
  await assert.rejects(r2GetObject(CONFIG, "k", { fetchImpl: forbidden, retryDelayMs: 1 }), /refusée \(HTTP 403\)/);
  assert.equal(denied, 1);
});

test("une URL d'envoi peut signer la taille exacte du corps", () => {
  const url = new URL(presignR2Put(CONFIG, "datasets/d1/u1/chunks/0", 600, undefined, new Date("2026-11-04T00:00:00Z"), 8_388_636));
  assert.equal(url.searchParams.get("X-Amz-SignedHeaders"), "content-length;host");
  const unsized = new URL(presignR2Put(CONFIG, "datasets/d1/u1/chunks/0", 600, undefined, new Date("2026-11-04T00:00:00Z")));
  assert.equal(unsized.searchParams.get("X-Amz-SignedHeaders"), "host");
  assert.notEqual(url.searchParams.get("X-Amz-Signature"), unsized.searchParams.get("X-Amz-Signature"));
  assert.throws(() => presignR2Put(CONFIG, "k", 60, undefined, new Date(), 0), /Taille d'envoi invalide/);
});

test("la liste suit les pages de R2 et ignore ce qui n'est pas un objet", async () => {
  const pages = [
    "<ListBucketResult><IsTruncated>true</IsTruncated><NextContinuationToken>t2</NextContinuationToken>" +
      "<Contents><Key>p/chunks/0</Key><Size>10</Size></Contents><Contents><Key>p/chunks/1</Key><Size>11</Size></Contents></ListBucketResult>",
    "<ListBucketResult><IsTruncated>false</IsTruncated><Contents><Key>p/chunks/2</Key><Size>12</Size></Contents></ListBucketResult>",
  ];
  const urls: string[] = [];
  const fetchImpl: typeof fetch = async (input) => {
    urls.push(String(input));
    return new Response(pages[urls.length - 1]);
  };
  assert.deepEqual(await r2ListObjects(CONFIG, "p/chunks/", { fetchImpl }), [
    { key: "p/chunks/0", size: 10 },
    { key: "p/chunks/1", size: 11 },
    { key: "p/chunks/2", size: 12 },
  ]);
  assert.match(urls[0], /\?list-type=2&prefix=p%2Fchunks%2F$/);
  assert.match(urls[1], /continuation-token=t2/);
  await assert.rejects(r2ListObjects(CONFIG, "p/", { fetchImpl: async () => new Response("<Error/>", { status: 403 }) }), /HTTP 403/);
});
