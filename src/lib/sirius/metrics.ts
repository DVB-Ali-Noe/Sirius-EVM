export interface DatasetMetrics {
  rowCount: number;
  columnCount: number;
}

export const MAX_CSV_ROWS = 50_000;
export const MAX_CSV_COLUMNS = 64;
const MAX_CELL_CHARS = 10_000;
/** Plus grande valeur absolue d'une cellule numérique : au-delà, la colonne n'entre pas dans l'entraînement. */
export const MAX_ABS_CELL_VALUE = 1e12;

/**
 * Écriture décimale usuelle d'un tableur : signe, partie entière et/ou décimale avec un point,
 * exposant facultatif, espaces ou tabulations autour tolérés.
 */
const DECIMAL_CELL = /^[ \t]*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?[ \t]*$/;

/**
 * Règle numérique unique de l'enclave, de l'ingestion et du navigateur (audit ROB-01, ROB-02).
 * `Number()` seul lisait une cellule faite d'espaces comme 0 et acceptait l'hexadécimal (`0x1A`),
 * le binaire (`0b101`), l'octal (`0o17`), l'espace insécable et le BOM : ces cellules ne sont plus
 * des nombres (une cellule d'espaces compte comme vide). Pour toute cellule acceptée, la valeur lue
 * reste `Number(value)`, inchangée.
 */
export function isNumericCell(value: string): boolean {
  if (!DECIMAL_CELL.test(value)) return false;
  const number = Number(value);
  return Number.isFinite(number) && Math.abs(number) <= MAX_ABS_CELL_VALUE;
}

/** Cellule vide ou faite seulement d'espaces : une valeur manquante. */
export function isBlankCell(value: string): boolean {
  return value.trim() === "";
}

/**
 * Défaut de forme du fichier, situé sur une ligne physique (1 = en-tête) : message précis côté
 * navigateur (`csv-check.ts`) comme côté enclave (texte de l'erreur, 400 à l'ingestion).
 */
export type CsvSyntaxProblem =
  | { kind: "lone-cr"; line: number }
  | { kind: "quote-in-field"; line: number }
  | { kind: "after-quote"; line: number }
  | { kind: "unclosed-quote"; line: number }
  | { kind: "blank-line"; line: number }
  | { kind: "cell-count"; line: number; cells: number; columns: number };

export class CsvValidationError extends Error {
  constructor(message: string, readonly problem?: CsvSyntaxProblem) {
    super(message);
  }
}

function syntaxMessage(problem: CsvSyntaxProblem): string {
  const where = `CSV invalide ligne ${problem.line} : `;
  switch (problem.kind) {
    case "lone-cr":
      return `${where}retour chariot isolé (\\r sans \\n)`;
    case "quote-in-field":
      return `${where}guillemet au milieu d'une cellule non citée`;
    case "after-quote":
      return `${where}caractère après un guillemet fermant`;
    case "unclosed-quote":
      return `${where}guillemet jamais fermé`;
    case "blank-line":
      return `${where}ligne vide (seules les lignes vides en fin de fichier sont admises)`;
    case "cell-count":
      return `${where}${problem.cells} cellule(s) pour ${problem.columns} colonne(s) dans l'en-tête`;
  }
}

/** États du parseur : début de cellule, cellule non citée, entre guillemets, juste après le guillemet fermant. */
const FIELD_START = 0;
const UNQUOTED = 1;
const QUOTED = 2;
const AFTER_QUOTE = 3;

/**
 * Parseur CSV strict (RFC 4180), le même pour le navigateur, l'ingestion et l'enclave. Il refuse ce
 * qu'il devrait sinon deviner (audit robustesse ROB-03 à ROB-06, exactitude EXA-04) :
 * - un BOM UTF-8 initial (export « CSV UTF-8 » d'Excel) est retiré : il finissait dans le nom de la
 *   première colonne, que l'évaluation du navigateur (`File.text()` retire le BOM) ne retrouvait plus ;
 * - fins de ligne `\n` ou `\r\n` ; un `\r` isolé hors guillemets est refusé (il collait deux lignes) ;
 * - un guillemet n'ouvre qu'une cellule entière : guillemet au milieu d'une cellule non citée,
 *   caractère après le guillemet fermant et guillemet jamais fermé sont refusés ;
 * - les lignes vides en fin de fichier sont ignorées, une ligne vide avant la fin est refusée ;
 * - chaque ligne a exactement autant de cellules que l'en-tête (une ligne tronquée ou une virgule
 *   décimale non citée décalait les colonnes, jusqu'à changer la cible).
 * Un fichier qui respecte ces règles donne exactement le même tableau qu'avant ce durcissement.
 *
 * Les caractères ordinaires sont copiés par tranches : une concaténation caractère par caractère
 * construit des chaînes chaînées d'environ 30 octets par caractère, soit près de 100 Mo de tas pour
 * 3 Mo de texte.
 */
export function parseCsv(input: string): string[][] {
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let segment = 0;
  let state = FIELD_START;
  // Ligne physique courante, ligne où commence l'enregistrement, ligne du guillemet ouvrant.
  let line = 1;
  let recordLine = 1;
  let quoteLine = 1;
  // Première ligne vide pas encore suivie d'une ligne de données (0 : aucune).
  let blankLine = 0;

  const fail = (problem: CsvSyntaxProblem): never => {
    throw new CsvValidationError(syntaxMessage(problem), problem);
  };
  const pushField = () => {
    if (field.length > MAX_CELL_CHARS) throw new CsvValidationError("cellule CSV trop volumineuse");
    if (row.length >= MAX_CSV_COLUMNS) throw new CsvValidationError(`trop de colonnes CSV (max ${MAX_CSV_COLUMNS})`);
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    if (blankLine) fail({ kind: "blank-line", line: blankLine });
    if (rows.length >= MAX_CSV_ROWS) throw new CsvValidationError(`trop de lignes CSV (max ${MAX_CSV_ROWS})`);
    if (rows.length > 0 && row.length !== rows[0].length) {
      fail({ kind: "cell-count", line: recordLine, cells: row.length, columns: rows[0].length });
    }
    rows.push(row);
    row = [];
  };
  const append = (value: string) => {
    if (field.length + value.length > MAX_CELL_CHARS) throw new CsvValidationError("cellule CSV trop volumineuse");
    field += value;
  };
  const flush = (end: number) => {
    if (end > segment) append(text.slice(segment, end));
  };

  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (state === QUOTED) {
      if (c === "\n") line++;
      if (c !== '"') continue;
      flush(i);
      if (text[i + 1] === '"') {
        append('"');
        i++;
      } else state = AFTER_QUOTE;
      segment = i + 1;
      continue;
    }
    if (c === "," || c === "\n" || c === "\r") {
      flush(i);
      if (c === "\r") {
        if (text[i + 1] !== "\n") fail({ kind: "lone-cr", line });
        i++;
      }
      segment = i + 1;
      if (c === ",") pushField();
      else {
        // Rien depuis la fin de ligne précédente : ligne vide, admise seulement en fin de fichier.
        if (state === FIELD_START && row.length === 0) blankLine ||= line;
        else {
          pushField();
          pushRow();
        }
        line++;
        recordLine = line;
      }
      state = FIELD_START;
      continue;
    }
    if (state === AFTER_QUOTE) fail({ kind: "after-quote", line });
    if (c === '"') {
      if (state === UNQUOTED) fail({ kind: "quote-in-field", line });
      state = QUOTED;
      quoteLine = line;
      segment = i + 1;
      continue;
    }
    state = UNQUOTED;
  }
  if (state === QUOTED) fail({ kind: "unclosed-quote", line: quoteLine });
  flush(text.length);

  if (state !== FIELD_START || row.length > 0) {
    pushField();
    pushRow();
  }
  return rows;
}

/** Calcule les seuls volumes publiables depuis le CSV ouvert dans le runner. */
export function computeMetrics(content: Buffer): DatasetMetrics {
  const table = parseCsv(content.toString("utf-8"));
  if (table.length === 0) {
    return { rowCount: 0, columnCount: 0 };
  }

  const [header, ...dataRows] = table;
  return { rowCount: dataRows.length, columnCount: header.length };
}

/** Élimine les stats détaillées encore présentes sur les datasets créés avant le correctif. */
export function publicDatasetMetrics(value: unknown): DatasetMetrics | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const { rowCount, columnCount } = value as Record<string, unknown>;
  if (
    typeof rowCount !== "number" ||
    typeof columnCount !== "number" ||
    !Number.isSafeInteger(rowCount) ||
    !Number.isSafeInteger(columnCount) ||
    rowCount < 0 ||
    rowCount > MAX_CSV_ROWS ||
    columnCount < 0 ||
    columnCount > MAX_CSV_COLUMNS
  ) {
    return null;
  }
  return { rowCount, columnCount };
}
