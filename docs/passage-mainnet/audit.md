# Points de contrôle pour l'audit

Chaque slice du passage au mainnet remplit **sa propre section**, déjà réservée ci-dessous. Une slice ne touche jamais la section d'une autre : les fusions restent ainsi sans conflit.

L'audit interne final vérifie chacun de ces points **en plus** de l'audit général du code. Une section restée « À remplir » est elle-même un point à signaler.

Références : [plan global](00-PLAN-GLOBAL.md), [audit du 1er octobre](../AUDIT-2026-10-01.md), [runbooks](../MAINNET-RUNBOOKS.md).

## Points transverses

### Ajoutés par Ali et Noé
_Points supplémentaires à prendre en compte pendant l'audit interne._

### Rappels du premier audit
- Connexion anti-phishing (SIWE) reportée après le lancement : vérifier que les sessions restent limitées à 24 heures et que la délégation runner aussi.
- Une seule transaction runner en vol à la fois : vérifier qu'aucune slice n'introduit d'envoi de transaction hors du registre de budget.
- Aucun contrôle d'accès ne doit reposer sur le masquage d'un lien dans l'interface.
- Aucune signature d'assistant dans les commits, les PR et les fichiers.

---

## A1 — Socle base de données

### 1. Ce qui a changé
_À remplir par la slice : fichiers, routes, tables, colonnes, composants._

### 2. Décisions et écarts par rapport au cahier des charges
_À remplir : chaque choix fait en cours de route, chaque écart avec le fichier de feature, et pourquoi._

### 3. Ce que l'audit doit vérifier
_À remplir, avec tous les détails utiles à un auditeur qui découvre le code :_
- contrôle d'accès côté serveur, route par route ;
- validation et bornes de chaque entrée ;
- fuites possibles : données d'un autre wallet, messages d'erreur, journaux ;
- impact sur l'argent, l'escrow, les contrats, le moteur Phala ;
- base de données : migration, contraintes, cohérence ;
- interface : injection HTML, liens, contenus fournis par les utilisateurs ;
- textes : aucune promesse fausse sur les modèles ou la sécurité.

### 4. Cas limites à essayer à la main sur staging
_À remplir : pas à pas, avec le résultat attendu._

### 5. Tests ajoutés et ce qu'ils ne couvrent pas
_À remplir._

### 6. Hypothèses
_À remplir : tout ce que la slice suppose vrai sans l'avoir vérifié._

### 7. Risques résiduels et limites connues
_À remplir._

### 8. Reste à faire
_À remplir : ce qui n'a pas été fait et devrait l'être, avec la priorité._

### 9. Résultats des vérifications
_À remplir : chaque commande lancée et son résultat exact._

### 10. Revue interne de la session
_À remplir : ce que les agents de revue ont trouvé, ce qui a été corrigé, ce qui a été écarté et pourquoi._

---

## A2 — Composants et textes partagés

### 1. Ce qui a changé
_À remplir par la slice : fichiers, routes, tables, colonnes, composants._

### 2. Décisions et écarts par rapport au cahier des charges
_À remplir : chaque choix fait en cours de route, chaque écart avec le fichier de feature, et pourquoi._

### 3. Ce que l'audit doit vérifier
_À remplir, avec tous les détails utiles à un auditeur qui découvre le code :_
- contrôle d'accès côté serveur, route par route ;
- validation et bornes de chaque entrée ;
- fuites possibles : données d'un autre wallet, messages d'erreur, journaux ;
- impact sur l'argent, l'escrow, les contrats, le moteur Phala ;
- base de données : migration, contraintes, cohérence ;
- interface : injection HTML, liens, contenus fournis par les utilisateurs ;
- textes : aucune promesse fausse sur les modèles ou la sécurité.

### 4. Cas limites à essayer à la main sur staging
_À remplir : pas à pas, avec le résultat attendu._

### 5. Tests ajoutés et ce qu'ils ne couvrent pas
_À remplir._

### 6. Hypothèses
_À remplir : tout ce que la slice suppose vrai sans l'avoir vérifié._

### 7. Risques résiduels et limites connues
_À remplir._

### 8. Reste à faire
_À remplir : ce qui n'a pas été fait et devrait l'être, avec la priorité._

### 9. Résultats des vérifications
_À remplir : chaque commande lancée et son résultat exact._

### 10. Revue interne de la session
_À remplir : ce que les agents de revue ont trouvé, ce qui a été corrigé, ce qui a été écarté et pourquoi._

---

## A3 — Tutos de première connexion et par page

### 1. Ce qui a changé
_À remplir par la slice : fichiers, routes, tables, colonnes, composants._

### 2. Décisions et écarts par rapport au cahier des charges
_À remplir : chaque choix fait en cours de route, chaque écart avec le fichier de feature, et pourquoi._

### 3. Ce que l'audit doit vérifier
_À remplir, avec tous les détails utiles à un auditeur qui découvre le code :_
- contrôle d'accès côté serveur, route par route ;
- validation et bornes de chaque entrée ;
- fuites possibles : données d'un autre wallet, messages d'erreur, journaux ;
- impact sur l'argent, l'escrow, les contrats, le moteur Phala ;
- base de données : migration, contraintes, cohérence ;
- interface : injection HTML, liens, contenus fournis par les utilisateurs ;
- textes : aucune promesse fausse sur les modèles ou la sécurité.

### 4. Cas limites à essayer à la main sur staging
_À remplir : pas à pas, avec le résultat attendu._

### 5. Tests ajoutés et ce qu'ils ne couvrent pas
_À remplir._

### 6. Hypothèses
_À remplir : tout ce que la slice suppose vrai sans l'avoir vérifié._

### 7. Risques résiduels et limites connues
_À remplir._

### 8. Reste à faire
_À remplir : ce qui n'a pas été fait et devrait l'être, avec la priorité._

### 9. Résultats des vérifications
_À remplir : chaque commande lancée et son résultat exact._

### 10. Revue interne de la session
_À remplir : ce que les agents de revue ont trouvé, ce qui a été corrigé, ce qui a été écarté et pourquoi._

---

## A4 — Avertissements et conditions d'utilisation

### 1. Ce qui a changé
_À remplir par la slice : fichiers, routes, tables, colonnes, composants._

### 2. Décisions et écarts par rapport au cahier des charges
_À remplir : chaque choix fait en cours de route, chaque écart avec le fichier de feature, et pourquoi._

### 3. Ce que l'audit doit vérifier
_À remplir, avec tous les détails utiles à un auditeur qui découvre le code :_
- contrôle d'accès côté serveur, route par route ;
- validation et bornes de chaque entrée ;
- fuites possibles : données d'un autre wallet, messages d'erreur, journaux ;
- impact sur l'argent, l'escrow, les contrats, le moteur Phala ;
- base de données : migration, contraintes, cohérence ;
- interface : injection HTML, liens, contenus fournis par les utilisateurs ;
- textes : aucune promesse fausse sur les modèles ou la sécurité.

### 4. Cas limites à essayer à la main sur staging
_À remplir : pas à pas, avec le résultat attendu._

### 5. Tests ajoutés et ce qu'ils ne couvrent pas
_À remplir._

### 6. Hypothèses
_À remplir : tout ce que la slice suppose vrai sans l'avoir vérifié._

### 7. Risques résiduels et limites connues
_À remplir._

### 8. Reste à faire
_À remplir : ce qui n'a pas été fait et devrait l'être, avec la priorité._

### 9. Résultats des vérifications
_À remplir : chaque commande lancée et son résultat exact._

### 10. Revue interne de la session
_À remplir : ce que les agents de revue ont trouvé, ce qui a été corrigé, ce qui a été écarté et pourquoi._

---

## A5 — Bouton profil et page Wallet

### 1. Ce qui a changé
_À remplir par la slice : fichiers, routes, tables, colonnes, composants._

### 2. Décisions et écarts par rapport au cahier des charges
_À remplir : chaque choix fait en cours de route, chaque écart avec le fichier de feature, et pourquoi._

### 3. Ce que l'audit doit vérifier
_À remplir, avec tous les détails utiles à un auditeur qui découvre le code :_
- contrôle d'accès côté serveur, route par route ;
- validation et bornes de chaque entrée ;
- fuites possibles : données d'un autre wallet, messages d'erreur, journaux ;
- impact sur l'argent, l'escrow, les contrats, le moteur Phala ;
- base de données : migration, contraintes, cohérence ;
- interface : injection HTML, liens, contenus fournis par les utilisateurs ;
- textes : aucune promesse fausse sur les modèles ou la sécurité.

### 4. Cas limites à essayer à la main sur staging
_À remplir : pas à pas, avec le résultat attendu._

### 5. Tests ajoutés et ce qu'ils ne couvrent pas
_À remplir._

### 6. Hypothèses
_À remplir : tout ce que la slice suppose vrai sans l'avoir vérifié._

### 7. Risques résiduels et limites connues
_À remplir._

### 8. Reste à faire
_À remplir : ce qui n'a pas été fait et devrait l'être, avec la priorité._

### 9. Résultats des vérifications
_À remplir : chaque commande lancée et son résultat exact._

### 10. Revue interne de la session
_À remplir : ce que les agents de revue ont trouvé, ce qui a été corrigé, ce qui a été écarté et pourquoi._

---

## A6 — Réglages et KYB

### 1. Ce qui a changé
_À remplir par la slice : fichiers, routes, tables, colonnes, composants._

### 2. Décisions et écarts par rapport au cahier des charges
_À remplir : chaque choix fait en cours de route, chaque écart avec le fichier de feature, et pourquoi._

### 3. Ce que l'audit doit vérifier
_À remplir, avec tous les détails utiles à un auditeur qui découvre le code :_
- contrôle d'accès côté serveur, route par route ;
- validation et bornes de chaque entrée ;
- fuites possibles : données d'un autre wallet, messages d'erreur, journaux ;
- impact sur l'argent, l'escrow, les contrats, le moteur Phala ;
- base de données : migration, contraintes, cohérence ;
- interface : injection HTML, liens, contenus fournis par les utilisateurs ;
- textes : aucune promesse fausse sur les modèles ou la sécurité.

### 4. Cas limites à essayer à la main sur staging
_À remplir : pas à pas, avec le résultat attendu._

### 5. Tests ajoutés et ce qu'ils ne couvrent pas
_À remplir._

### 6. Hypothèses
_À remplir : tout ce que la slice suppose vrai sans l'avoir vérifié._

### 7. Risques résiduels et limites connues
_À remplir._

### 8. Reste à faire
_À remplir : ce qui n'a pas été fait et devrait l'être, avec la priorité._

### 9. Résultats des vérifications
_À remplir : chaque commande lancée et son résultat exact._

### 10. Revue interne de la session
_À remplir : ce que les agents de revue ont trouvé, ce qui a été corrigé, ce qui a été écarté et pourquoi._

---

## A7 — Explorer

### 1. Ce qui a changé
_À remplir par la slice : fichiers, routes, tables, colonnes, composants._

### 2. Décisions et écarts par rapport au cahier des charges
_À remplir : chaque choix fait en cours de route, chaque écart avec le fichier de feature, et pourquoi._

### 3. Ce que l'audit doit vérifier
_À remplir, avec tous les détails utiles à un auditeur qui découvre le code :_
- contrôle d'accès côté serveur, route par route ;
- validation et bornes de chaque entrée ;
- fuites possibles : données d'un autre wallet, messages d'erreur, journaux ;
- impact sur l'argent, l'escrow, les contrats, le moteur Phala ;
- base de données : migration, contraintes, cohérence ;
- interface : injection HTML, liens, contenus fournis par les utilisateurs ;
- textes : aucune promesse fausse sur les modèles ou la sécurité.

### 4. Cas limites à essayer à la main sur staging
_À remplir : pas à pas, avec le résultat attendu._

### 5. Tests ajoutés et ce qu'ils ne couvrent pas
_À remplir._

### 6. Hypothèses
_À remplir : tout ce que la slice suppose vrai sans l'avoir vérifié._

### 7. Risques résiduels et limites connues
_À remplir._

### 8. Reste à faire
_À remplir : ce qui n'a pas été fait et devrait l'être, avec la priorité._

### 9. Résultats des vérifications
_À remplir : chaque commande lancée et son résultat exact._

### 10. Revue interne de la session
_À remplir : ce que les agents de revue ont trouvé, ce qui a été corrigé, ce qui a été écarté et pourquoi._

---

## A8 — Passage à USDG

### 1. Ce qui a changé
_À remplir par la slice : fichiers, routes, tables, colonnes, composants._

### 2. Décisions et écarts par rapport au cahier des charges
_À remplir : chaque choix fait en cours de route, chaque écart avec le fichier de feature, et pourquoi._

### 3. Ce que l'audit doit vérifier
_À remplir, avec tous les détails utiles à un auditeur qui découvre le code :_
- contrôle d'accès côté serveur, route par route ;
- validation et bornes de chaque entrée ;
- fuites possibles : données d'un autre wallet, messages d'erreur, journaux ;
- impact sur l'argent, l'escrow, les contrats, le moteur Phala ;
- base de données : migration, contraintes, cohérence ;
- interface : injection HTML, liens, contenus fournis par les utilisateurs ;
- textes : aucune promesse fausse sur les modèles ou la sécurité.

### 4. Cas limites à essayer à la main sur staging
_À remplir : pas à pas, avec le résultat attendu._

### 5. Tests ajoutés et ce qu'ils ne couvrent pas
_À remplir._

### 6. Hypothèses
_À remplir : tout ce que la slice suppose vrai sans l'avoir vérifié._

### 7. Risques résiduels et limites connues
_À remplir._

### 8. Reste à faire
_À remplir : ce qui n'a pas été fait et devrait l'être, avec la priorité._

### 9. Résultats des vérifications
_À remplir : chaque commande lancée et son résultat exact._

### 10. Revue interne de la session
_À remplir : ce que les agents de revue ont trouvé, ce qui a été corrigé, ce qui a été écarté et pourquoi._

---

## N1 — Mes datasets

### 1. Ce qui a changé
_À remplir par la slice : fichiers, routes, tables, colonnes, composants._

### 2. Décisions et écarts par rapport au cahier des charges
_À remplir : chaque choix fait en cours de route, chaque écart avec le fichier de feature, et pourquoi._

### 3. Ce que l'audit doit vérifier
_À remplir, avec tous les détails utiles à un auditeur qui découvre le code :_
- contrôle d'accès côté serveur, route par route ;
- validation et bornes de chaque entrée ;
- fuites possibles : données d'un autre wallet, messages d'erreur, journaux ;
- impact sur l'argent, l'escrow, les contrats, le moteur Phala ;
- base de données : migration, contraintes, cohérence ;
- interface : injection HTML, liens, contenus fournis par les utilisateurs ;
- textes : aucune promesse fausse sur les modèles ou la sécurité.

### 4. Cas limites à essayer à la main sur staging
_À remplir : pas à pas, avec le résultat attendu._

### 5. Tests ajoutés et ce qu'ils ne couvrent pas
_À remplir._

### 6. Hypothèses
_À remplir : tout ce que la slice suppose vrai sans l'avoir vérifié._

### 7. Risques résiduels et limites connues
_À remplir._

### 8. Reste à faire
_À remplir : ce qui n'a pas été fait et devrait l'être, avec la priorité._

### 9. Résultats des vérifications
_À remplir : chaque commande lancée et son résultat exact._

### 10. Revue interne de la session
_À remplir : ce que les agents de revue ont trouvé, ce qui a été corrigé, ce qui a été écarté et pourquoi._

---

## N2 — Upload en deux étapes

### 1. Ce qui a changé
_À remplir par la slice : fichiers, routes, tables, colonnes, composants._

### 2. Décisions et écarts par rapport au cahier des charges
_À remplir : chaque choix fait en cours de route, chaque écart avec le fichier de feature, et pourquoi._

### 3. Ce que l'audit doit vérifier
_À remplir, avec tous les détails utiles à un auditeur qui découvre le code :_
- contrôle d'accès côté serveur, route par route ;
- validation et bornes de chaque entrée ;
- fuites possibles : données d'un autre wallet, messages d'erreur, journaux ;
- impact sur l'argent, l'escrow, les contrats, le moteur Phala ;
- base de données : migration, contraintes, cohérence ;
- interface : injection HTML, liens, contenus fournis par les utilisateurs ;
- textes : aucune promesse fausse sur les modèles ou la sécurité.

### 4. Cas limites à essayer à la main sur staging
_À remplir : pas à pas, avec le résultat attendu._

### 5. Tests ajoutés et ce qu'ils ne couvrent pas
_À remplir._

### 6. Hypothèses
_À remplir : tout ce que la slice suppose vrai sans l'avoir vérifié._

### 7. Risques résiduels et limites connues
_À remplir._

### 8. Reste à faire
_À remplir : ce qui n'a pas été fait et devrait l'être, avec la priorité._

### 9. Résultats des vérifications
_À remplir : chaque commande lancée et son résultat exact._

### 10. Revue interne de la session
_À remplir : ce que les agents de revue ont trouvé, ce qui a été corrigé, ce qui a été écarté et pourquoi._

---

## N3 — Marketplace

### 1. Ce qui a changé
_À remplir par la slice : fichiers, routes, tables, colonnes, composants._

### 2. Décisions et écarts par rapport au cahier des charges
_À remplir : chaque choix fait en cours de route, chaque écart avec le fichier de feature, et pourquoi._

### 3. Ce que l'audit doit vérifier
_À remplir, avec tous les détails utiles à un auditeur qui découvre le code :_
- contrôle d'accès côté serveur, route par route ;
- validation et bornes de chaque entrée ;
- fuites possibles : données d'un autre wallet, messages d'erreur, journaux ;
- impact sur l'argent, l'escrow, les contrats, le moteur Phala ;
- base de données : migration, contraintes, cohérence ;
- interface : injection HTML, liens, contenus fournis par les utilisateurs ;
- textes : aucune promesse fausse sur les modèles ou la sécurité.

### 4. Cas limites à essayer à la main sur staging
_À remplir : pas à pas, avec le résultat attendu._

### 5. Tests ajoutés et ce qu'ils ne couvrent pas
_À remplir._

### 6. Hypothèses
_À remplir : tout ce que la slice suppose vrai sans l'avoir vérifié._

### 7. Risques résiduels et limites connues
_À remplir._

### 8. Reste à faire
_À remplir : ce qui n'a pas été fait et devrait l'être, avec la priorité._

### 9. Résultats des vérifications
_À remplir : chaque commande lancée et son résultat exact._

### 10. Revue interne de la session
_À remplir : ce que les agents de revue ont trouvé, ce qui a été corrigé, ce qui a été écarté et pourquoi._

---

## N4 — Train

### 1. Ce qui a changé
_À remplir par la slice : fichiers, routes, tables, colonnes, composants._

### 2. Décisions et écarts par rapport au cahier des charges
_À remplir : chaque choix fait en cours de route, chaque écart avec le fichier de feature, et pourquoi._

### 3. Ce que l'audit doit vérifier
_À remplir, avec tous les détails utiles à un auditeur qui découvre le code :_
- contrôle d'accès côté serveur, route par route ;
- validation et bornes de chaque entrée ;
- fuites possibles : données d'un autre wallet, messages d'erreur, journaux ;
- impact sur l'argent, l'escrow, les contrats, le moteur Phala ;
- base de données : migration, contraintes, cohérence ;
- interface : injection HTML, liens, contenus fournis par les utilisateurs ;
- textes : aucune promesse fausse sur les modèles ou la sécurité.

### 4. Cas limites à essayer à la main sur staging
_À remplir : pas à pas, avec le résultat attendu._

### 5. Tests ajoutés et ce qu'ils ne couvrent pas
_À remplir._

### 6. Hypothèses
_À remplir : tout ce que la slice suppose vrai sans l'avoir vérifié._

### 7. Risques résiduels et limites connues
_À remplir._

### 8. Reste à faire
_À remplir : ce qui n'a pas été fait et devrait l'être, avec la priorité._

### 9. Résultats des vérifications
_À remplir : chaque commande lancée et son résultat exact._

### 10. Revue interne de la session
_À remplir : ce que les agents de revue ont trouvé, ce qui a été corrigé, ce qui a été écarté et pourquoi._

---

## N5 — Self training réservé à l'équipe

### 1. Ce qui a changé
_À remplir par la slice : fichiers, routes, tables, colonnes, composants._

### 2. Décisions et écarts par rapport au cahier des charges
_À remplir : chaque choix fait en cours de route, chaque écart avec le fichier de feature, et pourquoi._

### 3. Ce que l'audit doit vérifier
_À remplir, avec tous les détails utiles à un auditeur qui découvre le code :_
- contrôle d'accès côté serveur, route par route ;
- validation et bornes de chaque entrée ;
- fuites possibles : données d'un autre wallet, messages d'erreur, journaux ;
- impact sur l'argent, l'escrow, les contrats, le moteur Phala ;
- base de données : migration, contraintes, cohérence ;
- interface : injection HTML, liens, contenus fournis par les utilisateurs ;
- textes : aucune promesse fausse sur les modèles ou la sécurité.

### 4. Cas limites à essayer à la main sur staging
_À remplir : pas à pas, avec le résultat attendu._

### 5. Tests ajoutés et ce qu'ils ne couvrent pas
_À remplir._

### 6. Hypothèses
_À remplir : tout ce que la slice suppose vrai sans l'avoir vérifié._

### 7. Risques résiduels et limites connues
_À remplir._

### 8. Reste à faire
_À remplir : ce qui n'a pas été fait et devrait l'être, avec la priorité._

### 9. Résultats des vérifications
_À remplir : chaque commande lancée et son résultat exact._

### 10. Revue interne de la session
_À remplir : ce que les agents de revue ont trouvé, ce qui a été corrigé, ce qui a été écarté et pourquoi._

---

## N6 — Certificat d'exécution

### 1. Ce qui a changé
_À remplir par la slice : fichiers, routes, tables, colonnes, composants._

### 2. Décisions et écarts par rapport au cahier des charges
_À remplir : chaque choix fait en cours de route, chaque écart avec le fichier de feature, et pourquoi._

### 3. Ce que l'audit doit vérifier
_À remplir, avec tous les détails utiles à un auditeur qui découvre le code :_
- contrôle d'accès côté serveur, route par route ;
- validation et bornes de chaque entrée ;
- fuites possibles : données d'un autre wallet, messages d'erreur, journaux ;
- impact sur l'argent, l'escrow, les contrats, le moteur Phala ;
- base de données : migration, contraintes, cohérence ;
- interface : injection HTML, liens, contenus fournis par les utilisateurs ;
- textes : aucune promesse fausse sur les modèles ou la sécurité.

### 4. Cas limites à essayer à la main sur staging
_À remplir : pas à pas, avec le résultat attendu._

### 5. Tests ajoutés et ce qu'ils ne couvrent pas
_À remplir._

### 6. Hypothèses
_À remplir : tout ce que la slice suppose vrai sans l'avoir vérifié._

### 7. Risques résiduels et limites connues
_À remplir._

### 8. Reste à faire
_À remplir : ce qui n'a pas été fait et devrait l'être, avec la priorité._

### 9. Résultats des vérifications
_À remplir : chaque commande lancée et son résultat exact._

### 10. Revue interne de la session
_À remplir : ce que les agents de revue ont trouvé, ce qui a été corrigé, ce qui a été écarté et pourquoi._

