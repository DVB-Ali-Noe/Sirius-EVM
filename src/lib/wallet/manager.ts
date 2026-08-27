"use client";

import { chainForNetwork, resolveClientNetwork } from "@/lib/evm/networks";

export interface Eip1193Provider {
  request(args: { method: string; params?: unknown[] | object }): Promise<unknown>;
  on?(event: string, listener: (...args: unknown[]) => void): void;
  removeListener?(event: string, listener: (...args: unknown[]) => void): void;
}

function provider(): Eip1193Provider {
  const candidate = (window as unknown as { ethereum?: Eip1193Provider }).ethereum;
  if (!candidate?.request) throw new Error("Aucun wallet EVM détecté. Installe MetaMask, Rabby ou Coinbase Wallet.");
  return candidate;
}

function chainHex(chainId: number): `0x${string}` {
  return `0x${chainId.toString(16)}`;
}

export function expectedChainId(): string {
  return chainHex(chainForNetwork(resolveClientNetwork()).id);
}

export async function ensureExpectedChain(wallet = provider()): Promise<void> {
  const chain = chainForNetwork(resolveClientNetwork());
  const expected = chainHex(chain.id);
  const current = await wallet.request({ method: "eth_chainId" });
  if (typeof current === "string" && current.toLowerCase() === expected) return;
  try {
    await wallet.request({ method: "wallet_switchEthereumChain", params: [{ chainId: expected }] });
  } catch (error) {
    if ((error as { code?: number }).code !== 4902) throw new Error("Bascule vers Robinhood Chain refusée par le wallet.");
    await wallet.request({
      method: "wallet_addEthereumChain",
      params: [{
        chainId: expected,
        chainName: chain.name,
        nativeCurrency: chain.nativeCurrency,
        rpcUrls: chain.rpcUrls.default.http,
        blockExplorerUrls: chain.blockExplorers?.default.url ? [chain.blockExplorers.default.url] : [],
      }],
    });
  }
}

export async function connectExternalWallet(): Promise<{ address: string; chainId: string }> {
  const wallet = provider();
  await ensureExpectedChain(wallet);
  const accounts = await wallet.request({ method: "eth_requestAccounts" });
  if (!Array.isArray(accounts) || typeof accounts[0] !== "string") throw new Error("Le wallet n'a renvoyé aucun compte.");
  const chainId = await wallet.request({ method: "eth_chainId" });
  if (typeof chainId !== "string") throw new Error("Réseau EVM indisponible.");
  return { address: accounts[0], chainId };
}

export function getExternalWallet(): Eip1193Provider | null {
  return typeof window === "undefined" ? null : (window as unknown as { ethereum?: Eip1193Provider }).ethereum ?? null;
}

export async function disconnectWallet(): Promise<void> {
  await provider().request({ method: "wallet_revokePermissions", params: [{ eth_accounts: {} }] }).catch(() => {});
}

function messageHex(message: string): `0x${string}` {
  const bytes = new TextEncoder().encode(message);
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

export async function signMessageExternal(message: string, address: string): Promise<{ signature: string }> {
  const signature = await provider().request({ method: "personal_sign", params: [messageHex(message), address] });
  if (typeof signature !== "string") throw new Error("Signature EVM refusée par le wallet.");
  return { signature };
}

/**
 * Signature EIP-712. Le wallet affiche les champs en clair plutôt qu'un condensé
 * opaque, ce qui permet au signataire de voir ce qu'il approuve — ici son propre
 * consentement KYB, avec le vérificateur et l'échéance nommés.
 */
export async function signTypedDataExternal(payload: unknown, address: string): Promise<string> {
  const wallet = provider();
  await ensureExpectedChain(wallet);
  const signature = await wallet.request({
    method: "eth_signTypedData_v4",
    params: [address, JSON.stringify(payload)],
  });
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw new Error("Signature EIP-712 refusée par le wallet.");
  }
  return signature;
}

export async function sendTransactionExternal(transaction: Record<string, unknown>): Promise<string> {
  const wallet = provider();
  await ensureExpectedChain(wallet);
  const hash = await wallet.request({ method: "eth_sendTransaction", params: [transaction] });
  if (typeof hash !== "string" || !/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error("Transaction EVM refusée par le wallet.");
  return hash;
}
