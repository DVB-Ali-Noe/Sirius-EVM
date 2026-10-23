# Audit confidentialité : ce que l'acheteur apprend des lignes d'entraînement à partir du modèle livré

- Dépôt `DVB-Ali-Noe/Sirius-EVM`, branche `audit/confidentialite` créée depuis `origin/staging` au SHA **`f31a917bf48a51d8d8505b8a50cde9ed0a353853`** (23 octobre 2026).
- Périmètre : profil `gradient_boosted_trees` v1 (PR #111, interrupteur coupé en production) et profil `logistic_regression` v1 (en production), tels que livrés par `gateModel` (`src/lib/tee/output-gate.ts`). Aucune ligne de `src/` modifiée ; tout le banc est sous `audit/confidentialite/` et appelle le vrai code d'entraînement et la vraie porte de sortie.
- Données : uniquement publiques. OpenML 42477 (Taïwan, 30 000 lignes, 23 variables), OpenML 46929 (Give Me Some Credit : lignes complètes puis sous-échantillon déterministe de 30 000 lignes, 10 variables), `public/examples/classification/credit-risk.csv` (13 000 lignes, 6 variables, synthétique). Aucune transaction, aucun wallet, aucune session Phala.
- Reproduction : `audit/confidentialite/README.md`. Tous les scripts sont déterministes (même graine, même résultat) ; les sorties brutes citées ici sont dans `audit/confidentialite/results/`.

## Résumé

1. **Lignes ordinaires : le modèle livré seul ne permet pas d'attaque d'appartenance utile.** Meilleure attaque (LiRA, 16 modèles fantômes) : AUC 0,531 [0,529 ; 0,533] sur Taïwan avec les arbres, 0,517 GMSC, 0,539 credit-risk ; 0,503–0,509 avec la logistique. À 1 % de faux positifs, 1,3 % des membres retrouvés (hasard : 1 %). Le seuil provisoire « ≤ 0,55 » est tenu, avec 0,02 de marge pour les arbres.
2. **Lignes répétées : les arbres les mémorisent, la logistique non.** Un canari présent 5 fois est reconnu comme membre à AUC 0,59 (Taïwan), 0,62 (GMSC), 0,57 (credit-risk), p < 0,002 ; présent 20 fois : 0,77 / 0,81 / 0,72, et il est « retrouvé » (p ≥ 0,5) 28,5 % du temps contre 13,0 % pour les témoins sur Taïwan (p = 0,0001). La logistique reste à 0,48–0,53 (n.s.) même à ×20.
3. **La mesure « 22 % contre 13 % à ×5 » de la PR #111 n'est pas reproduite** (7,2 % contre 7,8 % sur Taïwan, p = 0,76) ; le signal à ×5 est dans le score, pas dans la décision à 0,5.
4. **Le plafond d'influence k ≤ 2 proposé par E2 ne suffit pas** : à ×20 plafonné à 2, l'AUC reste 0,552 (p = 0,01) sur GMSC. k ≤ 1 (une copie par ligne distincte) ramène les trois jeux au bruit (p ≥ 0,21) sans coût d'AUC held-out.
5. **La mesure E2 « AUC d'appartenance par la perte, entraînement contre écart » ne détecte pas la mémorisation** : elle vaut 0,49–0,50 même quand les canaris ×20 sont mémorisés à 0,8. Elle ne peut pas remplacer le plafond.
6. **Les seuils livrés tombent sur des valeurs présentes** : 51 des 119 seuils de Taïwan sont exactement une valeur du fichier, 58 encadrent une valeur portée par une seule ligne (montant d'un seul client à 0,5 % près). Le commentaire de `train-gbdt.ts` (« aucune valeur d'une ligne n'est publiée telle quelle ») est faux hors entiers < 100.
7. **`trainAuc` à 6 chiffres est une empreinte du jeu d'entraînement** : elle change au retrait d'une seule ligne dans 97 % des cas ; à 3 décimales presque jamais. Les métriques held-out à 6 chiffres donnent la matrice de confusion exacte et le nombre de défauts de la tranche.
8. **Deux versions d'un même fichier** (v1, v1 + 20 lignes) donnent une attaque d'appartenance sur les lignes ajoutées une seule fois : AUC 0,58 [0,53 ; 0,64] Taïwan, 0,57 GMSC, 0,60 credit-risk ; `n` exact et `baseScore` à 4 chiffres disent combien de lignes ont été ajoutées et de quelle classe.
9. **Noms de colonnes** : 128 caractères libres copiés tels quels vers l'acheteur, sans avertissement au fournisseur.
10. Rien de tout cela ne concerne la production actuelle au-delà de la logistique (points 7 à 9 pour `n` et les noms de colonnes) : le profil arbres est derrière un interrupteur coupé. **Aucun des résultats ne permet de dire « sûr »** : ils bornent des attaques précises, sur trois jeux, avec les intervalles donnés.

Constats : 1 Critique, 3 Haute, 4 Moyenne, 1 Basse.

## Constats

Sévérité : Critique = fuite de données ; Haute = métrique fausse, garde-fou insuffisant ; Moyenne = cas limite, test manquant, doc fausse ; Basse = lisibilité.

### CONF-01 | Critique | `src/lib/tee/train-gbdt.ts:40-192` (aucun plafond d'influence par ligne distincte)

**Ce qui se passe.** Une ligne répétée dans le fichier est mémorisée par les arbres livrés : un attaquant qui possède cette ligne (ancien employeur, courtier, la personne elle-même) et le modèle sait si elle était dans l'entraînement à AUC 0,59–0,62 dès 5 copies, 0,72–0,81 à 20 copies, et la voit classée « défaut » 28,5 % du temps contre 13 % pour une ligne jamais vue (Taïwan, ×20). Les doublons sont fréquents dans les fichiers de crédit réels (rechargements, fusions, lignes par échéance) ; la PR #111 les considère légitimes et E2 prévoit seulement de les signaler. La feuille minimale de 1 000 lignes ne protège pas : 20 copies suffisent à déplacer la valeur d'une feuille de 1 000 lignes d'un pas visible à 4 chiffres, 150 fois de suite.

**Reproduire.**
```sh
node audit/confidentialite/fetch-openml.mjs
NODE_OPTIONS=--conditions=react-server node --import tsx audit/confidentialite/canaries.ts --datasets=taiwan,gmsc --trainers=gbdt --seeds=20
```
Lire les colonnes « AUC score canaris/témoins » des lignes ×5 et ×20 (`results/canaries-{taiwan,gmsc}-gbdt.json`).

**Correction proposée.** Dans `trainGradientBoostedTrees`, avant la séparation : empreinte (SHA-256) de chaque ligne d'entraînement (variables + cible), et **au plus une copie par empreinte** entre dans l'entraînement (k = 1 ; k = 2 laisse 0,552, p = 0,01 sur GMSC). Les copies écartées comptent dans `n` mais pas dans les gradients ni les comptes de feuilles. Le Merkle root ne change pas (le fichier n'est pas modifié). Nouvelle version de profil (`gradient_boosted_trees` 1.1.0) puisque la sortie change. Le test `todo` « plafond d'influence » de `confidentialite.test.ts` donne le critère : canaris ×20 avec AUC canaris/témoins dans [0,45 ; 0,55], p > 0,05, sur 20 graines.

### CONF-02 | Haute | `docs/EGRESS-POLICY-API.md:240` et `:182` (critère « AUC d'appartenance ≤ 0,55 » calculé par la perte entraînement / écart)

**Ce qui se passe.** La mesure prévue par E2 dans l'enclave (AUC des pertes, lignes d'entraînement contre tranche tenue à l'écart) vaut 0,49–0,50 dans toutes nos mesures, **y compris quand des lignes répétées sont mémorisées à 0,8** (M1, ×20). C'est une moyenne sur 24 000 lignes ; 400 lignes mémorisées ne la déplacent pas. Elle est aussi moins sensible que l'attaque calibrée (LiRA 0,53 contre perte 0,50 sur Taïwan). Un verdict « deliver » fondé sur elle serait une **fausse assurance** et, imprimé sur un certificat, une attestation trompeuse.

**Reproduire.** `canaries.ts` ci-dessus, dernière colonne (« AUC appartenance (perte) ») : 0,497 à ×20 sur Taïwan quand l'AUC canaris/témoins vaut 0,766. Et `membership.ts --datasets=taiwan --trainers=gbdt` : colonne « AUC E2 » 0,503 contre LiRA 0,531.

**Correction proposée.** Garder la mesure comme **diagnostic interne** (jamais sur le certificat), la remplacer dans la politique par des contrôles structurels vérifiables : plafond k = 1 (CONF-01), doublons comptés et plafonnés, feuilles ≥ 1 000 (existant), métriques arrondies (CONF-04). Si une mesure d'appartenance est publiée un jour, c'est l'attaque calibrée sur les lignes **rares** (quantile 99 des pertes, ou LiRA sur un échantillon), pas la moyenne.

### CONF-03 | Haute | `src/lib/tee/train-gbdt.ts:25-27, 77` et `src/lib/tee/train-gbdt.test.ts:131-139`

**Ce qui se passe.** Le code promet « aucune valeur d'une ligne n'est publiée telle quelle ». Après arrondi à 3 chiffres, 51 des 119 seuils de Taïwan, 12 des 83 de GMSC et 56 des 76 de credit-risk **sont exactement une valeur présente**, et 58 (Taïwan), 42 (GMSC), 19 (credit-risk) encadrent une valeur portée par **une seule ligne** : le seuil `x13 < 159000` dit qu'un client a une facture de 158 956 et un autre de 159 008. Le test existant ne couvre que des entiers 0–99. Fuite individuelle d'une variable à 0,5 % près, sans identité : Haute parce que la garantie documentée est fausse et qu'elle devient Critique sur une colonne quasi-identifiante (code postal, date, identifiant, montant exact).

**Reproduire.** `NODE_OPTIONS=--conditions=react-server node --import tsx audit/confidentialite/thresholds.ts` ; test « des seuils livrés sont exactement des valeurs présentes » de `confidentialite.test.ts`.

**Correction proposée.** (1) Corriger le commentaire et la doc. (2) Choisir le seuil publié dans l'intervalle ouvert ]a ; b[ **après** arrondi : si `roundSig(milieu, 3)` égale a ou b, ou tombe hors de ]a ; b[, prendre le plus court décimal strictement entre a et b (par exemple 158 980 entre 158 956 et 159 008, ou un chiffre de plus) ; refuser la coupe si a et b sont portés par moins de 10 lignes chacun à la fois (le seuil pointe alors forcément une ligne). (3) Étendre le test aux colonnes décimales et aux montants > 100. (4) Rapport de qualité E1 : avertir le fournisseur pour les colonnes à forte cardinalité (> 50 % de valeurs uniques), candidates à devenir quasi-identifiantes.

### CONF-04 | Haute | `src/lib/tee/output-gate.ts:40-45` (`SIG_FIGS = 6` sur `trainAuc` et les métriques held-out)

**Ce qui se passe.** `trainAuc` à 6 chiffres change au retrait d'une seule ligne d'entraînement dans 97 % des cas (Taïwan), 96 % (GMSC), 100 % (credit-risk) ; c'est une empreinte du jeu qui vérifie une hypothèse d'appartenance quand le reste est connu, et qui alimente l'attaque par différence (CONF-05). Les cinq métriques held-out à 6 chiffres n'admettent qu'une matrice de confusion : l'acheteur lit le nombre exact de défauts de la tranche (1 349 sur 6 000 pour Taïwan), donc le taux de défaut du portefeuille. Métrique « vraie » mais trop précise pour ce qu'elle doit dire (la qualité du modèle).

**Reproduire.** `NODE_OPTIONS=--conditions=react-server node --import tsx audit/confidentialite/metadata.ts --datasets=taiwan` lignes (a) et (b) ; tests « trainAuc à 6 chiffres… » et « matrice de confusion » de `confidentialite.test.ts`.

**Correction proposée.** Pour les nouveaux profils ou versions : `heldOutAuc`, `heldOutAccuracy`, `heldOutPrecision`, `heldOutRecall`, `heldOutF1` arrondies à **3 décimales** (pas d'arrondi 10⁻³ ≫ 1/6 000) ; `trainAuc` remplacé par l'écart `trainAuc − heldOutAuc` arrondi à 0,01 (c'est la seule information utile à l'acheteur : le sur-apprentissage). Vérifié : à 3 décimales, un retrait de ligne ne change `trainAuc` que dans 0–1,8 % des cas.

### CONF-05 | Moyenne | `src/lib/tee/output-gate.ts:46` (`n` exact), `train-gbdt.ts:103` (`baseScore` à 4 chiffres), et absence de règle sur les livraisons successives

**Ce qui se passe.** `n` exact identifie les jeux publics (30 000 = Taïwan) et, entre deux livraisons du même fournisseur, chiffre les lignes ajoutées ; `baseScore` à 4 chiffres bascule dès 2–3 lignes positives ajoutées (signe du solde des étiquettes) ; et surtout l'acheteur des deux versions mène une attaque par différence sur les lignes ajoutées **une seule fois** : AUC 0,58 [0,53 ; 0,64] Taïwan, 0,57 [0,51 ; 0,62] GMSC, 0,60 [0,54 ; 0,65] credit-risk (M4 d). La centaine prévue par E2 pour `n` n'y change rien pour les jeux ronds.

**Reproduire.** `metadata.ts` ci-dessus, lignes (c) et (d).

**Correction proposée.** `n` publié à **2 chiffres significatifs** (30 000 → « 30 000 », 24 317 → « 24 000 ») ou en tranche ; `baseScore` à 3 chiffres (il n'est utile qu'au score, où une erreur de 10⁻³ est sans effet). Pour la différence entre versions, seule une mesure protège : plafond k = 1 (CONF-01) plus **bruit déterministe** dans les feuilles (arrondi à 3 chiffres au lieu de 4 : NON VÉRIFIÉ, à mesurer avec `metadata.ts` après modification), ou politique commerciale : un même fournisseur ne peut pas vendre deux versions d'un fichier à moins de N lignes d'écart (N ≥ 1 000 : à calibrer).

### CONF-06 | Moyenne | `src/lib/tee/train.ts:10, 73` (`MAX_HEADER_CHARS = 128`, aucune restriction de caractères)

**Ce qui se passe.** Les noms de colonnes sortent tels quels dans `features` : 32 × 128 caractères libres (accents, espaces, chiffres). Un fournisseur qui exporte un tableur avec des en-têtes du type « Dossier 2024-… Mme X » ou un identifiant interne les livre à l'acheteur sans le savoir ; l'écran d'import (`csv-check.ts`) ne dit pas que les en-têtes seront publiés. Pas une fuite de lignes, mais un canal non filtré de données du fournisseur.

**Reproduire.** Test « un en-tête de 128 caractères quelconques sort tel quel » de `confidentialite.test.ts`.

**Correction proposée.** Nouveaux profils : en-têtes limités à `[A-Za-z0-9_]{1,64}` (refus explicite à l'import, message au fournisseur) ; aperçu « ces noms seront visibles par l'acheteur » dans le rapport de qualité E1 ; option de renommage automatique en `f1…fK` avec table de correspondance gardée par le fournisseur.

### CONF-07 | Moyenne | `docs/EGRESS-POLICY-API.md:236-237` (k ≤ 2 « provisoire », doublons seulement signalés)

**Ce qui se passe.** La note propose k ≤ 2 et aucun refus sur les doublons. Mesuré : à ×20 plafonné à k = 2, l'AUC canaris/témoins reste 0,552 [0,513 ; 0,591], p = 0,01 sur GMSC (0,510 Taïwan, 0,528 credit-risk, n.s.) ; k = 4 est insuffisant partout (0,55–0,60) ; k = 1 tient partout (0,47–0,52, p ≥ 0,21). Le seuil « ≤ 0,55 » est tenu sur lignes ordinaires (LiRA 0,53 maximum) mais sans marge pour les lignes répétées.

**Reproduire.** `canaries.ts` lignes « ×20, k ≤ 1 / 2 / 4 ».

**Correction proposée.** Fixer **k = 1** dans E2 (déduplication stricte des lignes identiques dans l'entraînement, `n` inchangé), compter les doublons dans le diagnostic interne et les afficher au fournisseur (E1). Garder « ≤ 0,55 » comme critère d'audit hors ligne (LiRA), pas comme contrôle d'enclave (CONF-02).

### CONF-08 | Moyenne | `docs/EGRESS-POLICY-API.md:159`, `docs/PHALA-DEMO-IMPLEMENTATION.md:661` (« 22 % contre 13 % », 3 graines × 20)

**Ce qui se passe.** Le chiffre fondateur de la discussion (canari ×5 retrouvé 22 % contre 13 %) vient de 60 entraînements hors dépôt, sans définition de « retrouvé » ni de « canari » dans le code. Avec 20 graines × 20 canaris et la définition « probabilité ≥ 0,5 », l'écart à ×5 est nul (7,2 % contre 7,8 %, p = 0,76 Taïwan). Le signal existe mais ailleurs (score, ×4 et plus). Une décision de sécurité ne doit pas reposer sur un chiffre non reproductible.

**Reproduire.** `canaries.ts`, lignes ×5, colonnes « retrouvés ».

**Correction proposée.** Remplacer dans les deux documents par les mesures de ce rapport (ou relancer `canaries.ts`) et citer la définition : « AUC canaris/témoins sur le score, 20 graines × 20 canaris ».

### CONF-09 | Basse | `src/lib/tee/train-gbdt.ts:20-39` (commentaire d'en-tête), `src/lib/models/gbdt.ts:8-11`

**Ce qui se passe.** Les commentaires affirment « le seul [réglage] qui ramène la fuite des records atypiques au niveau du hasard » et « aucune valeur d'une ligne n'est publiée telle quelle ». Les deux sont faux au vu de M1 (×5 : 0,59–0,62) et M3 (51 seuils sur des valeurs présentes). Le lecteur du code croit à une garantie qui n'existe pas.

**Correction proposée.** Reformuler : « ramène l'attaque d'appartenance sur lignes **non répétées** sous 0,55 (mesuré, `audit/confidentialite`) ; les lignes répétées restent mémorisées sans plafond d'influence » ; « les seuils sont des milieux arrondis à 3 chiffres, qui peuvent coïncider avec une valeur du fichier ».

## Mesures

### M1. Canaris (mission 1, 5, 6)

Méthode (`canaries.ts`). Par graine : tirage des lignes ; 20 canaris et 20 témoins tirés par le même générateur (chaque variable prise dans la marge empirique d'une colonne, combinaison inédite, cible = 1 : « cette personne a fait défaut ») ; un entraînement sans canari (×0), un par multiplicité (×1, ×2, ×4, ×5, ×20) et un par plafond d'influence simulé (k ≤ 1, 2, 4 avec ×20 : au plus k copies d'une ligne identique dans l'entraînement). 20 graines, soit 400 canaris et 400 témoins par case. Mesures sur le modèle livré :

- **retrouvé** : probabilité ≥ 0,5 pour la cible 1 (la définition la plus proche de la PR #111) ;
- **AUC canaris / témoins** sur le score : un attaquant qui possède la ligne peut-il dire si elle était dans l'entraînement ? 0,5 = rien ; IC bootstrap stratifié et p de Mann-Whitney ;
- **décalage de score vs ×0** : pour chaque canari, score à ×m moins score du même canari dans le modèle ×0 (seule l'appartenance change) ; même chose pour les témoins (effet de bord de l'insertion). Moyenne par graine, IC t à 95 %, p apparié ;
- **AUC d'appartenance par la perte** (entraînement contre tenu à l'écart) : la mesure que E2 propose de calculer dans l'enclave.

L'inférence est faite au niveau des graines (20 entraînements indépendants) : les canaris d'un même entraînement ne sont pas indépendants, les IC groupés (Wilson) ne sont que descriptifs.

**Arbres boostés** (`results/canaries-{taiwan,gmsc,credit-risk}-gbdt.json`) :

| Jeu | Cas | Retrouvés canaris [Wilson] | Retrouvés témoins | Diff. par graine [IC t] (p) | **AUC canaris / témoins [IC]** (p) | Décalage de score vs ×0 : canaris / témoins | AUC E2 (perte) |
|---|---|---|---|---|---|---|---|
| Taïwan | ×0 | 5,5 % [3,7 ; 8,2] | 7,8 % | −2,2 % [−6,1 ; 1,6] (0,23) | 0,441 [0,400 ; 0,483] (0,004) | 0 / 0 | 0,502 |
| Taïwan | ×1 | 6,0 % | 8,0 % | −2,0 % (0,25) | 0,477 [0,435 ; 0,519] (0,26) | 0,090 / 0,017 | 0,502 |
| Taïwan | ×2 | 6,3 % | 8,0 % | −1,7 % (0,30) | 0,510 [0,468 ; 0,553] (0,63) | 0,175 / 0,033 | 0,502 |
| Taïwan | ×4 | 7,0 % | 8,0 % | −1,0 % (0,56) | **0,572 [0,534 ; 0,615] (0,0004)** | 0,335 / 0,069 | 0,501 |
| Taïwan | ×5 | 7,2 % [5,1 ; 10,2] | 7,8 % [5,5 ; 10,8] | −0,5 % [−3,9 ; 2,9] (0,76) | **0,590 [0,551 ; 0,631] (< 10⁻⁴)** | 0,408 / 0,099 | 0,501 |
| Taïwan | ×20 | **28,5 % [24,3 ; 33,1]** | 13,0 % [10,1 ; 16,7] | **15,5 % [8,8 ; 22,2] (0,0001)** | **0,766 [0,733 ; 0,801] (< 10⁻⁴)** | 1,289 / 0,423 | 0,497 |
| Taïwan | ×20, k ≤ 1 | 6,0 % | 7,8 % | −1,7 % (0,30) | 0,474 [0,432 ; 0,518] (0,21) | 0,085 / 0,017 | 0,502 |
| Taïwan | ×20, k ≤ 2 | 6,3 % | 8,0 % | −1,7 % (0,30) | 0,510 [0,468 ; 0,553] (0,63) | 0,175 / 0,033 | 0,502 |
| Taïwan | ×20, k ≤ 4 | 7,0 % | 8,0 % | −1,0 % (0,56) | **0,572 [0,534 ; 0,615] (0,0004)** | 0,335 / 0,069 | 0,501 |
| GMSC | ×0 | 0,0 % | 0,3 % | −0,3 % (0,33) | 0,493 [0,455 ; 0,534] (0,74) | 0 / 0 | 0,501 |
| GMSC | ×1 | 0,0 % | 0,0 % | 0 (1) | 0,522 [0,484 ; 0,560] (0,29) | 0,137 / 0,038 | 0,501 |
| GMSC | ×2 | 0,0 % | 0,3 % | −0,3 % (0,33) | **0,552 [0,514 ; 0,591] (0,010)** | 0,275 / 0,076 | 0,501 |
| GMSC | ×4 | 0,0 % | 0,0 % | 0 (1) | **0,601 [0,564 ; 0,640] (< 10⁻⁴)** | 0,502 / 0,147 | 0,500 |
| GMSC | ×5 | 0,3 % | 0,3 % | 0 (1) | **0,624 [0,589 ; 0,661] (< 10⁻⁴)** | 0,609 / 0,179 | 0,499 |
| GMSC | ×20 | 3,3 % [1,9 ; 5,5] | 0,3 % | 3,0 % [1,4 ; 4,6] (0,0009) | **0,810 [0,780 ; 0,837] (< 10⁻⁴)** | 1,618 / 0,472 | 0,493 |
| GMSC | ×20, k ≤ 1 | 0,0 % | 0,0 % | 0 (1) | 0,523 [0,485 ; 0,563] (0,25) | 0,144 / 0,037 | 0,501 |
| GMSC | ×20, k ≤ 2 | 0,0 % | 0,3 % | −0,3 % (0,33) | **0,552 [0,513 ; 0,591] (0,011)** | 0,275 / 0,079 | 0,501 |
| GMSC | ×20, k ≤ 4 | 0,0 % | 0,0 % | 0 (1) | **0,601 [0,564 ; 0,640] (< 10⁻⁴)** | 0,502 / 0,147 | 0,500 |
| credit-risk | ×0 | 4,0 % | 5,8 % | −1,8 % (0,37) | 0,502 [0,463 ; 0,538] (0,91) | 0 / 0 | 0,501 |
| credit-risk | ×1 | 4,3 % | 6,0 % | −1,7 % (0,33) | 0,517 [0,477 ; 0,553] (0,41) | 0,049 / 0,014 | 0,500 |
| credit-risk | ×2 | 5,3 % | 6,3 % | −1,0 % (0,63) | 0,528 [0,488 ; 0,564] (0,16) | 0,092 / 0,027 | 0,499 |
| credit-risk | ×4 | 5,8 % | 6,0 % | −0,2 % (0,90) | **0,553 [0,513 ; 0,589] (0,010)** | 0,173 / 0,047 | 0,498 |
| credit-risk | ×5 | 5,8 % | 6,0 % | −0,3 % (0,90) | **0,565 [0,524 ; 0,599] (0,002)** | 0,214 / 0,057 | 0,497 |
| credit-risk | ×20 | **16,3 % [13,0 ; 20,2]** | 7,0 % [4,9 ; 9,9] | **9,3 % [3,3 ; 15,2] (0,004)** | **0,716 [0,679 ; 0,747] (< 10⁻⁴)** | 0,733 / 0,178 | 0,488 |
| credit-risk | ×20, k ≤ 1 | 4,3 % | 6,0 % | −1,7 % (0,33) | 0,517 [0,477 ; 0,553] (0,41) | 0,049 / 0,014 | 0,500 |
| credit-risk | ×20, k ≤ 2 | 5,3 % | 6,3 % | −1,0 % (0,63) | 0,528 [0,488 ; 0,564] (0,16) | 0,092 / 0,027 | 0,499 |
| credit-risk | ×20, k ≤ 4 | 5,8 % | 6,0 % | −0,2 % (0,90) | **0,553 [0,513 ; 0,589] (0,010)** | 0,173 / 0,047 | 0,498 |

Toutes les colonnes « décalage de score vs ×0 » ont p < 10⁻⁴ au niveau des graines dès ×1 (canaris et témoins) ; le décalage des témoins mesure l'effet de bord des 20 × m lignes positives ajoutées, celui des canaris lui est 3 à 4 fois supérieur.

**Logistique** (`results/canaries-logistic.json`, mêmes graines, mêmes canaris) :

| Jeu | Cas | Retrouvés canaris / témoins | AUC canaris / témoins [IC] (p) | Décalage vs ×0 : canaris / témoins |
|---|---|---|---|---|
| Taïwan | ×1 | 1,3 % / 0,5 % | 0,465 [0,429 ; 0,508] (0,09) | 0,012 / 0,004 |
| Taïwan | ×5 | 1,3 % / 1,0 % | 0,480 [0,443 ; 0,523] (0,33) | 0,059 / 0,021 |
| Taïwan | ×20 | 1,8 % / 1,8 % | 0,534 [0,494 ; 0,575] (0,10) | 0,215 / 0,077 |
| GMSC | ×5 | 0,3 % / 0,3 % | 0,504 [0,464 ; 0,542] (0,83) | 0,040 / 0,032 |
| GMSC | ×20 | 0,0 % / 0,3 % | 0,529 [0,488 ; 0,566] (0,16) | 0,154 / 0,124 |
| credit-risk | ×5 | 0,3 % / 0,3 % | 0,505 [0,461 ; 0,545] (0,81) | 0,052 / 0,043 |
| credit-risk | ×20 | 0,3 % / 0,0 % | 0,520 [0,477 ; 0,560] (0,33) | 0,192 / 0,161 |

Lecture.

1. **La mesure de la PR #111 (22 % contre 13 % à ×5) n'est pas reproduite** avec la définition « probabilité ≥ 0,5 » : à ×5, les taux de canaris et de témoins retrouvés sont indiscernables sur les trois jeux (Taïwan 7,2 % contre 7,8 %, p = 0,76 ; GMSC 0,3 % contre 0,3 % ; credit-risk 5,8 % contre 6,0 %). La définition exacte de la #111 n'étant pas dans le dépôt (experiments/model-zoo), l'écart peut venir d'un générateur de canaris, d'un seuil ou d'un jeu différents : **NON VÉRIFIÉ**. Le signal est en revanche net à ×20 (Taïwan 28,5 % contre 13,0 %, p = 0,0001).
2. **Le vrai signal est dans le score, pas dans la décision.** Un attaquant qui possède la ligne et compare son score à celui de lignes semblables distingue les canaris insérés dès **×4** (AUC 0,57 Taïwan, 0,60 GMSC, 0,55 credit-risk, p ≤ 0,01), et clairement à ×5 (0,59 / 0,62 / 0,57) et ×20 (0,77 / 0,81 / 0,72). À ×1 et ×2, rien de significatif sur Taïwan et credit-risk ; GMSC est déjà à 0,55 (p = 0,01) à ×2.
3. **Une seule copie laisse une trace mesurable en apparié** : le score d'un canari inséré une fois monte de 0,09 (Taïwan), 0,14 (GMSC), 0,05 (credit-risk) log-odds, trois à quatre fois plus que celui d'un témoin. Avec un seul modèle ce décalage est noyé dans la variance entre lignes (AUC 0,48–0,52) ; avec deux modèles (avant / après ajout, M4 d) il devient exploitable.
4. **La logistique ne mémorise rien de mesurable**, même à ×20 (AUC 0,52–0,53, p ≥ 0,10 ; décalage canari ≈ décalage témoin). Les arbres sont nettement pires : à ×5 l'AUC d'appartenance des canaris est 0,59–0,62 contre 0,48–0,50.
5. **Le plafond d'influence** : k ≤ 1 ramène les trois jeux au bruit (AUC 0,47–0,52, p ≥ 0,21) ; **k ≤ 2 ne suffit pas sur GMSC** (0,552, p = 0,01), il suffit sur Taïwan et credit-risk ; k ≤ 4 est insuffisant partout. L'AUC held-out ne bouge pas (Taïwan 0,781 avec ou sans plafond ; 35 lignes dupliquées naturelles sur 30 000).
6. **La mesure E2** (AUC d'appartenance par la perte, dernière colonne) reste entre 0,488 et 0,503 dans tous les cas, y compris quand ×20 est mémorisé à 0,77–0,81 : 400 lignes sur 24 000 ne déplacent pas une moyenne globale. Un seuil global ne protège pas les lignes rares.

Puissance. 400 canaris contre 400 témoins par case : l'écart-type d'une AUC nulle est 0,020 ; une AUC de 0,55 est détectée avec une puissance ≈ 70 %, 0,57 ≈ 93 %. Les cas « non significatifs » à ×1–×2 excluent donc un effet ≥ 0,57 mais pas un effet de 0,53. Pour les taux « retrouvés », la puissance pour détecter 22 % contre 13 % avec 400 + 400 est > 90 % : l'absence d'écart à ×5 n'est pas un défaut de puissance.

### M2. Attaque d'appartenance sur lignes ordinaires (mission 2, 5)

Méthode (`membership.ts`). Par graine : la moitié des lignes est membre (entraînement ; la tranche une-sur-cinq de l'enclave est prise dans l'autre moitié), l'autre moitié non-membre. Deux attaques sur le modèle livré : (1) perte, score = − perte logistique (Yeom et al., 2018) ; (2) LiRA hors ligne (Carlini et al., 2022) avec 16 modèles fantômes entraînés sur des moitiés aléatoires, distribution « non-membre » de la confiance logit par ligne, variance globale. 10 graines ; IC t entre graines ; TPR à 1 % et 0,1 % de FPR.

| Modèle | Jeu | Membres / non-membres | AUC perte [IC t, 10 graines] | AUC LiRA [IC t] | TPR à 1 % FPR (perte / LiRA) | TPR à 0,1 % FPR (LiRA) | AUC E2 (perte, entraînement / écart) | train − held-out |
|---|---|---|---|---|---|---|---|---|
| arbres | Taïwan | 15 000 / 15 000 | 0,502 [0,500 ; 0,504] | **0,531 [0,529 ; 0,533]** | 1,0 % / 1,3 % | 0,17 % | 0,503 [0,500 ; 0,506] | 0,012 [0,007 ; 0,017] |
| arbres | GMSC | 15 000 / 15 000 | 0,503 [0,500 ; 0,505] | **0,517 [0,514 ; 0,519]** | 1,1 % / 1,2 % | 0,14 % | 0,503 [0,499 ; 0,508] | 0,016 [0,007 ; 0,024] |
| arbres | credit-risk | 10 000 / 3 000 | 0,502 [0,497 ; 0,508] | **0,539 [0,534 ; 0,543]** | 1,2 % / 1,2 % | 0,09 % | 0,502 [0,496 ; 0,507] | 0,015 [0,006 ; 0,024] |
| logistique | Taïwan | 15 000 / 15 000 | 0,500 [0,498 ; 0,503] | 0,509 [0,506 ; 0,511] | 1,0 % / 1,1 % | 0,10 % | 0,500 [0,495 ; 0,504] | — |
| logistique | GMSC | 15 000 / 15 000 | 0,501 [0,498 ; 0,503] | 0,503 [0,501 ; 0,506] | 1,0 % / 1,1 % | 0,11 % | 0,501 [0,497 ; 0,505] | — |
| logistique | credit-risk | 6 500 / 6 500 | 0,499 [0,496 ; 0,502] | 0,506 [0,503 ; 0,509] | 1,0 % / 1,1 % | 0,10 % | 0,502 [0,499 ; 0,504] | — |

Lecture. Sur des lignes ordinaires (sans répétition), le modèle livré seul ne permet pas d'attaque d'appartenance utile : la meilleure attaque (LiRA, 16 fantômes) atteint **0,53** sur Taïwan avec les arbres, 0,51 avec la logistique ; à 1 % de faux positifs elle ne retrouve que 1,3 % des membres (1 % = hasard). Les IC t sur 10 graines sont étroits (±0,002) : l'écart arbres / logistique (0,531 contre 0,509) est réel mais sans conséquence pratique. La puissance est suffisante : avec 15 000 + 15 000 lignes, l'écart-type d'une AUC nulle est 0,003 ; un effet de 0,55 serait vu à coup sûr.

Deux conséquences pour E2 : (1) le seuil provisoire « AUC d'appartenance ≤ 0,55 » est **tenu** par les trois jeux et les deux profils sur lignes ordinaires, avec une marge de 0,02 pour les arbres ; (2) la mesure que E2 calculerait dans l'enclave (AUC des pertes, colonne « AUC E2 ») vaut 0,50 partout : elle est **moins sensible** que LiRA (0,50 contre 0,53) et, surtout, elle reste à 0,49–0,50 même quand des canaris ×20 sont mémorisés (M1, dernière colonne). Elle ne détecte donc pas la fuite qui compte.

### M3. Seuils (mission 3)

Méthode (`thresholds.ts`). Fichier entraîné tel qu'envoyé (ordre d'origine, une ligne sur cinq mise de côté par l'enclave). Pour chaque seuil distinct (variable, t) du modèle livré : t est-il exactement une valeur présente ? Quelles sont les deux valeurs voisines a < t ≤ b dans le fichier, et combien de lignes les portent ?

| Jeu | Seuils distincts | = valeur présente (toutes lignes / entraînement) | Voisin porté par ≤ 5 lignes | Voisin porté par 1 seule ligne |
|---|---|---|---|---|
| Taïwan (entiers, montants) | 119 | **51** / 47 | 83 | **58** |
| GMSC (ratios décimaux) | 83 | 12 / 12 | 49 | **42** |
| credit-risk (2 décimales) | 76 | **56** / 56 | 45 | 19 |

Exemples Taïwan (`results/log-thresholds.txt`) : `x13 < 159000` encadre a = 158 956 (1 ligne) et b = 159 008 (1 ligne) ; `x12 < 36100` encadre 36 098 (1 ligne) et 36 106 (1 ligne) ; `x19 < 1620` : a = 1 619 (1 ligne), b = 1 620 (6 lignes). Le seuil donne donc, à 3 chiffres près (≈ 0,5 % relatif), la valeur d'une variable d'**un seul client** : celle qui tombe au quantile q/64 de la colonne. C'est une statistique d'ordre, pas une ligne complète, et l'identité du client n'est pas révélée ; mais la promesse du code (`train-gbdt.ts:25-27`, « aucune valeur d'une ligne n'est publiée telle quelle ») est fausse dès que les valeurs ont des décimales ou dépassent 100 : le milieu 44,795 arrondi à 3 chiffres redonne 44,8, le milieu 1 619,5 redonne 1 620. Le test existant (`train-gbdt.test.ts:131`) ne couvre que des entiers de 0 à 99, où le milieu x,5 survit à l'arrondi.

Ce qu'un acheteur apprend par ce canal : jusqu'à 63 quantiles par variable (en pratique 5 à 10 seuils distincts par variable utilisée), soit la forme de la distribution de chaque colonne, et pour 40 à 60 d'entre eux la valeur approchée d'une ligne unique. Risque individuel faible tant que les colonnes ne sont pas quasi-identifiantes (code postal, date, identifiant) ; dans ce cas la fuite est directe.

### M4. Métadonnées : `n`, métriques à 6 chiffres, `baseScore`, deux versions (mission 4)

Méthode (`metadata.ts`, `results/log-metadata.txt`). Modèle du fichier complet, puis quatre questions.

**(a) `trainAuc` à 6 chiffres significatifs.** On retire une ligne d'entraînement au hasard (400 tirages) et on recalcule l'AUC du même modèle sur les lignes restantes : la valeur publiée change dans **97 %** des cas (Taïwan), 96 % (GMSC), 100 % (credit-risk) ; |Δ| médian 1 × 10⁻⁵ pour un pas d'arrondi de 10⁻⁶. Arrondie à 3 décimales, elle ne change que dans 0 %, 1,5 % et 1,8 % des cas. Le `trainAuc` livré est donc une empreinte du jeu d'entraînement sensible à une ligne : il sert de vérificateur à qui teste des hypothèses sur le contenu (« la ligne X est-elle dedans ? » quand tout le reste est connu), et de signal dans l'attaque par différence ci-dessous.

**(b) Matrice de confusion held-out.** Les cinq métriques held-out à 6 chiffres n'admettent qu'**une seule** matrice (TP, FP, FN, TN) compatible sur les 6 000 lignes de la tranche : Taïwan (488, 206, 861, 4 445), GMSC (79, 47, 385, 5 489), credit-risk (98, 72, 508, 1 922). L'acheteur connaît donc le nombre exact de positifs de la tranche (1 349, 464, 606), donc le taux de défaut du fichier à ±1 %. Agrégat sur ≥ 2 600 lignes : pas une fuite individuelle, mais une information commerciale que le fournisseur n'a pas choisi de publier.

**(c) `baseScore` à 4 chiffres.** `ln(positifs / négatifs)` change dès l'ajout de **3** lignes positives ou 10 négatives (Taïwan), 2 / 3 (GMSC), 1 / 7 (credit-risk). Entre deux versions d'un fichier, l'acheteur lit donc le signe du solde des étiquettes ajoutées.

**(d) Deux versions du même fichier (attaque par différence).** v1 = fichier, v2 = fichier + 20 lignes ; l'acheteur des deux modèles compare, pour 40 candidats qu'il possède (20 ajoutés, 20 non), la confiance v2 − v1. 10 essais :

| Jeu | AUC par essai [IC t] | AUC groupée [IC bootstrap] | Arbres modifiés | Confiance en hausse : ajoutés / non ajoutés |
|---|---|---|---|---|
| Taïwan | 0,575 [0,502 ; 0,648] | **0,583 [0,528 ; 0,641]** | 100 % | 63 % / 50 % |
| GMSC | 0,559 [0,489 ; 0,629] | **0,565 [0,513 ; 0,618]** | 100 % | 51 % / 44 % |
| credit-risk | 0,597 [0,525 ; 0,668] | **0,595 [0,543 ; 0,650]** | 100 % | 69 % / 55 % |

L'ajout de 20 lignes sur 24 000 change les 150 arbres (les feuilles à 4 chiffres bougent toutes) et laisse une trace d'appartenance significative (IC groupés au-dessus de 0,5) mais modeste : une ligne ajoutée **une fois** est détectable à AUC ≈ 0,58 avec deux modèles, alors qu'elle ne l'est pas avec un seul (M1, ×1). Ce canal s'ajoute à `n` : la différence `n₂ − n₁` dit combien de lignes ont été ajoutées, `baseScore` dit de quelle classe elles étaient en majorité.

**`n` exact.** `n` = 30 000 identifie Taïwan parmi les jeux publics ; plus généralement, `n` exact relie deux livraisons du même fournisseur (même `n`, mêmes noms de colonnes) et chiffre l'ajout de lignes. La centaine proposée par E2 ne cache rien pour les jeux ronds (30 000 reste 30 000) ; voir la proposition plus bas.

**Noms de colonnes.** `MAX_HEADER_CHARS = 128` (`train.ts:10`), aucune restriction de caractères ; `trainingColumns` ne vérifie qu'unicité et longueur. Le test `confidentialite.test.ts` montre qu'un en-tête « Jean Dupont né le 12/03/1980 NIR 1 80 03 75 … » de 128 caractères sort tel quel dans `features`. Ce n'est pas une fuite de lignes (l'en-tête est choisi par le fournisseur et engagé dans le Merkle root), mais c'est 32 × 128 caractères d'un fichier privé copiés sans filtre vers l'acheteur, et le fournisseur n'est pas averti à l'import que ces noms seront publiés.

## Tests ajoutés

`audit/confidentialite/confidentialite.test.ts` (12 tests, 7 passent, 5 `todo`, ≈ 12 s) :

```sh
NODE_OPTIONS=--conditions=react-server node --import tsx --test audit/confidentialite/confidentialite.test.ts
```

| Test | Ce qu'il fixe |
|---|---|
| des seuils livrés sont exactement des valeurs présentes et encadrent des valeurs portées par une seule ligne | CONF-03 (reproductible sur `credit-risk.csv`, sans OpenML) |
| un en-tête de 128 caractères quelconques sort tel quel | CONF-06 |
| les métriques held-out à 6 chiffres reconstruisent la matrice de confusion exacte | CONF-05 |
| `trainAuc` à 6 chiffres change au retrait d'une ligne, à 3 décimales presque jamais | CONF-04 |
| `n` est publié exact | CONF-05 |
| le découpage du banc reproduit la règle une-sur-cinq ; le plafond simulé garde au plus k copies | validité du banc |
| `todo` ×5 : plafond d'influence, `n` arrondi, métriques à 3 décimales, seuils jamais sur une valeur, en-têtes filtrés | critères d'acceptation de E2 |

Le banc statistique complet (`canaries.ts`, `membership.ts`, `metadata.ts`, `thresholds.ts`) n'est pas un test : il dure de quelques minutes à une heure selon la machine. Il n'est pas ajouté à `pnpm test` (pas de modification de `package.json`).

## E2 minimale avant mainnet (mission 6)

Version minimale, calibrée sur les mesures ci-dessus, à coder avant toute livraison d'arbres sur mainnet (nouvelle version de profil `gradient_boosted_trees` 1.1.0 ; linéaire et logistique v1 inchangées, conformément à D-27) :

| Règle | Valeur | Fondement mesuré | Action |
|---|---|---|---|
| Plafond d'influence par ligne distincte | **k = 1** (une copie par empreinte de ligne dans l'entraînement ; `n` compte toutes les lignes) | k = 2 laisse 0,552 (p = 0,01) sur GMSC ; k = 1 : 0,47–0,52, p ≥ 0,21 sur les trois jeux ; AUC held-out inchangée | toujours appliqué |
| Doublons | comptés dans le diagnostic interne ; affichés au fournisseur (E1) | 35 lignes dupliquées sur 30 000 (Taïwan), 8 (GMSC) : le plafond coûte rien sur des jeux propres | signaler |
| Seuils | jamais égaux à a ou b ; refus de la coupe si a et b sont portés par < 10 lignes chacun | 51/119 seuils sur une valeur présente, 58 sur une valeur unique (Taïwan) | toujours appliqué |
| Métriques | held-out à 3 décimales ; `trainAuc` remplacé par `trainAuc − heldOutAuc` arrondi à 0,01 ; `baseScore` à 3 chiffres | `trainAuc` à 6 chiffres change avec une ligne dans 97 % des cas, à 3 décimales dans ≤ 1,8 % | toujours appliqué |
| `n` | 2 chiffres significatifs | la centaine ne masque ni 30 000 ni un ajout de 150 lignes | toujours appliqué |
| En-têtes | `[A-Za-z0-9_]{1,64}`, aperçu « sera publié » | 128 caractères libres passent aujourd'hui | refuser à l'import |
| Feuilles | ≥ 1 000 lignes réelles (existant) | — | refuser |
| AUC d'appartenance par la perte | **diagnostic interne seulement**, pas de verdict ni de certificat | 0,49–0,50 même à ×20 mémorisé ; LiRA 0,53 sur lignes ordinaires | journaliser |
| Écart `trainAuc − heldOutAuc` | pas de seuil (0,008–0,017 sur les trois jeux normaux ; 0,017 à ×20 mémorisé : indiscernable) | mesuré, M1 | aucun |

Les seuils provisoires de la note : **« AUC d'appartenance ≤ 0,55 » tient** comme critère d'audit hors ligne (LiRA 0,531 au pire, IC 0,529–0,533) mais pas comme contrôle d'enclave (CONF-02) ; **« k ≤ 2 » ne tient pas** (CONF-07) ; **« `n` à la centaine » est insuffisant** (CONF-05). Critère de recette, dans `confidentialite.test.ts` (`todo`) : canaris ×20 avec AUC canaris/témoins dans [0,45 ; 0,55] et p > 0,05 sur 20 graines × 20 canaris, sur Taïwan, GMSC et credit-risk ; LiRA ≤ 0,55 sur lignes ordinaires ; aucun seuil égal à une valeur présente ; `trainAuc` absent ; `n` à 2 chiffres.

Hors de la version minimale, à mesurer avant mainnet : l'attaque par différence entre versions (AUC 0,58 à ×1 avec deux modèles) n'est pas couverte par k = 1 ; les options sont des feuilles à 3 chiffres (à mesurer) ou une règle commerciale sur les livraisons successives.

## Points NON VÉRIFIÉS

- **Définition exacte des canaris et de « retrouvé » dans la PR #111** (experiments/model-zoo, hors dépôt) : non lue ; l'écart avec « 22 % contre 13 % » peut venir d'une définition différente.
- **GMSC** : 150 000 lignes dépassent `MAX_CSV_ROWS` (50 000) ; mesuré sur les lignes complètes (sans manquants) puis 30 000 lignes tirées au sort (graine 1). Le fichier brut, avec manquants, perdrait silencieusement `MonthlyIncome` et `NumberOfDependents` (`numericColumns`) : comportement non mesuré ici.
- **Autres attaques** : extraction par requêtes (`/predict`, non codé), reconstruction de lignes complètes, attaques adaptatives, inférence d'attributs (deviner une variable manquante d'une ligne connue) : non mesurées. L'absence d'attaque mesurée n'est pas une preuve d'absence de fuite.
- **Feuilles à 3 chiffres** comme défense contre l'attaque par différence : non mesuré.
- **Effet de k = 1 sur des fichiers à doublons massifs légitimes** (lignes par échéance, > 10 % de doublons) : non mesuré ; l'AUC held-out pourrait baisser, à mesurer avec `canaries.ts --caps=1` sur un tel fichier.
- **Puissance à ×1–×2** : les cas non significatifs excluent un effet ≥ 0,57, pas un effet de 0,53 (400 canaris par case). Pour trancher à ±0,02, il faudrait ≈ 2 500 canaris par case (≈ 125 graines).
- **CVM** : aucune mesure sur la CVM Phala (interdit par le périmètre) ; les temps d'entraînement cités sont ceux d'un PC Windows, avec contention CPU (jusqu'à 10 relances d'un entraînement au-delà du budget de 30 s pendant la série Taïwan, sans effet sur le résultat : entraînement déterministe).
- **Linéaire** (`linear_regression`) : hors périmètre (cible continue, pas de canari binaire).
