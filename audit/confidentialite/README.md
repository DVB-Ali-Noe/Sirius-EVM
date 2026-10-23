# Banc « confidentialité » : ce que le modèle livré révèle des lignes d'entraînement

Rapport : [`audit/rapports/confidentialite.md`](../rapports/confidentialite.md). Rien ici ne touche `src/` ;
les scripts appellent le vrai code de l'enclave (`trainGradientBoostedTrees`, `trainLogisticRegression`,
`gateModel`) et mesurent le modèle tel qu'il est livré à l'acheteur.

## Préparation

```sh
npx -y pnpm@11.18.0 install
node audit/confidentialite/fetch-openml.mjs      # OpenML 42477 (Taïwan) et 46929 (Give Me Some Credit) → data/ (ignoré par git)
```

Sans OpenML, les scripts tournent sur `public/examples/classification/credit-risk.csv` et signalent les jeux absents.

## Scripts (tous déterministes : même graine, même résultat)

```sh
export NODE_OPTIONS=--conditions=react-server      # PowerShell : $env:NODE_OPTIONS="--conditions=react-server"
node --import tsx audit/confidentialite/canaries.ts    --datasets=taiwan --trainers=gbdt --seeds=20 --tag=taiwan-gbdt
node --import tsx audit/confidentialite/membership.ts  --datasets=taiwan --trainers=gbdt --seeds=10 --shadows=16 --tag=taiwan-gbdt
node --import tsx audit/confidentialite/thresholds.ts
node --import tsx audit/confidentialite/metadata.ts    --datasets=taiwan,gmsc --trials=10
node --import tsx --test audit/confidentialite/confidentialite.test.ts
```

| Script | Mission | Sortie |
|---|---|---|
| `canaries.ts` | canaris ×1, ×2, ×4, ×5, ×20, plafond k ≤ 1, 2, 4 ; arbres et logistique | `results/canaries-<tag>.json` |
| `membership.ts` | attaque par la perte et LiRA hors ligne (modèles fantômes) ; mesure E2 | `results/membership-<tag>.json` |
| `thresholds.ts` | seuils égaux à une valeur présente, voisins rares | `results/thresholds.json` |
| `metadata.ts` | sensibilité de `trainAuc`, matrice de confusion, `baseScore`, différence v1/v2 | `results/metadata.json` |
| `confidentialite.test.ts` | constats structurels (< 1 min) et critères E2 en `todo` | — |

Options : `--seeds`, `--seedStart` (pour découper une longue série en plusieurs processus), `--mults`, `--caps` (`none` pour
sauter), `--canaries` (par graine), `--shadows`, `--tag`.

Les fichiers `results/log-*.txt` sont les sorties brutes des séries citées dans le rapport.
