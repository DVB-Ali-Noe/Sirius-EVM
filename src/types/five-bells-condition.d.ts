declare module "five-bells-condition" {
  /** Crypto-condition PREIMAGE-SHA-256 (le seul type utilisé par Sirius). */
  export class PreimageSha256 {
    setPreimage(preimage: Buffer): void;
    getConditionBinary(): Buffer;
    serializeBinary(): Buffer;
  }
}
