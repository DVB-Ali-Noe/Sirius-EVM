"use client";

interface EncryptedModelPayload {
  ciphertext: string;
  iv: string;
  tag: string;
}

export interface DeliveredModel {
  algo: "linear_regression";
  target: string;
  features: string[];
  coefficients: number[];
  metrics: {
    r2: number;
    rmse: number;
    n: number;
  };
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function concat(left: Uint8Array<ArrayBuffer>, right: Uint8Array<ArrayBuffer>): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(left.length + right.length);
  result.set(left);
  result.set(right, left.length);
  return result;
}

function encryptedPayload(value: unknown): EncryptedModelPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Modèle chiffré invalide");
  const payload = value as Partial<EncryptedModelPayload>;
  if (
    typeof payload.ciphertext !== "string" ||
    typeof payload.iv !== "string" ||
    typeof payload.tag !== "string"
  ) {
    throw new Error("Modèle chiffré invalide");
  }
  return payload as EncryptedModelPayload;
}

function deliveredModel(value: unknown): DeliveredModel {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Modèle déchiffré invalide");
  const model = value as Partial<DeliveredModel>;
  if (
    model.algo !== "linear_regression" ||
    typeof model.target !== "string" ||
    !Array.isArray(model.features) ||
    !model.features.every((feature) => typeof feature === "string") ||
    model.features.length === 0 ||
    model.features.length > 31 ||
    !Array.isArray(model.coefficients) ||
    model.coefficients.length !== model.features.length + 1 ||
    !model.coefficients.every((coefficient) => typeof coefficient === "number" && Number.isFinite(coefficient)) ||
    !model.metrics ||
    typeof model.metrics.r2 !== "number" ||
    !Number.isFinite(model.metrics.r2) ||
    typeof model.metrics.rmse !== "number" ||
    !Number.isFinite(model.metrics.rmse) ||
    model.metrics.rmse < 0 ||
    !Number.isSafeInteger(model.metrics.n) ||
    model.metrics.n < 1
  ) {
    throw new Error("Modèle déchiffré invalide");
  }
  return model as DeliveredModel;
}

export async function decryptModelPayload(payload: unknown, modelKey: string): Promise<DeliveredModel> {
  const encrypted = encryptedPayload(payload);
  let rawKey: Uint8Array<ArrayBuffer>;
  let ciphertext: Uint8Array<ArrayBuffer>;
  let iv: Uint8Array<ArrayBuffer>;
  let tag: Uint8Array<ArrayBuffer>;
  try {
    rawKey = decodeBase64(modelKey);
    ciphertext = decodeBase64(encrypted.ciphertext);
    iv = decodeBase64(encrypted.iv);
    tag = decodeBase64(encrypted.tag);
  } catch {
    throw new Error("Modèle chiffré invalide");
  }
  if (rawKey.length !== 32 || iv.length !== 12 || tag.length !== 16) {
    throw new Error("Modèle chiffré invalide");
  }

  try {
    const key = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["decrypt"]);
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv, tagLength: 128 },
      key,
      concat(ciphertext, tag),
    );
    return deliveredModel(JSON.parse(new TextDecoder().decode(plaintext)));
  } catch {
    throw new Error("Déchiffrement du modèle impossible");
  }
}

export async function fetchDecryptedModel(modelCid: string, modelKey: string): Promise<DeliveredModel> {
  const response = await fetch(`/api/models/${encodeURIComponent(modelCid)}`, { cache: "no-store" });
  const payload = await response.json().catch(() => null) as { error?: unknown } | null;
  if (!response.ok) {
    throw new Error(typeof payload?.error === "string" ? payload.error : "Téléchargement du modèle échoué");
  }
  return decryptModelPayload(payload, modelKey);
}

export function downloadDecryptedModel(model: DeliveredModel, filename: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(model, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
