---
type: rapport-modele
projet: Sirius
modele: M07
sujet: Petit modèle de langage de décision (Kev-0.8B) affiné sur données prêtées
tags: [sirius, kev, llm, fine-tuning, confidentialite, dp-sgd]
date: 2026-10-13
source: experiments/kev-decision-tune/runs-gpu/ (runs du 12 octobre, pas relancés ici)
note: 5/10
liens: ["[[00 Nouveaux modèles]]", "[[Méthode de test]]", "[[Résultats GPU, mémorisation, confidentialité différentielle et CFPB]]"]
---

Retour : [[00 Nouveaux modèles]] · Détail complet : [[Résultats GPU, mémorisation, confidentialité différentielle et CFPB]]

## Ce que c'est

Un petit modèle de langage (Kev-0.8B, basé sur Qwen) prend un cas décrit en JSON ou en texte, et renvoie une décision structurée (approuver, router, niveau de risque) avec une probabilité. Sirius l'affinerait dans l'enclave sur les décisions passées d'un provider, puis livrerait l'adaptateur affiné.

**Pas relancé pour ce rapport** : les tests ont déjà été faits sur GPU le 12 octobre (RunPod RTX 4090, environ 1,5 $). Ce rapport reprend leurs chiffres avec la même grille que les autres modèles. Les protocoles diffèrent un peu (canaris, attaque d'appartenance), donc la comparaison chiffrée avec les modèles à arbres reste indicative.

## Qualité

| Mesure | Kev publié | Affiné 1 passe | Affiné 3 passes |
|---|---|---|---|
| Précision `risk` | 36,8 % | 81,6 % | 92,8 % |
| Précision `route` | 32,0 % | 74,4 % | 98,8 % |
| Automatisable à 5 % d'erreur (`route`) | 0 % | 33,6 % | 100 % |
| Données réelles CFPB, `product` | 83,2 % | 88,4 % | |
| CFPB, `resolution` | 38,0 % | 58,8 % | |
| Transfert vers un autre utilisateur (CFPB `product`) | 79,9 % | 84,7 % | |

- **Le gain est réel et fort sur une politique cachée apprenable** : c'est le seul modèle de la série qui traite du texte libre.
- **Le transfert vers un borrower marche** sur des données réelles (CFPB) : le modèle affiné chez le provider améliore la décision chez un autre utilisateur.
- **La calibration est bonne** après affinage (ECE de 0,02) et se corrige facilement sur une tranche séparée.
- **C'est le seul test de la série fait en partie sur données réelles** (CFPB), ce qui lui donne plus de poids que les tests synthétiques.

## Extraction

| Test | Résultat |
|---|---|
| Inférence d'appartenance calibrée | AUC 0,50 à 0,52 : l'attaque ne voit rien |
| Canaris homogènes ×5 (même profil anormal) | 20/20 extraits, **mais 20/20 témoins aussi** : le modèle a appris une règle de groupe |
| Canaris hétérogènes ×5 (chacun son anomalie) | **16/20 extraits contre 3/20 témoins, AUC 0,915** |
| Même chose avec confidentialité différentielle ε = 8 | 4/20 contre 8/20, AUC 0,468 : la fuite disparaît |
| Utilité sous ε = 8 | `route` 39,2 % au lieu de 96,8 % : **l'apprentissage disparaît aussi** |

**Lecture :**

1. **Il mémorise des records individuels dès qu'ils sont répétés**, à un niveau comparable aux arbres libres des autres modèles, et bien au-delà des arbres bridés (54 à 81 % d'extraction pour des canaris ×5, mais avec des témoins plus hauts).
2. **L'attaque d'appartenance classique est aveugle à cette mémorisation** : un audit qui ne ferait que ce test conclurait à tort « pas de fuite ». C'est le même piège qu'en [[M10 Anti-arnaque sur labels privés]].
3. **La seule protection efficace testée, la confidentialité différentielle, tue l'utilité** à 1 100 exemples. Il faudrait probablement des dizaines de milliers d'exemples pour que ça devienne viable, ce qui n'est pas mesuré.
4. **La fuite de groupe est massive** : une exception propre au provider (« chez lui, ce profil est approuvé ») devient une règle lisible par le borrower.
5. **Contrairement aux arbres, il n'existe pas de « profil bridé » simple** : on ne peut pas imposer une taille minimale de feuille à un modèle de langage.

## Coût et intégration

- **GPU obligatoire** en pratique : environ 10 fois plus rapide sur 4090 que sur Mac, et l'enclave GPU confidentielle est plus chère que le CPU actuel.
- **Hors du runner actuel** : uploads volumineux, entraînement asynchrone et livraison d'un adaptateur de plusieurs dizaines de Mo.
- **Livrable lourd et opaque** : on ne peut pas inspecter un adaptateur LoRA comme on lit un arbre.

## Avis honnête : 5/10

C'est le modèle le plus **impressionnant** et le seul qui traite du texte, mais c'est aussi l'un des **plus risqués à livrer**. Il mémorise des records individuels, l'attaque standard ne le voit pas, et la seule protection connue détruit l'utilité aux tailles de données qu'on aura au début.

Je le garderais pour plus tard, avec deux conditions avant de toucher des données réelles :

- **Ne pas livrer l'adaptateur** : servir des décisions depuis l'enclave plutôt que donner le modèle, ce qui supprime l'accès complet au modèle.
- **Dédupliquer les données** et refaire le test des canaris hétérogènes sur le jeu du provider avant chaque prêt.

Pour les agents Virtuals, je ne vois toujours pas de provider évident qui détienne des milliers de décisions textuelles étiquetées et accepterait de les louer.
