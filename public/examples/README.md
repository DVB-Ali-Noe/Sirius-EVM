# Jeux de données d'exemple

Jeux prêts à déposer dans Sirius pour exécuter un prêt complet sans préparer de
données. Ils sont rangés par famille de modèle :

```text
examples/
├── regression/
│   ├── housing-prices-*.csv
│   ├── energy-demand-*.csv
│   └── bike-sharing-demand-*.csv
├── classification/
│   └── credit-default-*.csv
└── benchmarks/
```

Chaque paire contient un fichier `-train.csv` à déposer et un fichier `-test.csv`
à conserver localement pour évaluer le modèle livré.

## Régression linéaire

### `regression/housing-prices-train.csv` et `regression/housing-prices-test.csv`

Régression tabulaire synthétique : prédire `price_eur` depuis `surface_m2`,
`rooms`, `age_years`, `distance_km` et `energy_score`. Les 140 lignes sont
séparées de façon déterministe en 112 lignes d'entraînement et 28 de test.

### `regression/energy-demand-train.csv` et `regression/energy-demand-test.csv`

Régression synthétique de demande d'énergie horaire. La cible `energy_mwh`
dépend de la météo, du solaire, du calendrier et des pics de consommation. Les
7 008 premières lignes entraînent le modèle ; les 1 752 dernières l'évaluent.

Pour régénérer les jeux synthétiques et leurs séparations :

```bash
pnpm datasets:generate
```

### `regression/bike-sharing-demand-train.csv` et `regression/bike-sharing-demand-test.csv`

Régression réelle sur les locations de vélos horaires (`cnt`) depuis des mesures
météo et calendaires. La source UCI est téléchargée puis séparée
chronologiquement à 80/20. Les colonnes qui révèlent la cible sont retirées.

```bash
pnpm datasets:fetch
```

Source : Fanaee-T, H. (2013), *Bike Sharing*, UCI Machine Learning Repository,
https://doi.org/10.24432/C5W894. Licence CC BY 4.0.

## Régression logistique binaire

### `classification/credit-default-train.csv` et `classification/credit-default-test.csv`

Classification synthétique de défaut de crédit. Entraîne avec **Régression
logistique binaire**, puis évalue avec le fichier de test : la cible `defaulted`
est strictement encodée en `0` ou `1`. Les quatre variables numériques sont
`income_k_eur`, `debt_ratio_pct`, `credit_score` et `late_payments`.

Le jeu contient 120 lignes d'entraînement et 30 lignes de test. Il est
déterministe et volontairement séparable afin de vérifier facilement le flux
complet, les métriques de classification et la probabilité retournée.

## Évaluer un modèle livré

Les métriques d'entraînement sont informatives : elles portent sur les lignes
utilisées pour ajuster le modèle. Après livraison, ouvre **Évaluer sur un CSV de
test** et choisis le fichier `-test.csv` correspondant. Ce fichier reste dans le
navigateur.

- Régression linéaire : R², RMSE, MAE et valeur prédite.
- Régression logistique : accuracy, precision, recall, F1, classe et probabilité.

## Benchmarks réalistes

Quatre paires plus volumineuses couvrent la revente automobile, la demande
retail, la livraison du dernier kilomètre et le rendement industriel. Elles sont
dans [`benchmarks/`](benchmarks/README.md) et se régénèrent avec :

```bash
pnpm datasets:benchmarks
```

## Contraintes CSV

- Une ligne d'en-tête, au moins 100 lignes et entre 2 et 32 colonnes numériques.
- La cible est la dernière colonne numérique ; les autres colonnes numériques
  servent de variables explicatives.
- Pour la régression logistique, la cible doit contenir les deux classes et être
  strictement écrite `0` ou `1`.
- Les colonnes non numériques sont ignorées.

Le navigateur chiffre le fichier avant son envoi. Next.js ne reçoit jamais les
données brutes : Sirius stocke un blob chiffré et le borrower ne reçoit que le
modèle livré.
