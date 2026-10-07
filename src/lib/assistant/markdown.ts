/**
 * Markdown minimal et sûr pour les réponses de Sirio : le texte du modèle est découpé en un
 * arbre (paragraphes, titres, listes, blocs de code, gras, italique, code en ligne, liens) que
 * le panneau rend en éléments React. Rien n'est jamais interprété comme HTML : une balise
 * écrite dans la réponse reste du texte, une image n'est jamais chargée (son texte alternatif
 * seul est gardé), et seuls les liens `http(s)://` ou les chemins internes (`/train`) sont
 * cliquables ; `javascript:`, `data:`, `mailto:` et les URL relatives au protocole (`//…`)
 * redeviennent du texte. Module pur, testable sans navigateur.
 *
 * L'analyse est tolérante : un `**` jamais refermé, fréquent pendant la réception en flux,
 * est rendu tel quel au lieu de faire disparaître la fin du message.
 */

export type MarkdownInline =
  | { type: "text"; text: string }
  | { type: "strong"; children: MarkdownInline[] }
  | { type: "em"; children: MarkdownInline[] }
  | { type: "code"; text: string }
  | { type: "link"; href: string; external: boolean; children: MarkdownInline[] }
  | { type: "br" };

export type MarkdownBlock =
  | { type: "paragraph"; children: MarkdownInline[] }
  | { type: "heading"; level: 1 | 2 | 3; children: MarkdownInline[] }
  | { type: "list"; ordered: boolean; start: number; items: MarkdownInline[][] }
  | { type: "code"; text: string };

/** Longueur maximale d'une cible de lien gardée cliquable. */
const MAX_HREF_CHARS = 2_048;
const CONTROL_OR_SPACE = /[\u0000- \u007F]/;

/**
 * Cible de lien acceptée : `https://…`, `http://…` ou un chemin interne commençant par `/`
 * (jamais `//`, qui désignerait un autre hôte). Tout le reste donne `null` : le lien est
 * alors rendu comme du texte.
 */
export function safeMarkdownHref(raw: string): { href: string; external: boolean } | null {
  const href = raw.trim();
  if (href.length === 0 || href.length > MAX_HREF_CHARS || CONTROL_OR_SPACE.test(href)) return null;
  if (href.startsWith("/")) return href.startsWith("//") || href.startsWith("/\\") ? null : { href, external: false };
  if (/^https?:\/\/[^/]/i.test(href)) return { href, external: true };
  return null;
}

/** Texte brut d'une suite de nœuds en ligne (texte alternatif, lien non sûr). */
function plainText(nodes: readonly MarkdownInline[]): string {
  return nodes.map((node) => {
    switch (node.type) {
      case "text":
      case "code":
        return node.text;
      case "br":
        return "\n";
      default:
        return plainText(node.children);
    }
  }).join("");
}

function pushText(out: MarkdownInline[], text: string): void {
  if (text.length === 0) return;
  const last = out[out.length - 1];
  if (last && last.type === "text") last.text += text;
  else out.push({ type: "text", text });
}

/** Position du `]` qui ferme le crochet ouvert en `open`, en tenant compte des crochets imbriqués, ou −1. */
function closingBracket(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Position du `)` qui ferme la parenthèse ouverte en `open`, parenthèses imbriquées comprises, ou −1. */
function closingParen(source: string, open: number): number {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const char = source[i];
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
    else if (char === "\n") return -1;
  }
  return -1;
}

/** Fin du marqueur `marker` (`**`, `*`, `_`, `` ` ``) ouvert juste avant `from`, ou −1 s'il n'est pas refermé. */
function closingMarker(source: string, from: number, marker: string): number {
  let i = from;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
      continue;
    }
    if (source.startsWith(marker, i)) {
      // Un marqueur fermant ne suit pas une espace (« a * b * c » n'est pas de l'italique).
      if (i === from || /\s/.test(source[i - 1])) {
        i += marker.length;
        continue;
      }
      return i;
    }
    if (marker !== "`" && source[i] === "\n") return -1;
    i += 1;
  }
  return -1;
}

const BARE_URL = /^https?:\/\/[^\s<>()[\]]+/i;

/** Analyse du texte en ligne d'un paragraphe, d'un titre ou d'un élément de liste. */
export function parseMarkdownInline(source: string): MarkdownInline[] {
  const out: MarkdownInline[] = [];
  let i = 0;
  let text = "";
  const flush = () => {
    pushText(out, text);
    text = "";
  };
  while (i < source.length) {
    const char = source[i];
    if (char === "\\" && i + 1 < source.length && /[\\`*_[\]()!#>-]/.test(source[i + 1])) {
      text += source[i + 1];
      i += 2;
      continue;
    }
    if (char === "\n") {
      flush();
      out.push({ type: "br" });
      i += 1;
      continue;
    }
    if (char === "`") {
      const end = closingMarker(source, i + 1, "`");
      if (end !== -1) {
        flush();
        out.push({ type: "code", text: source.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }
    if (char === "!" && source[i + 1] === "[") {
      // Image : jamais chargée, son texte alternatif seul est gardé.
      const close = closingBracket(source, i + 1);
      if (close !== -1 && source[close + 1] === "(") {
        const end = closingParen(source, close + 1);
        if (end !== -1) {
          text += source.slice(i + 2, close);
          i = end + 1;
          continue;
        }
      }
    }
    if (char === "[") {
      const close = closingBracket(source, i);
      if (close !== -1 && source[close + 1] === "(") {
        const end = closingParen(source, close + 1);
        if (end !== -1) {
          const label = source.slice(i + 1, close);
          const target = source.slice(close + 2, end).replace(/\s+"[^"]*"\s*$/, "");
          const safe = safeMarkdownHref(target);
          flush();
          const children = parseMarkdownInline(label);
          if (safe) out.push({ type: "link", href: safe.href, external: safe.external, children });
          else pushText(out, plainText(children));
          i = end + 1;
          continue;
        }
      }
    }
    if ((char === "*" || char === "_")) {
      const double = source[i + 1] === char;
      const marker = double ? char + char : char;
      // `_` à l'intérieur d'un mot (snake_case) n'ouvre rien.
      const inWord = char === "_" && i > 0 && /\w/.test(source[i - 1]);
      const next = source[i + marker.length];
      if (!inWord && next !== undefined && !/\s/.test(next)) {
        const end = closingMarker(source, i + marker.length, marker);
        if (end !== -1) {
          flush();
          const children = parseMarkdownInline(source.slice(i + marker.length, end));
          out.push(double ? { type: "strong", children } : { type: "em", children });
          i = end + marker.length;
          continue;
        }
      }
    }
    if (char === "h" && (i === 0 || /[\s(]/.test(source[i - 1]))) {
      const match = BARE_URL.exec(source.slice(i));
      if (match) {
        const url = match[0].replace(/[.,;:!?]+$/, "");
        const safe = safeMarkdownHref(url);
        if (safe) {
          flush();
          out.push({ type: "link", href: safe.href, external: true, children: [{ type: "text", text: url }] });
          i += url.length;
          continue;
        }
      }
    }
    text += char;
    i += 1;
  }
  flush();
  return out;
}

const LIST_ITEM = /^\s{0,3}(?:([-*+])|(\d{1,3})[.)])\s+(.*)$/;
const HEADING = /^\s{0,3}(#{1,3})\s+(.+?)\s*#*\s*$/;
const FENCE = /^\s{0,3}```/;

/** Analyse d'une réponse complète (ou en cours de réception) en blocs. */
export function parseMarkdown(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    blocks.push({ type: "paragraph", children: parseMarkdownInline(paragraph.join("\n")) });
    paragraph = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (FENCE.test(line)) {
      flushParagraph();
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !FENCE.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      blocks.push({ type: "code", text: body.join("\n") });
      i += 1;
      continue;
    }
    if (line.trim().length === 0) {
      flushParagraph();
      i += 1;
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ type: "heading", level: heading[1].length as 1 | 2 | 3, children: parseMarkdownInline(heading[2]) });
      i += 1;
      continue;
    }
    const item = LIST_ITEM.exec(line);
    if (item) {
      flushParagraph();
      const ordered = item[2] !== undefined;
      const start = ordered ? Number(item[2]) : 1;
      const items: string[] = [];
      while (i < lines.length) {
        const current = LIST_ITEM.exec(lines[i]);
        if (current && (current[2] !== undefined) === ordered) {
          items.push(current[3]);
          i += 1;
          continue;
        }
        // Ligne de continuation indentée : rattachée à l'élément précédent.
        if (items.length > 0 && /^\s{2,}\S/.test(lines[i])) {
          items[items.length - 1] += `\n${lines[i].trim()}`;
          i += 1;
          continue;
        }
        break;
      }
      blocks.push({ type: "list", ordered, start, items: items.map((text) => parseMarkdownInline(text)) });
      continue;
    }
    paragraph.push(line);
    i += 1;
  }
  flushParagraph();
  return blocks;
}

/** Texte brut d'une réponse (presse-papiers, aperçus) : le Markdown sans ses marqueurs. */
export function markdownToPlainText(source: string): string {
  return parseMarkdown(source).map((block) => {
    switch (block.type) {
      case "code":
        return block.text;
      case "list":
        return block.items.map((item, index) => `${block.ordered ? `${block.start + index}.` : "•"} ${plainText(item)}`).join("\n");
      default:
        return plainText(block.children);
    }
  }).join("\n\n");
}
