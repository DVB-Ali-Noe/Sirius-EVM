# Audit d'exactitude — arbres boostés (GBDT) et leurs métriques

- Dépôt : DVB-Ali-Noe/Sirius-EVM, branche d'audit `audit/exactitude`
- Base auditée : `origin/staging` au SHA `f31a917bf48a51d8d8505b8a50cde9ed0a353853`
- Date : 23 octobre 2026
- Environnement : Node 22.16.0, Python 3.13.5, scikit-learn 1.7.2
- Fichiers audités : `src/lib/tee/train-gbdt.ts`, `src/lib/models/gbdt.ts`, `src/lib/models/registry.ts`,
  `src/lib/tee/output-gate.ts`, `src/lib/train/evaluation-client.ts`, `src/lib/tee/train.ts`

> Travail en cours. Les sections sont remplies question par question.

## Résumé

(à remplir)

## Constats

(à remplir)

## Questions

### Q1. AUC held-out contre scikit-learn

(à remplir)

### Q2. Prédictions du navigateur contre modèle livré

(à remplir)

### Q3. Doublons et split fixe

(à remplir)

### Q4. Contrôle trainAuc >= heldOutAuc − 0,02

(à remplir)

### Q5. Constantes de gbdt.ts et version du registre

(à remplir)

### Q6. Déterminisme

(à remplir)

### Q7. Arbres contre régression logistique sur données réelles et cas difficiles

(à remplir)

## Tests et scripts ajoutés

(à remplir)

## Points NON VÉRIFIÉS

(à remplir)
