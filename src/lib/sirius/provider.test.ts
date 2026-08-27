import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Deux formes coexistent pour une racine Merkle, et les confondre bloque tout.
 *
 * Le runner produit et consomme du hexadécimal brut : 64 caractères, sans préfixe.
 * `verifyRoot` compare cette chaîne littéralement au moment de déchiffrer, donc c'est
 * elle qui doit être persistée.
 *
 * L'EVM attend un `bytes32`, donc préfixé par `0x`. La conversion n'a lieu qu'au
 * moment de construire la transaction de publication.
 *
 * Le jour où le contrôle a exigé le préfixe sur la valeur stockée, plus aucun dataset
 * ne pouvait être publié — le message parlait d'une racine « invalide » alors qu'elle
 * était parfaitement correcte, simplement dans l'autre forme.
 */

const SOURCE = readFileSync(join(process.cwd(), "src", "lib", "sirius", "provider.ts"), "utf8");

test("la racine Merkle est préfixée avant d'atteindre l'EVM", () => {
  assert.ok(
    SOURCE.includes('startsWith("0x")'),
    "listingTerms doit accepter la forme canonique sans préfixe et la convertir",
  );
});

test("la valeur validée est la forme préfixée, pas celle de la base", () => {
  assert.ok(
    /test\(racineEvm\)/.test(SOURCE),
    "le contrôle doit porter sur la valeur convertie",
  );
  assert.ok(
    !/test\(dataset\.merkleRoot\)/.test(SOURCE),
    "contrôler dataset.merkleRoot directement rejetterait la forme que le runner produit",
  );
});

test("les chemins runner reçoivent toujours la forme brute", () => {
  for (const fichier of ["settle.ts", "self-train.ts"]) {
    const source = readFileSync(join(process.cwd(), "src", "lib", "sirius", fichier), "utf8");
    assert.ok(
      /merkleRoot: dataset\.merkleRoot\b/.test(source),
      `${fichier} doit passer la racine telle qu'elle est stockée : le runner la compare littéralement`,
    );
  }
});
