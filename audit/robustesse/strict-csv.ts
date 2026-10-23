/**
 * PROPOSITION (non branchée en production) : parseur CSV et détection numérique stricts.
 *
 * Mêmes plafonds que `parseCsv` (src/lib/sirius/metrics.ts) et même stratégie de copie par
 * tranches (pas de concaténation caractère par caractère). Différences, toutes signalées par
 * `CsvValidationError` (donc un 400 propre à l'ingestion) :
 * - un BOM UTF-8 initial est retiré au lieu de finir dans le nom de la première colonne ;
 * - un `\r` isolé (hors `\r\n`, hors guillemets) est refusé au lieu d'être supprimé en silence ;
 * - un guillemet au milieu d'un champ non cité, un caractère après un guillemet fermant, ou un
 *   guillemet jamais fermé sont refusés (RFC 4180) ;
 * - les lignes vides en fin de fichier sont ignorées ; une ligne vide au milieu est refusée ;
 * - chaque ligne doit avoir exactement autant de cellules que l'en-tête.
 *
 * `isStrictNumericCell` n'accepte que l'écriture décimale usuelle : ni espaces, ni hexadécimal
 * (0x), binaire (0b), octal (0o), ni « Infinity ». Une cellule faite d'espaces n'est plus lue 0.
 */
import { CsvValidationError, MAX_CSV_COLUMNS, MAX_CSV_ROWS } from "@/lib/sirius/metrics";

const MAX_CELL_CHARS = 10_000;
const MAX_ABS_VALUE = 1e12;
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d{1,3})?$/;

export function isStrictNumericCell(value: string): boolean {
  if (value.length > 400 || !DECIMAL.test(value)) return false;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= MAX_ABS_VALUE;
}

export function parseCsvStrict(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let segment = 0;
  let line = 1;
  // État : 0 début de champ, 1 champ non cité, 2 dans les guillemets, 3 juste après un guillemet fermant.
  let state = 0;
  let pendingBlank = 0;

  const fail = (reason: string): never => { throw new CsvValidationError(`CSV invalide ligne ${line} : ${reason}`); };
  const append = (value: string) => {
    if (field.length + value.length > MAX_CELL_CHARS) throw new CsvValidationError("cellule CSV trop volumineuse");
    field += value;
  };
  const flush = (end: number) => { if (end > segment) append(text.slice(segment, end)); };
  const pushField = () => {
    if (row.length >= MAX_CSV_COLUMNS) throw new CsvValidationError(`trop de colonnes CSV (max ${MAX_CSV_COLUMNS})`);
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    if (row.length === 1 && row[0] === "" ) { pendingBlank++; row = []; return; }
    if (pendingBlank > 0) fail("ligne vide au milieu du fichier");
    if (rows.length >= MAX_CSV_ROWS) throw new CsvValidationError(`trop de lignes CSV (max ${MAX_CSV_ROWS})`);
    if (rows.length > 0 && row.length !== rows[0].length) fail(`${row.length} cellules pour ${rows[0].length} colonnes`);
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (state === 2) {
      if (c !== '"') continue;
      flush(i);
      if (text[i + 1] === '"') { append('"'); i++; segment = i + 1; continue; }
      segment = i + 1;
      state = 3;
      continue;
    }
    if (c === "," || c === "\n" || c === "\r") {
      if (state !== 3) flush(i);
      if (c === "\r") {
        if (text[i + 1] !== "\n") fail("retour chariot isolé");
        i++;
      }
      segment = i + 1;
      pushField();
      if (c !== ",") { pushRow(); line++; }
      state = 0;
      continue;
    }
    if (state === 3) fail("caractère après un guillemet fermant");
    if (c === '"') {
      if (state === 1) fail("guillemet au milieu d'un champ non cité");
      state = 2;
      segment = i + 1;
      continue;
    }
    state = 1;
  }
  if (state === 2) fail("guillemet jamais fermé");
  if (state !== 3) flush(text.length);
  if (field.length > 0 || row.length > 0 || state === 3) {
    pushField();
    pushRow();
  }
  return rows;
}
