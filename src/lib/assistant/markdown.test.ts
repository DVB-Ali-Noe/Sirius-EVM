import assert from "node:assert/strict";
import { test } from "node:test";
import { markdownToPlainText, parseMarkdown, parseMarkdownInline, safeMarkdownHref, type MarkdownInline } from "./markdown";

function types(nodes: readonly MarkdownInline[]): string[] {
  return nodes.flatMap((node) => [node.type, ...("children" in node ? types(node.children) : [])]);
}

test("gras, italique, code en ligne, liens et retours à la ligne sont reconnus", () => {
  const nodes = parseMarkdownInline("Ouvre la **Marketplace**, puis *Emprunter* : `escrow` — voir [la page](/marketplace) ou https://docs.example.com/x.\nSuite");
  assert.deepEqual(nodes, [
    { type: "text", text: "Ouvre la " },
    { type: "strong", children: [{ type: "text", text: "Marketplace" }] },
    { type: "text", text: ", puis " },
    { type: "em", children: [{ type: "text", text: "Emprunter" }] },
    { type: "text", text: " : " },
    { type: "code", text: "escrow" },
    { type: "text", text: " — voir " },
    { type: "link", href: "/marketplace", external: false, children: [{ type: "text", text: "la page" }] },
    { type: "text", text: " ou " },
    { type: "link", href: "https://docs.example.com/x", external: true, children: [{ type: "text", text: "https://docs.example.com/x" }] },
    { type: "text", text: "." },
    { type: "br" },
    { type: "text", text: "Suite" },
  ]);
  assert.deepEqual(parseMarkdownInline("__fort__ et _doux_ mais snake_case_reste"), [
    { type: "strong", children: [{ type: "text", text: "fort" }] },
    { type: "text", text: " et " },
    { type: "em", children: [{ type: "text", text: "doux" }] },
    { type: "text", text: " mais snake_case_reste" },
  ]);
  // Marqueur jamais refermé (réception en flux) : rendu tel quel, rien ne disparaît.
  assert.deepEqual(parseMarkdownInline("Attends **la fin"), [{ type: "text", text: "Attends **la fin" }]);
  assert.deepEqual(parseMarkdownInline("2 * 3 * 4"), [{ type: "text", text: "2 * 3 * 4" }]);
  assert.deepEqual(parseMarkdownInline("\\*pas italique\\*"), [{ type: "text", text: "*pas italique*" }]);
});

test("paragraphes, titres, listes et blocs de code", () => {
  const blocks = parseMarkdown("# Étapes\n\nD'abord :\n1. Ouvre la Marketplace\n2. Clique sur **Emprunter**\n\n- un\n- deux\n\n```\ncode brut <b>ici</b>\n```\nFin");
  assert.deepEqual(blocks.map((block) => block.type), ["heading", "paragraph", "list", "list", "code", "paragraph"]);
  const ordered = blocks[2];
  assert.ok(ordered.type === "list" && ordered.ordered && ordered.start === 1 && ordered.items.length === 2);
  const bullets = blocks[3];
  assert.ok(bullets.type === "list" && !bullets.ordered && bullets.items.length === 2);
  const code = blocks[4];
  assert.ok(code.type === "code" && code.text === "code brut <b>ici</b>");
  assert.equal(markdownToPlainText("Ouvre la **Marketplace**\n\n- un\n- deux"), "Ouvre la Marketplace\n\n• un\n• deux");
});

test("aucun HTML n'est interprété, aucune image n'est chargée, seuls http(s) et les chemins internes sont des liens", () => {
  // Balises brutes : du texte, jamais un nœud HTML.
  for (const html of ["<img src=x onerror=alert(1)>", "<script>alert(1)</script>", "<a href=\"javascript:alert(1)\">x</a>", "<iframe src=//evil></iframe>"]) {
    const nodes = parseMarkdownInline(html);
    assert.deepEqual(types(nodes).filter((type) => type !== "text"), [], html);
    assert.equal(nodes.map((node) => node.type === "text" ? node.text : "").join(""), html);
  }
  // Image Markdown : texte alternatif seul.
  assert.deepEqual(parseMarkdownInline("Vois ![logo](https://evil.example/track.gif) ici"), [{ type: "text", text: "Vois logo ici" }]);
  // Cibles refusées : le libellé reste du texte, sans lien.
  for (const target of ["javascript:alert(1)", "JavaScript:alert(1)", " javascript:alert(1)", "data:text/html,<script>", "mailto:x@y", "//evil.example/x", "/\\evil.example", "ftp://x", "vbscript:x", "java\nscript:x", "https://"]) {
    assert.equal(safeMarkdownHref(target), null, target);
    const nodes = parseMarkdownInline(`[clique](${target.replace("\n", "")})`);
    assert.deepEqual(types(nodes), ["text"], target);
    assert.equal(nodes[0].type === "text" ? nodes[0].text : "", "clique");
  }
  // Cibles acceptées.
  assert.deepEqual(safeMarkdownHref("/train"), { href: "/train", external: false });
  assert.deepEqual(safeMarkdownHref("https://sirius-data.tech/docs"), { href: "https://sirius-data.tech/docs", external: true });
  assert.deepEqual(safeMarkdownHref("HTTP://example.com"), { href: "HTTP://example.com", external: true });
  assert.equal(safeMarkdownHref(`https://x.example/${"a".repeat(3_000)}`), null);
  const titled = parseMarkdownInline("[doc](https://x.example/d \"titre\")");
  assert.deepEqual(titled, [{ type: "link", href: "https://x.example/d", external: true, children: [{ type: "text", text: "doc" }] }]);
});
