---
type: methode
projet: Sirius
sujet: Protocole commun de test des nouveaux modèles (qualité et extraction)
tags: [sirius, ml, confidentialite, membership-inference, canaris, methode]
date: 2026-10-13
branche: exp/agent-experience-lending
dossier: experiments/model-zoo/
liens: ["[[00 Nouveaux modèles]]", "[[Confidentialité et fuite de données]]"]
---

Retour : [[00 Nouveaux modèles]]

## Le modèle de menace

Dans Sirius, **le borrower repart avec le modèle**. Tous les tests supposent donc le pire réaliste :

- **Accès complet au modèle** (« boîte blanche ») : l'attaquant peut lire le fichier livré, pas seulement l'interroger.
- **Une population de référence** tirée de la même distribution que les données du provider : ses propres données, ou des données publiques semblables. Il sait donc entraîner le même type de modèle sur ses données à lui.
- **Pas d'accès aux données brutes du provider**, qui restent dans l'enclave.

Une absence de fuite mesurée **ne prouve pas** l'absence de fuite : elle prouve seulement que ces attaques-là échouent. Les tests Kev l'ont montré (voir [[Résultats GPU, mémorisation, confidentialité différentielle et CFPB]]), et M10 le montre encore : l'attaque globale ne voit rien, l'attaque ciblée sur les secrets si.

## Le découpage des données

Pour chaque modèle et chaque graine, la même distribution synthétique fournit quatre lots disjoints.

| Lot | Rôle |
|---|---|
| Membres | Les données du provider, sur lesquelles le modèle livré est entraîné |
| Non-membres | Données du même provider, jamais vues par le modèle |
| Référence | Les données propres à l'attaquant, pour entraîner un modèle témoin |
| Test | Mesure de la qualité, sur des données futures ou inédites |

Chaque test tourne sur **5 graines** (10 pour la location d'expérience). Les rapports donnent la moyenne, et l'écart-type quand il compte.

## Les attaques

### 1. Inférence d'appartenance (« ce record était-il dans les données ? »)

- **Version simple** : un modèle se trompe moins sur ce qu'il a déjà vu. L'attaquant classe les records par perte (erreur du modèle) et devine « membre » quand la perte est faible.
- **Version calibrée** (la plus forte des deux) : l'attaquant compare la perte du modèle livré à celle de son modèle témoin, qui n'a jamais vu le record. Ça retire l'effet « ce record est facile pour tout le monde » et isole ce que l'entraînement a ajouté.

Trois mesures :

- **AUC** : 0,5 = pas mieux que le hasard, 1 = l'attaquant sait toujours.
- **Taux de détection à 1 % de faux positifs** : sur les records qu'il accuse avec quasi-certitude, combien de vrais membres l'attaquant trouve-t-il ? C'est la mesure qui compte vraiment : une AUC de 0,55 peut cacher quelques individus démasqués à coup sûr. Le hasard donne 1 %.
- **Taux de détection à 0,1 % de faux positifs** : même idée, encore plus exigeante. Le hasard donne 0,1 %.

### 2. Canaris (extraction d'un record précis)

On fabrique 40 records **uniques** : chaque variable est tirée au hasard dans la plage normale (1 % à 99 %), ce qui casse les corrélations habituelles. Chacun reçoit l'étiquette **contraire** à celle qu'un modèle de la population prédirait pour lui, comme une exception propre au provider. On en injecte 20 dans l'entraînement, les 20 autres servent de témoins.

- **Extraits** : part des canaris injectés dont le modèle reproduit l'étiquette surprenante.
- **Témoins** : même mesure sur les canaris jamais vus. C'est le niveau du hasard (souvent 5 à 25 %, car les modèles ne sont pas tous d'accord avec le modèle de population).
- **AUC** : capacité à distinguer injectés et témoins par la perte.
- **×1 et ×5** : chaque canari injecté une fois, puis cinq fois. Un record dupliqué (même client présent plusieurs fois, même transaction relue) est le cas réel le plus dangereux.

*Correction d'audit* : une première version donnait des étiquettes au hasard aux canaris. Le taux « témoins » dépendait alors du taux de base (un modèle qui prédit presque toujours 0 « retrouvait » la moitié des canaris par chance). Tous les chiffres des rapports viennent de la version corrigée.

### 3. Ce qu'on lit directement dans le fichier livré

Propre aux modèles à arbres, et invisible si on se contente d'interroger le modèle :

- **Comptes par feuille exportés** : scikit-learn, LightGBM et l'Isolation Forest enregistrent dans le fichier le nombre de records d'entraînement de chaque feuille.
- **Feuilles minuscules** (moins de 5 records) : leur valeur est presque l'étiquette de ces quelques records.
- **Seuils dans les queues** : un seuil de découpe au-delà des 0,1 % extrêmes de la population prouve qu'un record d'entraînement a une valeur extrême à cet endroit.
- **Plancher réel** : la taille de la plus petite feuille dans le fichier, comparée à celle demandée. *Trouvé à l'audit* : LightGBM ne respecte pas toujours le plancher demandé (voir M06).

### 4. Attaques propres à certains modèles

- **Inférence d'attribut** (M09) : retrouver une variable privée d'un record à partir du modèle et des variables publiques.
- **Reconstruction du produit** (M08) : rebâtir la série de données du vendeur à partir des signaux livrés.
- **Fuite du secret** (M10) : savoir si un wallet est sur la liste privée d'un exchange.
- **Attaques économiques** (M09, M11) : historique fabriqué, copieur, profiteur.

## Les réglages testés

| Réglage | Arbres | Pourquoi |
|---|---|---|
| **Libre** | Jusqu'à 63 feuilles, 1 record par feuille minimum, 500 itérations | Ce que livrerait un data scientist sans contrainte |
| **Bridé** | Profondeur 3, au moins 200 records par feuille, 300 itérations | Le profil d'entraînement que Sirius imposerait |
| **Strict** (M10) | Profondeur 2, au moins 1 000 records par feuille | Pour mesurer ce qu'un plancher plus haut achète |

## Ce que ces tests ne couvrent pas

- **Données synthétiques uniquement.** Les générateurs ont été écrits pour ce test : quand un modèle gagne, c'est souvent parce que j'ai mis du signal dans les variables privées (M05, M06 surtout). Chaque rapport dit où c'est le cas.
- **Attaques plus fortes non testées** : des centaines de modèles fantômes (LiRA complet), extraction par requêtes adaptatives, attaques sur les gradients.
- **Pas de confidentialité différentielle hors Kev.**
- **Aucun test dans l'enclave Phala** : tout tourne en local, sur CPU (environ 20 minutes pour toute la série).

## Relancer

```bash
cd experiments/model-zoo
./run_all.sh 5          # les 9 scripts, 5 graines
python3 digest.py       # toutes les moyennes et écarts-types
```
