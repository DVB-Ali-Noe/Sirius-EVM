// Déclarations : xrpl-connect 0.8.2 ne ships aucun typing.
// Basé sur la doc officielle (xrpl-commons.github.io/xrpl-connect).
declare module "xrpl-connect" {
  export interface NetworkInfo {
    id: string;
    name: string;
    wss: string;
    rpc?: string;
    walletConnectId?: string;
  }

  export interface AccountInfo {
    address: string;
    publicKey?: string;
    network?: NetworkInfo;
    walletName?: string;
  }

  export interface WalletManagerOptions {
    adapters: unknown[];
    network?: string;
    autoConnect?: boolean;
    storage?: unknown;
  }

  export class WalletManager {
    constructor(options: WalletManagerOptions);
    readonly connected: boolean;
    readonly account: AccountInfo | null;
    connect(walletId: string, options?: unknown): Promise<AccountInfo>;
    reconnect(): Promise<AccountInfo | null>;
    disconnect(): Promise<void>;
    sign(transaction: Record<string, unknown>): Promise<{ hash: string; tx_blob?: string }>;
    signAndSubmit(transaction: Record<string, unknown>): Promise<{ hash: string }>;
    // Retour normalisé au niveau manager, mais dépendant de l'adaptateur sous-jacent
    // (Crossmark : signature+publicKey ; GemWallet : signedMessage ; WC : non supporté).
    signMessage(
      message: string | Uint8Array,
    ): Promise<{ message?: string; signature?: string; publicKey?: string; signedMessage?: string }>;
    getAvailableWallets(): Promise<unknown[]>;
    on(event: string, listener: (data: unknown) => void): void;
    off(event: string, listener: (data: unknown) => void): void;
    once(event: string, listener: (data: unknown) => void): void;
  }

  export class CrossmarkAdapter {
    constructor(config?: unknown);
  }
  export class GemWalletAdapter {
    constructor(config?: unknown);
  }
  export class OtsuAdapter {
    constructor(config?: unknown);
  }
  export class XyraAdapter {
    constructor(config?: unknown);
  }
  export class LedgerAdapter {
    constructor(config?: { derivationPath?: string; timeout?: number; preferWebHID?: boolean });
  }
  export class XamanAdapter {
    constructor(config: { apiKey: string });
  }
  export class WalletConnectAdapter {
    constructor(config: { projectId: string; metadata?: unknown });
  }
}
