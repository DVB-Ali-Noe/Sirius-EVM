import {
  CsvValidationError,
  MAX_CSV_COLUMNS,
  isBlankCell,
  isNumericCell,
  syntaxMessage,
  type ColumnCells,
  type CsvSyntaxProblem,
} from "@/lib/sirius/metrics";

/**
 * Lecture en flux du CSV d'un envoi en morceaux : mêmes règles que `parseCsv` (RFC 4180 strict,
 * mêmes messages d'erreur), mais le texte arrive par tranches et seules les lignes courantes restent
 * en mémoire. Un fichier de 1 Gio ne tient pas en `string[][]` ; ici rien n'est gardé, sauf ce
 * que l'appelant retient dans `onRow`.
 *
 * Une tranche peut couper n'importe où : au milieu d'un caractère UTF-8 (le décodeur garde les
 * octets en attente), entre `\r` et `\n`, ou entre les deux guillemets d'un `""` échappé (le
 * dernier caractère est alors gardé pour la tranche suivante).
 */

const MAX_CELL_CHARS = 10_000;
/** Plafond des lignes d'un envoi en morceaux : environ 50 octets par ligne pour 1 Gio. */
export const MAX_CHUNKED_CSV_ROWS = 25_000_000;

const FIELD_START = 0;
const UNQUOTED = 1;
const QUOTED = 2;
const AFTER_QUOTE = 3;

/** Décompte d'une colonne : celui de `columnCells`, plus les cellules valant exactement `0` ou `1`. */
export interface ColumnSummary extends ColumnCells {
  zeros: number;
  ones: number;
}

export interface CsvStreamSummary {
  header: string[];
  /** Lignes de données, en-tête exclu. */
  rowCount: number;
  columnCount: number;
  /** Une entrée par colonne de l'en-tête. */
  columns: ColumnSummary[];
}

export class StrictCsvStream {
  private readonly decoder = new TextDecoder("utf-8", { fatal: true });
  private readonly maxRows: number;
  private carry = "";
  private started = false;
  private ended = false;
  private header: string[] | null = null;
  private rowCount = 0;
  private row: string[] = [];
  private field = "";
  private state = FIELD_START;
  private line = 1;
  private recordLine = 1;
  private quoteLine = 1;
  private blankLine = 0;
  private columns: ColumnSummary[] = [];

  constructor(
    private readonly onRow?: (row: string[], header: string[]) => void,
    options: { maxRows?: number } = {},
  ) {
    this.maxRows = options.maxRows ?? MAX_CHUNKED_CSV_ROWS;
  }

  /** Octets bruts du fichier, dans l'ordre. */
  pushBytes(bytes: Uint8Array): void {
    let text: string;
    try {
      text = this.decoder.decode(bytes, { stream: true });
    } catch {
      throw new CsvValidationError("CSV invalide : texte non UTF-8");
    }
    this.pushText(text);
  }

  pushText(chunk: string): void {
    if (this.ended) throw new Error("Flux CSV déjà clos");
    let text = this.carry + chunk;
    if (!this.started && text.length > 0) {
      this.started = true;
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    }
    this.carry = this.scan(text, false);
  }

  end(): CsvStreamSummary {
    if (this.ended) throw new Error("Flux CSV déjà clos");
    try {
      this.decoder.decode();
    } catch {
      throw new CsvValidationError("CSV invalide : texte non UTF-8");
    }
    const text = this.carry;
    this.carry = "";
    this.scan(text, true);
    this.ended = true;
    if (this.state === QUOTED) this.fail({ kind: "unclosed-quote", line: this.quoteLine });
    if (this.state !== FIELD_START || this.row.length > 0) {
      this.pushField();
      this.pushRow();
    }
    const header = this.header ?? [];
    return {
      header,
      rowCount: this.rowCount,
      columnCount: header.length,
      columns: this.columns.map((column) => ({ ...column })),
    };
  }

  private fail(problem: CsvSyntaxProblem): never {
    throw new CsvValidationError(syntaxMessage(problem), problem);
  }

  private append(value: string): void {
    if (this.field.length + value.length > MAX_CELL_CHARS) throw new CsvValidationError("cellule CSV trop volumineuse");
    this.field += value;
  }

  private pushField(): void {
    if (this.field.length > MAX_CELL_CHARS) throw new CsvValidationError("cellule CSV trop volumineuse");
    if (this.row.length >= MAX_CSV_COLUMNS) throw new CsvValidationError(`trop de colonnes CSV (max ${MAX_CSV_COLUMNS})`);
    this.row.push(this.field);
    this.field = "";
  }

  private pushRow(): void {
    if (this.blankLine) this.fail({ kind: "blank-line", line: this.blankLine });
    const row = this.row;
    this.row = [];
    if (!this.header) {
      this.header = row;
      this.columns = row.map(() => ({ missing: 0, invalid: 0, numeric: 0, zeros: 0, ones: 0 }));
      return;
    }
    if (this.rowCount >= this.maxRows) throw new CsvValidationError(`trop de lignes CSV (max ${this.maxRows})`);
    if (row.length !== this.header.length) {
      this.fail({ kind: "cell-count", line: this.recordLine, cells: row.length, columns: this.header.length });
    }
    this.rowCount++;
    for (let i = 0; i < row.length; i++) {
      const cell = row[i];
      const column = this.columns[i];
      if (isBlankCell(cell)) column.missing++;
      else if (isNumericCell(cell)) column.numeric++;
      else column.invalid++;
      if (cell === "0") column.zeros++;
      else if (cell === "1") column.ones++;
    }
    this.onRow?.(row, this.header);
  }

  /**
   * Même automate que `parseCsv`, repris là où la tranche précédente s'est arrêtée. Un `"` entre
   * guillemets ou un `\r` en bout de tranche ont besoin du caractère suivant : hors fin de fichier,
   * l'automate s'arrête juste avant et renvoie la fin non lue, à relire avec la tranche suivante.
   */
  private scan(text: string, final: boolean): string {
    let segment = 0;
    const flush = (end: number) => {
      if (end > segment) this.append(text.slice(segment, end));
    };
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (!final && i === text.length - 1 && (c === "\r" || (c === '"' && this.state === QUOTED))) {
        flush(i);
        return text.slice(i);
      }
      if (this.state === QUOTED) {
        if (c === "\n") this.line++;
        if (c !== '"') continue;
        flush(i);
        if (text[i + 1] === '"') {
          this.append('"');
          i++;
        } else this.state = AFTER_QUOTE;
        segment = i + 1;
        continue;
      }
      if (c === "," || c === "\n" || c === "\r") {
        flush(i);
        if (c === "\r") {
          // Un `\r` en bout de texte n'arrive ici qu'en fin de fichier : il est alors isolé.
          if (text[i + 1] !== "\n") this.fail({ kind: "lone-cr", line: this.line });
          i++;
        }
        segment = i + 1;
        if (c === ",") this.pushField();
        else {
          if (this.state === FIELD_START && this.row.length === 0) this.blankLine ||= this.line;
          else {
            this.pushField();
            this.pushRow();
          }
          this.line++;
          this.recordLine = this.line;
        }
        this.state = FIELD_START;
        continue;
      }
      if (this.state === AFTER_QUOTE) this.fail({ kind: "after-quote", line: this.line });
      if (c === '"') {
        if (this.state === UNQUOTED) this.fail({ kind: "quote-in-field", line: this.line });
        this.state = QUOTED;
        this.quoteLine = this.line;
        segment = i + 1;
        continue;
      }
      this.state = UNQUOTED;
    }
    // Ce qui reste appartient à la cellule en cours ; elle continue dans la tranche suivante.
    flush(text.length);
    return "";
  }
}
