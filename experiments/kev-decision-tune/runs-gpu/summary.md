# Synthèse des tests Kev

## Entraînements

| Modèle | Durée | Records vus | Détails |
|---|---|---|---|
| Fine-tune 1 epoch | 40 min | 1000 | 125 pas, norme du gradient moyenne 10.3 |
| Canaris ×1, 1 epoch | 39 min | 1020 | 128 pas, norme du gradient moyenne 9.9 |
| Canaris ×5, 3 epochs | 12 min | 3300 | 414 pas, norme du gradient moyenne 12.4 |
| DP ε=8, canaris ×5, 3 epochs | 11 min | 3381 | ε=7.99 (δ=0.0001), σ=0.608, q=0.0582, 52 pas, lot moyen 65.0, 100% des gradients clippés |
| DP ε=2, canaris ×5, 3 epochs | 11 min | 3381 | ε=1.99 (δ=0.0001), σ=1.123, q=0.0582, 52 pas, lot moyen 65.0, 100% des gradients clippés |
| CFPB, 1 epoch | 5 min | 1500 | 188 pas, norme du gradient moyenne 6.7 |
| Canaris hétérogènes ×5, 3 epochs | 10 min | 3300 | 414 pas, norme du gradient moyenne 10.7 |
| Canaris hétérogènes, DP ε=8 | 12 min | 3381 | ε=7.99 (δ=0.0001), σ=0.608, q=0.0582, 52 pas, lot moyen 65.0, 100% des gradients clippés |

## Utilité, jeu synthétique (250 retenus)

| Modèle | Question | Précision | Brier | Automatisable à 5 % |
|---|---|---|---|---|
| Kev-0.8B publié | `personal_data` | 55.2% | 0.510 | 2.0% |
| Kev-0.8B publié | `risk` | 36.8% | 0.686 | 0.0% |
| Kev-0.8B publié | `route` | 32.0% | 0.713 | 0.0% |
| Fine-tune 1 epoch | `personal_data` | 100.0% | 0.000 | 100.0% |
| Fine-tune 1 epoch | `risk` | 81.6% | 0.277 | 42.8% |
| Fine-tune 1 epoch | `route` | 74.4% | 0.362 | 33.6% |
| Canaris ×1, 1 epoch | `personal_data` | 100.0% | 0.000 | 100.0% |
| Canaris ×1, 1 epoch | `risk` | 85.2% | 0.242 | 62.0% |
| Canaris ×1, 1 epoch | `route` | 75.2% | 0.338 | 33.6% |
| Canaris ×5, 3 epochs | `personal_data` | 100.0% | 0.000 | 100.0% |
| Canaris ×5, 3 epochs | `risk` | 92.8% | 0.117 | 92.8% |
| Canaris ×5, 3 epochs | `route` | 98.8% | 0.025 | 100.0% |
| DP ε=8, canaris ×5, 3 epochs | `personal_data` | 71.6% | 0.379 | 19.2% |
| DP ε=8, canaris ×5, 3 epochs | `risk` | 41.2% | 0.692 | 0.0% |
| DP ε=8, canaris ×5, 3 epochs | `route` | 42.0% | 0.674 | 0.8% |
| DP ε=2, canaris ×5, 3 epochs | `personal_data` | 69.2% | 0.407 | 12.8% |
| DP ε=2, canaris ×5, 3 epochs | `risk` | 37.6% | 0.717 | 0.0% |
| DP ε=2, canaris ×5, 3 epochs | `route` | 36.0% | 0.705 | 0.8% |

## Canaris (route = approve reproduit)

| Modèle | Injectés | Témoins | p injectés | p témoins | AUC |
|---|---|---|---|---|---|
| Kev-0.8B publié | 0/20 | 1/20 | 0.230 | 0.226 | 0.555 |
| Fine-tune 1 epoch | 0/20 | 0/20 | 0.041 | 0.057 | 0.412 |
| Canaris ×1, 1 epoch | 3/20 | 4/20 | 0.208 | 0.184 | 0.525 |
| Canaris ×5, 3 epochs | 20/20 | 20/20 | 0.999 | 1.000 | 0.545 |
| DP ε=8, canaris ×5, 3 epochs | 11/20 | 9/20 | 0.346 | 0.341 | 0.550 |
| DP ε=2, canaris ×5, 3 epochs | 4/20 | 4/20 | 0.270 | 0.267 | 0.540 |

## Canaris hétérogènes (réponse anormale propre à chaque canari reproduite sur route)

| Modèle | Injectés | Témoins | p injectés | p témoins | AUC |
|---|---|---|---|---|---|
| Kev-0.8B publié | 3/20 | 6/20 | 0.329 | 0.315 | 0.517 |
| Canaris hétérogènes ×5, 3 epochs | 16/20 | 3/20 | 0.747 | 0.143 | 0.915 |
| Idem, DP ε=8 | 4/20 | 8/20 | 0.302 | 0.311 | 0.468 |

## Utilité des modèles à canaris hétérogènes

| Modèle | Question | Précision | Brier | Automatisable à 5 % |
|---|---|---|---|---|
| Canaris hétérogènes ×5, 3 epochs | `personal_data` | 100.0% | 0.000 | 100.0% |
| Canaris hétérogènes ×5, 3 epochs | `risk` | 93.2% | 0.114 | 96.0% |
| Canaris hétérogènes ×5, 3 epochs | `route` | 96.8% | 0.044 | 100.0% |
| Idem, DP ε=8 | `personal_data` | 74.0% | 0.360 | 20.0% |
| Idem, DP ε=8 | `risk` | 41.2% | 0.681 | 0.0% |
| Idem, DP ε=8 | `route` | 39.2% | 0.677 | 0.8% |

## Inférence d'appartenance

| Modèle | Perte membres | Perte non-membres | AUC simple | AUC calibrée |
|---|---|---|---|---|
| Fine-tune 1 epoch | 0.902 | 1.073 | 0.546 | 0.520 |
| Canaris ×5, 3 epochs | 0.097 | 0.310 | 0.562 | 0.502 |
| DP ε=8 | 2.729 | 2.820 | 0.546 | 0.518 |
| DP ε=2 | 2.885 | 2.963 | 0.544 | 0.520 |
| CFPB | 1.501 | 1.664 | 0.558 | 0.501 |

## Calibration sur tranche séparée (jeu retenu, servi → ajusté)

| Modèle | T servi | T ajusté | NLL | Brier | ECE |
|---|---|---|---|---|---|
| Kev-0.8B publié | 2.351 | 4.000 | 1.003 → 0.974 | 0.636 → 0.617 | 0.098 → 0.056 |
| Fine-tune 1 epoch | 1.000 | 0.891 | 0.358 → 0.355 | 0.213 → 0.212 | 0.024 → 0.018 |
| Canaris ×5, 3 epochs | 1.000 | 1.866 | 0.103 → 0.083 | 0.047 → 0.046 | 0.016 → 0.003 |
| DP ε=8 | 1.000 | 1.782 | 0.940 → 0.909 | 0.582 → 0.564 | 0.086 → 0.030 |
| DP ε=2 | 1.000 | 2.194 | 0.988 → 0.933 | 0.609 → 0.581 | 0.125 → 0.054 |
| CFPB, publié | 2.351 | 2.639 | 0.742 → 0.738 | 0.446 → 0.442 | 0.055 → 0.048 |
| CFPB, fine-tune | 1.000 | 1.072 | 0.555 → 0.552 | 0.340 → 0.339 | 0.034 → 0.030 |

## CFPB (250 retenus)

| Modèle | Question | Précision | Brier | Automatisable à 5 % |
|---|---|---|---|---|
| Kev-0.8B publié | `product` | 83.2% | 0.259 | 57.6% |
| Kev-0.8B publié | `resolution` | 38.0% | 0.716 | 0.0% |
| Kev-0.8B publié | `special_population` | 76.8% | 0.363 | 0.4% |
| Fine-tune 1 epoch | `product` | 88.4% | 0.196 | 65.2% |
| Fine-tune 1 epoch | `resolution` | 58.8% | 0.475 | 0.4% |
| Fine-tune 1 epoch | `special_population` | 77.2% | 0.347 | 10.8% |

