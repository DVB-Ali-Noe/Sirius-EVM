import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { AppError } from "@/lib/app-error";

export type BudgetKind = "request" | "seal" | "training" | "transaction";
export interface BudgetPolicy {
  version: 1;
  chainId: number;
  wallet: string;
  accountingReference: string;
  validUntil: number;
  earnedMarginUsdMicros: string;
  cashUsdMicros: string;
  fixedReserveUsdMicros: string;
  costsUsdMicros: Record<Exclude<BudgetKind, "transaction">, string>;
  gas: {
    totalWei: string;
    maxTransactionWei: string;
    maxGas: string;
    maxFeePerGasWei: string;
    ethUsdMicrosUpperBound: string;
    confirmations: number;
  };
  maxFailures: number;
  maxActive: number;
}

type SqlValue = string | number | null;
type Row = Record<string, unknown>;
interface Database {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...args: SqlValue[]): Row | undefined;
    run(...args: SqlValue[]): { changes: number | bigint };
  };
  close(): void;
}

function database(path: string): Database {
  // Node 22.13+ fournit SQLite sans module natif à compiler dans la CVM.
  const sqlite = process.getBuiltinModule("node:sqlite") as unknown as {
    DatabaseSync: new (path: string) => Database;
  };
  const db = new sqlite.DatabaseSync(path);
  try {
    db.exec("PRAGMA busy_timeout = 3000; PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

const decimal = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/.test(value);
const positive = (value: unknown): value is string => decimal(value) && BigInt(value) > BigInt(0);
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max;

export function validateBudgetPolicy(value: unknown): BudgetPolicy {
  const p = value as BudgetPolicy | null;
  if (!p || p.version !== 1 || !integer(p.chainId, 1, Number.MAX_SAFE_INTEGER)
    || typeof p.wallet !== "string" || !/^0x[0-9a-f]{40}$/.test(p.wallet)
    || /^0x0{40}$/.test(p.wallet)
    || typeof p.accountingReference !== "string" || !p.accountingReference.trim() || p.accountingReference.length > 256
    || !integer(p.validUntil, 1, Number.MAX_SAFE_INTEGER)
    || !decimal(p.earnedMarginUsdMicros) || !decimal(p.cashUsdMicros) || !decimal(p.fixedReserveUsdMicros)
    || !p.costsUsdMicros || ![p.costsUsdMicros.request, p.costsUsdMicros.seal, p.costsUsdMicros.training].every(positive)
    || !p.gas || !decimal(p.gas.totalWei)
    || ![p.gas.maxTransactionWei, p.gas.maxGas, p.gas.maxFeePerGasWei, p.gas.ethUsdMicrosUpperBound].every(positive)
    || !integer(p.gas.confirmations, 1, 100)
    || !integer(p.maxFailures, 1, 1000) || !integer(p.maxActive, 1, 1000)) {
    throw new AppError("Politique de budget runner invalide", 503);
  }
  return structuredClone(p);
}

function assertPrivatePath(path: string): void {
  if (!isAbsolute(path)) throw new AppError("Chemin absolu requis pour le budget runner", 503);
  const dir = lstatSync(dirname(path));
  if (!dir.isDirectory() || (dir.mode & 0o077) !== 0) throw new AppError("Répertoire privé requis pour le budget runner", 503);
}

export function initializeBudgetLedger(path: string, value: unknown): void {
  const policy = validateBudgetPolicy(value);
  assertPrivatePath(path);
  const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
  fsyncSync(fd);
  closeSync(fd);
  const db = database(path);
  try {
    db.exec(`BEGIN IMMEDIATE;
      CREATE TABLE budget (
        id INTEGER PRIMARY KEY CHECK(id = 1), policy TEXT NOT NULL,
        allocated_usd TEXT NOT NULL, allocated_wei TEXT NOT NULL, failures INTEGER NOT NULL
      ) STRICT;
      CREATE TABLE operations (
        id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, kind TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('reserved', 'succeeded', 'failed')),
        usd TEXT NOT NULL, wei TEXT NOT NULL, result TEXT,
        tx_hash TEXT, nonce INTEGER, created_at INTEGER NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX pending_wallet ON operations(kind) WHERE kind = 'transaction' AND state = 'reserved';
      CREATE INDEX active_operations ON operations(state) WHERE state = 'reserved';`);
    db.prepare("INSERT INTO budget VALUES (1, ?, '0', '0', 0)").run(JSON.stringify(policy));
    db.exec("COMMIT; PRAGMA wal_checkpoint(FULL);");
  } finally {
    db.close();
  }
  const dir = openSync(dirname(path), constants.O_RDONLY);
  try { fsyncSync(dir); } finally { closeSync(dir); }
}

export interface BudgetOperation {
  id: string;
  fingerprint: string;
  kind: BudgetKind;
  state: "reserved" | "succeeded" | "failed";
  result: string | null;
  txHash: string | null;
  nonce: number | null;
}

export class BudgetLedger {
  private readonly db: Database;
  private readonly inode: number;
  private readonly device: number;
  readonly policy: BudgetPolicy;

  constructor(private readonly path: string, chainId: number, wallet: string) {
    assertPrivatePath(path);
    const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd);
      if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new AppError("Registre de budget privé requis", 503);
      this.inode = stat.ino;
      this.device = stat.dev;
    } finally { closeSync(fd); }
    this.db = database(path);
    try {
      this.policy = validateBudgetPolicy(JSON.parse(String(this.db.prepare("SELECT policy FROM budget WHERE id = 1").get()?.policy)));
      if (this.policy.chainId !== chainId || this.policy.wallet !== wallet.toLowerCase()) {
        throw new AppError("Budget lié à un autre réseau ou wallet", 503);
      }
      this.assertFile();
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void { this.db.close(); }

  private assertFile(): void {
    const stat = lstatSync(this.path);
    if (!stat.isFile() || stat.ino !== this.inode || stat.dev !== this.device) {
      throw new AppError("Registre de budget remplacé ou indisponible", 503);
    }
  }

  private atomic<T>(action: () => T): T {
    this.assertFile();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  private accounting() {
    const row = this.db.prepare("SELECT allocated_usd, allocated_wei, failures FROM budget WHERE id = 1").get();
    if (!row || !decimal(row.allocated_usd) || !decimal(row.allocated_wei) || !integer(row.failures, 0, Number.MAX_SAFE_INTEGER)) {
      throw new AppError("Comptabilité runner indisponible", 503);
    }
    return { allocatedUsd: BigInt(row.allocated_usd), allocatedWei: BigInt(row.allocated_wei), failures: row.failures };
  }

  private assertAdmission(): void {
    if (Date.now() >= this.policy.validUntil) throw new AppError("Politique de coûts runner périmée", 503);
    if (this.accounting().failures >= this.policy.maxFailures) throw new AppError("Coupe-circuit financier runner ouvert", 503);
  }

  find(id: string, fingerprint: string): BudgetOperation | null {
    this.assertFile();
    const row = this.db.prepare("SELECT * FROM operations WHERE id = ?").get(id);
    if (!row) return null;
    if (row.fingerprint !== fingerprint) throw new AppError("Opération déjà réservée avec d’autres paramètres", 409);
    return {
      id, fingerprint, kind: row.kind as BudgetKind, state: row.state as BudgetOperation["state"],
      result: row.result as string | null, txHash: row.tx_hash as string | null, nonce: row.nonce as number | null,
    };
  }

  reserve(id: string, fingerprint: string, kind: BudgetKind): { fresh: boolean; operation: BudgetOperation } {
    return this.atomic(() => {
      const existing = this.find(id, fingerprint);
      if (existing) {
        if (existing.kind !== kind) throw new AppError("Opération déjà réservée avec d’autres paramètres", 409);
        return { fresh: false, operation: existing };
      }
      this.assertAdmission();
      const active = Number(this.db.prepare("SELECT count(*) AS n FROM operations WHERE state = 'reserved'").get()?.n);
      if (active >= this.policy.maxActive) throw new AppError("Réservations runner en attente de réconciliation", 503);
      if (kind === "transaction" && this.db.prepare("SELECT id FROM operations WHERE kind = 'transaction' AND state = 'reserved'").get()) {
        throw new AppError("Transaction du wallet runner encore incertaine", 503);
      }
      const wei = kind === "transaction" ? BigInt(this.policy.gas.maxTransactionWei) : BigInt(0);
      const scale = BigInt("1000000000000000000");
      const usd = kind === "transaction"
        ? (wei * BigInt(this.policy.gas.ethUsdMicrosUpperBound) + scale - BigInt(1)) / scale
        : BigInt(this.policy.costsUsdMicros[kind]);
      const { allocatedUsd, allocatedWei } = this.accounting();
      const margin = BigInt(this.policy.earnedMarginUsdMicros);
      const cash = BigInt(this.policy.cashUsdMicros);
      const ceiling = (margin < cash ? margin : cash) - BigInt(this.policy.fixedReserveUsdMicros);
      if (allocatedUsd + usd > ceiling || allocatedWei + wei > BigInt(this.policy.gas.totalWei)) {
        throw new AppError("Budget runner insuffisant : nouvelle dépense bloquée", 503);
      }
      this.db.prepare("UPDATE budget SET allocated_usd = ?, allocated_wei = ? WHERE id = 1")
        .run(String(allocatedUsd + usd), String(allocatedWei + wei));
      this.db.prepare("INSERT INTO operations (id, fingerprint, kind, state, usd, wei, created_at) VALUES (?, ?, ?, 'reserved', ?, ?, ?)")
        .run(id, fingerprint, kind, String(usd), String(wei), Date.now());
      return { fresh: true, operation: this.find(id, fingerprint)! };
    });
  }

  recordTransaction(id: string, fingerprint: string, hash: string, nonce: number): void {
    this.atomic(() => {
      this.assertAdmission();
      const operation = this.find(id, fingerprint);
      if (!operation || operation.kind !== "transaction" || operation.state !== "reserved" || operation.txHash
        || !/^0x[0-9a-f]{64}$/.test(hash) || !integer(nonce, 0, Number.MAX_SAFE_INTEGER)) {
        throw new AppError("Intention de transaction runner invalide", 503);
      }
      this.db.prepare("UPDATE operations SET tx_hash = ?, nonce = ? WHERE id = ?").run(hash, nonce, id);
    });
  }

  finish(id: string, fingerprint: string, succeeded: boolean, result: string | null = null): void {
    if (result !== null && Buffer.byteLength(result) > 65536) throw new AppError("Résultat runner trop volumineux", 503);
    this.atomic(() => {
      const operation = this.find(id, fingerprint);
      if (!operation) throw new AppError("Réservation runner introuvable", 503);
      if (operation.state !== "reserved") return;
      this.db.prepare("UPDATE operations SET state = ?, result = ? WHERE id = ?")
        .run(succeeded ? "succeeded" : "failed", result, id);
      if (!succeeded) this.db.prepare("UPDATE budget SET failures = failures + 1 WHERE id = 1").run();
      // Le maximum alloué reste consommé : ni timeout, ni succès ne recrée de marge.
    });
  }

  snapshot() {
    this.assertFile();
    return this.accounting();
  }
}
