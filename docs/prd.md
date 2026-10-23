# personal-knowledge-workspace — PRD de P04 (notes et mémoire personnelle)

Maturité du document : proposition

Provenance : ce document reprend la spécification de mission `specs/personal-knowledge-workspace/prd.md`
de l'analyse du 2026-10-14 (115 lignes, écrite avant ADR-0054 et ADR-0057) et l'amende sur trois
points : P02 n'est plus un produit de ce dépôt (ADR-0054 §2) ; l'application macOS de P04 est une
coquille Tauri 2 et son éditeur CodeMirror 6 (ADR-0057) ; la section 10 (paquets de travail) est
ajoutée au format de la norme de `libre-ai/project-governance` (`docs/specifications/WORK-PACKAGES.md`).
Les réécritures de forme exigées par la norme : chaque paramètre écrit entre chevrons dans la
mission est écrit en capitales (`SHA`, `ORG/DEPOT`, `ID`), et les caractères hors de l'alphabet de
la norme sont remplacés. `cahier-des-charges.md` est à côté de ce fichier ; `architecture.md`,
`tests-et-evaluation.md`, `questions-ouvertes.md`, `CADRAGE.md` et `clones.json` désignent
l'analyse de mission et ne sont pas dans ce dépôt.

Portée du niveau : ce document est une proposition. La fiche porte `maturity: idea`
(`project.v1.yaml:27`) : autre échelle, écart consigné (`cahier-des-charges.md` § 1).

Projet : `libre-ai/personal-knowledge-workspace`, dépôt du domaine Connaissance, lu au SHA
`aec3eba39c192a66e2d32e74c4b11a8e614b9718` (`git rev-parse HEAD` dans le clone de la branche
servie, résolue par `git ls-remote --symref https://github.com/libre-ai/personal-knowledge-workspace HEAD`).
Les chemins sans préfixe sont relatifs à la racine de ce dépôt. Les faits d'état sont établis dans
`cahier-des-charges.md` § 1 ; ce document porte la décision de produit.

Doctrine lue dans `libre-ai/project-governance` au commit
`cd39dfd2861f183fe1472631f809b390bb3c8a4e` (`git -C project-governance rev-parse HEAD` du clone de
sa branche servie). Les références abrégées ci-dessous désignent ce commit :

| Abréviation | Référence épinglée |
| --- | --- |
| `ADR-0042` | `libre-ai/project-governance@cd39dfd2861f183fe1472631f809b390bb3c8a4e:docs/adr/0042-product-vision-and-realization-method.md` |
| `ADR-0044` | `libre-ai/project-governance@cd39dfd2861f183fe1472631f809b390bb3c8a4e:docs/adr/0044-p04-native-textkit2-editor-uniffi-core.md` |
| `ADR-0054` | `libre-ai/project-governance@cd39dfd2861f183fe1472631f809b390bb3c8a4e:docs/adr/0054-amend-adr-0042-p02-v1-surfaces-stack-repository.md` |
| `ADR-0057` | `libre-ai/project-governance@cd39dfd2861f183fe1472631f809b390bb3c8a4e:docs/adr/0057-amend-adr-0042-0044-tauri-2-macos-shell-all-products.md` |
| `REGISTRE` | `libre-ai/project-governance@cd39dfd2861f183fe1472631f809b390bb3c8a4e:docs/decisions/DECISION-REGISTER.md` |
| `INVARIANTS` | `libre-ai/project-governance@cd39dfd2861f183fe1472631f809b390bb3c8a4e:docs/decisions/INVARIANTS.md` |

Les PRD P04 du 2026-10-08 (rapport privé `11-p04-notes-parite-prd.md`, cité « PRD 11 ») et le
rapport de prototypes N1 (`15-p04-n1-prototypes.md`) sont des entrées de maturité proposition :
ils disent ce qui est voulu et ce qui a été mesuré hors de ce dépôt, pas ce qui existe ici.

## 1. Vision

Une boucle documentaire personnelle dont le fichier Markdown local fait foi : accès aux sources
(P01), corpus (P03), notes (P04), wiki (P05), recherche transversale (P06), révision (P07). Chaque
élément conserve sa provenance, l'export est sans verrou, et aucun contenu non fiable n'est jamais
interprété comme instruction (`ADR-0042:73-108`, § 3 ; `INVARIANTS:16`, I-10 ; `INVARIANTS:38`,
I-32). La veille (P02) reste un maillon de la boucle, portée par le dépôt `libre-ai/information-watch`
(`ADR-0054:35-41`, § 2) ; elle remet ses extraits à P04 par un fichier Markdown avec provenance.

P04 est le produit en réalisation de ce dépôt : une application macOS, coquille Tauri 2 autour
d'un cœur Rust, dont l'éditeur est CodeMirror 6 servi depuis la mémoire sans réseau
(`ADR-0057:42-48`, § 2 ; `REGISTRE:103`, D97). Le premier bénéficiaire est le propriétaire de
l'organisation `libre-ai`, qui remplace son outil de notes par P04 (`INVARIANTS:25`, I-19,
dogfooding) ; le jalon B' exige « une première utilisation réelle de la boucle documentaire par le
propriétaire » (`ADR-0042:78-80`).

## 2. Problème

- Les notes vivent dans une application propriétaire dont la synchronisation lit chemins et
  horodatages ; le format n'est pas maître (PRD 11 § 3.1).
- Le code récupéré avant la bascule ne résout pas ce problème : modèle par blocs en IndexedDB
  (`apps/notebook/src/domain/block.ts`) contraire à « le Markdown sur disque fait foi »
  (`ADR-0042:94-95`). La décision propriétaire Y3 (PRD 11, 2026-10-08) retire ce modèle comme
  autorité et conserve `notebook-core`.
- Aucun éditeur n'existe dans le dépôt : 0 fichier Swift (`git ls-files | grep -c '\.swift$'` → 0),
  aucun paquet CodeMirror dans `bun.lock`, aucun crate Tauri dans `Cargo.lock`. Les mesures qui
  fondaient ADR-0044 ont été faites sur des prototypes qui n'existent plus sur le poste
  (`ADR-0057:15-30`, section « Contexte »).

## 3. Proposition de valeur

| Garantie | Réalisée au SHA | Source |
| --- | --- | --- |
| Frontière cryptographique de sauvegarde sans capacité hôte (WASM sans import, secret de récupération, vecteurs dorés) | oui, sur fixture publique | `crates/notebook-core/` ; cahier § 5.1 EF-P04-1, EF-P04-2 |
| Markdown comme autorité, index dérivé reconstructible | non : aucun code | cahier EF-P04-4, critère CA-15 |
| Fidélité à l'octet de l'éditeur : aucun caractère modifié que la personne n'a pas tapé | non : aucun éditeur ; mesurée hors dépôt sur deux prototypes (`ADR-0044:39-40`) | cahier EF-P04-5, critères CA-16 et CA-41 |
| Coquille sans réseau : front servi depuis la mémoire, aucune URL distante, CSP `default-src 'none'`, magasin non persistant, capacités énumérées, aucun port | non : aucune coquille ; six contrôles à prouver chacun par un vecteur rouge (`ADR-0057:46-48`) | cahier EF-P04-8, critères CA-37 et CA-38 |
| Seuils de qualification figés avant mesure, série rejouée dans la coquille construite | non : protocole à commiter avant toute mesure (`ADR-0057:50-66`, § 3) | cahier § 8, critères CA-36, CA-43, CA-44 |
| Export sans verrou : le dossier Markdown est la donnée, la réplique chiffrée se rouvre par algorithmes publics | partiel : réplique prouvée sur vecteurs dorés, dossier non encore lu par l'application | `crates/notebook-core/src/model.rs` ; cahier § 5.1 |

## 4. Scénarios d'usage

- **S1 — Écrire et retrouver.** Le propriétaire ouvre un dossier de fichiers Markdown dans la
  coquille Tauri 2, écrit une note avec liens wiki dans l'éditeur CodeMirror 6, l'aperçu se met à
  jour en direct, retrouve une note par recherche plein texte ; aucun octet hors du paragraphe
  édité ne change (critères CA-15, CA-16, CA-41).
- **S2 — Capturer.** Une page web est capturée vers une note avec provenance (URL, date,
  empreinte) par native messaging, sans port local (EF-P04-7 ; `ADR-0042:200-234`, § 8, partie
  inchangée par ADR-0057 § 1).
- **S3 — Sauvegarder et restaurer.** Le propriétaire scelle une sauvegarde chiffrée, la
  télécharge, puis la restaure avec le secret de récupération ; un mauvais secret ne libère aucun
  plaintext (critères CA-11, CA-17).
- **S4 — Modifier en dehors de l'application.** Un éditeur externe change un fichier ;
  l'application fusionne à trois voies et conserve les deux versions si le conflit n'est pas
  fusionnable (EF-P04-6).
- **S5 — Recevoir un extrait de veille.** Un fichier Markdown avec provenance, écrit par P02
  (`libre-ai/information-watch`) à l'emplacement choisi par le propriétaire, est importé dans le
  dossier par action explicite ; P04 ne lit aucune base de P02 (EF-D-3).
- **S6 — Qualifier.** Le propriétaire rejoue la série de mesures du protocole commité dans la
  coquille construite, sur la machine de mesure et le corpus CR-10k déclarés ; chaque seuil rend
  un verdict ; un rouge ouvre une décision de surface, jamais une révision de seuil (les
  critères CA-43 et CA-44 ; `ADR-0057:66`).

## 5. Métriques associées à une décision

Chaque métrique nomme la décision qu'elle déclenche et son seuil. Source des seuils : PRD 11
§ 3.3, restitués par `ADR-0044:37-48` et repris sans révision par `ADR-0057:56-64` ; figés avant
mesure (`ADR-0042:146-161`, § 6 ; `INVARIANTS:14`, I-08). Aucune métrique n'est mesurée sous Tauri
au SHA : la colonne « Valeur courante » le dit. La colonne « Mesure datée » restitue les relevés du
2026-10-08 et du 2026-10-09 (`ADR-0044:37-48`), faits sur des prototypes hors dépôt, voie (a)
TextKit 2 et voie (b) CodeMirror 6 dans une WKWebView, sur une machine 36 Gio / 14 CPU qui n'est pas
la machine de référence du PRD 11 (32 Gio / 12 CPU) ; ce sont des mesures datées, ni verdict ni
baseline pour Tauri (`ADR-0057:52-54`).

| Métrique | Seuil | Valeur courante sous Tauri | Mesure datée, hors Tauri (2026-10-08 et 2026-10-09) | Décision déclenchée | Instrument |
| --- | --- | --- | --- | --- | --- |
| AT-01, aller-retour sans édition sur CR-10k | 100 % des 10 000 fichiers identiques à l'octet, 20 passes | non mesuré sous Tauri | (a) 200 000 / 200 000 sur 20 passes ; (b) 100 000 / 100 000 sur 10 passes, N de 20 non atteint | rouge : P04 ne sort pas de la qualification ; décision de surface par ADR | série du protocole (critère CA-43) |
| AT-01, édition d'un paragraphe | aucun octet modifié hors du paragraphe | non mesuré sous Tauri | (a) 199 640 / 199 640 ; (b) 99 820 / 99 820 | idem | série du protocole (critère CA-43) |
| AT-02, latence frappe → rendu, aperçu en direct actif, 5 000 lignes | p95 ≤ 16 ms | non mesuré sous Tauri | (a) 10,27 ms ; (b) non mesuré avec aperçu (6,04 ms avec coloration seule) | idem | série du protocole (critère CA-43) |
| AT-02, latence frappe → rendu, aperçu en direct actif, 1 Mio | p95 ≤ 50 ms | non mesuré sous Tauri | (a) 9,79 ms ; (b) non mesuré avec aperçu (6,18 ms avec coloration seule) | idem | série du protocole (critère CA-43) |
| NFR-03, première ouverture d'une note de 1 Mio, aperçu actif | p95 ≤ 100 ms | non mesuré sous Tauri | (a) 113 ms avec aperçu, 76 ms avec coloration ; (b) 99,7 ms | idem ; un rendu de la zone visible d'abord est admis dans le protocole (`ADR-0044:24`) | série du protocole (critère CA-43) |
| NFR-10, mémoire résidente, application + index + interface | ≤ 500 Mio, plafond figé avant mesure (`ADR-0057:70`, § 4) | non mesuré sous Tauri | (a) pic 312 Mio avec index ; (b) 413 Mio sans index, dont 240 Mio de processus GPU WebKit | dépassement : décision de surface, retour au natif pour P04 par ADR ; jamais une révision du plafond | série du protocole (critère CA-44) |
| Texte d'une note de 1 Mio exposé à l'accessibilité | 100 % (seuil bloquant, arbitrage distinct du 2026-10-23, `ADR-0057:66`) | non mesuré sous Tauri | (a) 100 % ; (b) 0,54 % | rouge : même décision de surface que la mémoire | série du protocole (critère CA-44) |
| Empreinte du cœur qualifiée = empreinte du cœur livré | égalité | non applicable à la coquille (cœur WASM de la réplique) | mesure du 2026-10-09 : `7498c60c…046c` consignée comme mesure (`docs/notebook-build-migration.md`) | écart : les campagnes produit refusent la build ; ré-épinglage après rejeu (Y41) | critère CA-14 |
| Jours avec note créée ou modifiée dans P04 sur 28 jours consécutifs | ≥ 24, outil précédent non lancé | non mesuré : aucun journal d'usage | aucune | franchi : P04 qualifié pour l'usage propre (seconde moitié de B') ; non franchi : AB-6 | journal local et script du propriétaire hors produit (critère CA-31) |

Les métriques de P02 du PRD de mission (jours avec session de lecture, extraits envoyés, items
masqués expliqués, corpus adverse SSRF) sont portées par `libre-ai/information-watch` et ne sont
plus comptées ici ; l'extrait reçu par P04 (scénario S5) est compté par ce dépôt quand le
contrat `knowledge-excerpt.v1` existera, sans seuil fixé par ce document.

## 6. Hypothèses à valider

| # | Hypothèse | Expérience qui la valide | Si invalidée |
| --- | --- | --- | --- |
| H-1 | Le Markdown sur disque comme autorité suffit à reconstruire index, rétroliens et recherche sans perte | critère CA-15 sur CR-10k après suppression de l'index et du cache | le modèle de stockage de P04 est rouvert (Q2 de la mission) |
| H-2 | La coquille Tauri 2 tient NFR-10 (≤ 500 Mio, application + index + interface) sur la note de 1 Mio avec index | critère CA-44, série du protocole | décision de surface : retour au natif pour P04, par ADR (`ADR-0057:70`) ; le plafond n'est pas révisé |
| H-3 | Le front peut exposer 100 % du texte de la note à l'accessibilité en maintenant lui-même l'arbre d'accessibilité, ce que WebKit ne fait pas pour un éditeur CodeMirror (`ADR-0057:66`) | critère CA-44, mesure d'accessibilité de la série | même décision de surface que H-2 |
| H-4 | Les six contrôles de coquille d'ADR-0057 § 2 suffisent à tenir la surface d'attaque ajoutée par le moteur web (processus auxiliaires mesurés par ADR-0044) | critères CA-37 et CA-38 : chaque vecteur rouge refusé et compté ; `lsof -i -P` sans port | la matrice de menace du cahier § 7 est rouverte par ADR, sans inventer de contrôle hors d'ADR-0057 |
| H-5 | Un commun libre (SilverBullet, Memos) ne couvre pas la garantie « aucun contenu non fiable n'est instruction » avec fidélité à l'octet et provenance | confrontation de la matrice de parité du PRD 11 § 1 ligne par ligne avec les garanties du § 3 | P04 devient « intégration » (CADRAGE § 1.6) |
| H-6 | L'usage quotidien de P04 remplace l'outil de notes actuel du propriétaire | critère CA-31 sur 28 jours | AB-6 |

## 7. Positionnement face aux communs existants

Licences et maintenance : relevé SPDX de l'API GitHub au 2026-10-15 par la mission
(`gh api repos/ORG/DEPOT --jq .license.spdx_id`, `NOASSERTION` = aucune licence unique reconnue) :
silverbulletmd/silverbullet MIT, usememos/memos MIT, pulldown-cmark/pulldown-cmark MIT,
kivikakk/comrak NOASSERTION, quickwit-oss/tantivy MIT, meilisearch/meilisearch NOASSERTION,
unclecode/crawl4ai Apache-2.0, zotero/zotero NOASSERTION, JabRef/jabref MIT, citation-js/citation-js
MIT, bookstackapp/bookstack MIT, suitenumerique/docs MIT, valeriansaliou/sonic MPL-2.0,
open-spaced-repetition/fsrs-rs BSD-3-Clause, open-spaced-repetition/ts-fsrs MIT ; aucun de ces
dépôts n'était archivé à cette date. Tauri : fichiers `LICENSE-MIT` et `LICENSE-APACHE-2.0` à la
racine, relevé du 2026-10-23 (`ADR-0057:24-27`). Les cellules non couvertes par ces relevés portent
`[NON VÉRIFIÉ]` ; le critère CA-42 les rejoue à l'épinglage.

| Besoin | Commun | Licence | Position |
| --- | --- | --- | --- |
| P04 coquille macOS | Tauri 2 | MIT ou Apache-2.0 (relevé 2026-10-23) ; programme de The Commons Conservancy | adopté pour tous les produits du catalogue (`ADR-0057:34-40`, § 1 ; `REGISTRE:102`, D96) ; aucun service de CrabNebula requis |
| P04 éditeur | CodeMirror 6 | MIT `[NON VÉRIFIÉ]` dans cette session, à relever par CA-42 | adopté (`ADR-0057:42-44`, § 2 ; D97) ; servi depuis la mémoire sans réseau |
| P04 notes Markdown locales | SilverBullet | MIT (dépôt) ; client desktop sous licence Pro payante d'après PRD 11 § 4.3 (seconde main `[NON VÉRIFIÉ]`) | référence (fusion à trois voies, requêtes) ; pas de dépendance |
| P04 notes | Memos | MIT | référence |
| P04 notes | Obsidian, Notion | propriétaires `[NON VÉRIFIÉ]` | références seulement, aucun code (`ADR-0042:109-130`, § 4) |
| P04 chiffrement | RustCrypto `aes-gcm`, `argon2` | Apache-2.0 ou MIT `[NON VÉRIFIÉ]` | dépendances, `aes` 0.8.4 patché sous gate I-28 |
| P04 parse Markdown | `pulldown-cmark` (MIT), `comrak` (BSD-2-Clause) | | candidats du cœur Rust ; départage par le critère CA-16 ; `pulldown-cmark` 0.13.4 a servi aux mesures d'ADR-0044 (`ADR-0044:51`) |
| P04/P06 index | `tantivy` | MIT | candidat du cœur Rust ; `tantivy` 0.26.2 a servi aux mesures d'ADR-0044 ; rachat signalé (PRD 11 R11) : risque R9 |
| P01 collecte | crawl4ai (Apache-2.0) | | non évalué ; Agent-Reach écarté (0 canal conforme, décision de session du 2026-10-09 hors de ce dépôt `[NON VÉRIFIÉ]`) |
| P03 bibliographie | Zotero | AGPL-3.0 (`ADR-0042` § 4 ; relevé API `NOASSERTION`) | intégration par API seulement ; jamais en dépendance |
| P03 références | JabRef, citation-js | MIT | candidats d'intégration |
| P05 wiki | BookStack, suitenumerique/docs | MIT | candidats d'intégration ; décision avant tout code (Q7 de la mission) |
| P06 recherche | Tantivy, Meilisearch (cœur), Sonic | MIT, NOASSERTION, MPL-2.0 | candidats d'intégration |
| P07 répétition espacée | `fsrs-rs`, `ts-fsrs` | BSD-3-Clause, MIT | candidats ; Anki (AGPL) exclu |

Les lignes P02 du PRD de mission (Miniflux, yarr, RSS, Atom, OPML) sont portées par
`libre-ai/information-watch`.

## 8. Devenir du projet

**Conserver**, avec le périmètre suivant : le dépôt du domaine Connaissance porte P01 et P03 à P07
au titre d'`ADR-0042:162-199` (§ 7) tel qu'amendé par `ADR-0054:35-41` (§ 2) ; P04 est le produit en
réalisation ; P02 est porté par `libre-ai/information-watch` et le code P02 de ce dépôt
(`crates/p02-domain`, `crates/p02-fetch`, `crates/p02-store`, `crates/p02-worker`, `apps/p02-api`,
`vendored/contracts/p02-job-v1`) devient une référence : il n'est plus un produit de ce dépôt, aucun
critère d'acceptation ne le mesure ici, et sa reprise par `information-watch` passe par un import
avec provenance (`ADR-0042:189-194`, acte 3). Son retrait de l'arbre n'est pas décidé par ce
document.

Argumentaire :

- P04 est le seul produit de ce dépôt avec un PRD et une décision de surface signée (D97) ; le
  jalon B' exige l'usage réel de la boucle documentaire par le propriétaire, et P04 en porte la
  seconde moitié (`ADR-0042:78-80` ; critère CA-31).
- Les cinq autres produits n'ont ni code ni porteur : un dépôt par produit sans code créerait cinq
  homes réservés sans critère mesurable ; ils restent des chapitres de cadrage (cahier § 4.1).
- Les chapitres P03, P05 et P06 deviennent des lignes « intégration » (CADRAGE § 1.6) si H-5 et
  AB-5 le confirment ; P01 reste « neuf » ; P07 reste « archive » tant qu'aucun import avec
  provenance n'est fait (E21 de la mission).

Alternatives instruites : **scinder** P04 vers un dépôt propre n'a plus d'objet depuis ADR-0054 :
le seul produit à locataire et RLS (P02) est sorti, et P04 reste local sans tenant (Q10 de la
mission, dérogation à I-09 à nommer). **Fusionner avec** `information-feed-filter` (archivé) :
sans objet. Chevauchements nommés sans fusion de spec (liste complète avec sources :
`cahier-des-charges.md` § 10) : `information-watch` (P02, contrat `knowledge-excerpt.v1`),
`schemas-and-contracts` (foyer de `notebook-backup.v2`, `context-document.v2`),
`application-development-toolkit` (`@libre-ai/ui`, `@libre-ai/web-platform`),
`collaborative-data-sync` (sync chiffrée, hors v1), `ai-practice-workbench` (ancien porteur P07),
`learning-session-facilitation` (P39 et P07), `organization-data-lifecycle` (P38),
`signalement` (capture par extension), `square-control` (P40, exempté d'extension, coquille Tauri 2
à sa première fenêtre).

Moyen de validation : (a) la fiche `project.v1.yaml` déclare P01 et P03 à P07, le chantier P04 et
un critère de sortie par phase (critères CA-1, CA-46) ; (b) la série de mesures du protocole, verte,
est le critère de sortie de la qualification de P04 (critères CA-43, CA-44 ; `ADR-0057:52`) ; (c)
le journal local de CA-31 sur 28 jours ; à défaut de (c), si le journal lu le jour 29 donne moins de
24 jours avec note créée ou modifiée, AB-6 renvoie la part P04 au gel.

## 9. ADR amendés et registre des décisions

Le § 9 du PRD de mission (« positions sur les ADR `proposed` ») demandait d'amender ADR-0042 § 8 et
ADR-0044. Ces amendements sont faits : ce document ne porte plus de position, il cite le registre.

| ADR | État au commit lu | Effet sur ce dépôt | Source |
| --- | --- | --- | --- |
| 0042 § 6 et § 8 | amendé par ADR-0057 § 1 | l'adaptateur macOS est nommé : coquille Tauri 2 ; « native » devient « Tauri 2 » ; extension, native messaging par stdio, aucun port, signature et notarisation inchangés | `ADR-0057:34-40` ; `REGISTRE:102` (D96) |
| 0042 § 7 | amendé par ADR-0054 § 2 | ce dépôt porte P01 et P03 à P07 ; P02 a son dépôt ; le code P02 d'ici est une référence | `ADR-0054:35-41` |
| 0044 D1, D2, D4 | amendé par ADR-0057 § 2 et § 3 | éditeur CodeMirror 6 dans la coquille Tauri 2 ; cœur Rust appelé par le pont Tauri, plus par UniFFI ; mesures de la voie (b) devenues seuils de qualification, dont l'accessibilité à 100 % ; série = critère de sortie de la qualification, pas précondition au code | `ADR-0057:42-66` ; `REGISTRE:103` (D97) |
| 0044 D3 | en vigueur mot pour mot | aucun caractère modifié que la personne n'a pas tapé | `ADR-0044:19` ; `ADR-0057:44` |
| 0054 § 3 | généralisé par ADR-0057 § 4 | plafond de mémoire figé avant mesure (500 Mio pour P04, valeur propre de NFR-10 ; 512 MiB à défaut) ; qualification macOS : runner macOS, `lsof -i -P`, `codesign --verify --strict`, `spctl --assess`, ticket de notarisation, parcours Playwright webkit ; mobiles, Windows et Linux au second palier | `ADR-0057:68-74` ; `REGISTRE:104` (D98) |
| 0041, 0033, 0035, 0038, 0039, 0040, 0043, 0047, 0052 | sans effet direct | aucun | position de la mission reprise sans changement |

## 10. Paquets de travail

Le tableau ci-dessous est limité au jalon ouvert par ADR-0057 pour P04 : protocole de mesure,
coquille, pont, éditeur, série de mesures, qualification macOS. Les critères qu'il cite sont ceux
du cahier § 8 déclarés `[état : à construire]` pour ce jalon (CA-34 à CA-46) ; les critères déjà
verts ou portés par d'autres chantiers (CA-1 à CA-17, CA-31, CA-32) ne sont pas découpés ici.

Ordre : le paquet WP-1 précède toute mesure (le protocole et le corpus sont commités avant la
première mesure, `INVARIANTS:14`, I-08) ; les paquets WP-2, WP-3 et WP-4 construisent la coquille,
le pont et l'éditeur, dans cet ordre de dépendance, sans attendre la série (`ADR-0057:52`,
arbitrage 3 : « Pas bloquant, go Tauri ») ; le paquet WP-5 rejoue la série dans la coquille
construite et commite le rapport ; le paquet WP-6 qualifie sur macOS et met la fiche à jour, avec
pour critère de sortie « série du paquet WP-5 verte ».

Périmètres : chaque entrée est un chemin ou un glob borné. Les répertoires `apps/desktop/`,
`crates/notebook-vault/`, `tools/qualification/p04-tauri/` et le workflow
`.github/workflows/p04-desktop-macos.yml` n'existent pas au SHA lu : ils sont créés par les paquets
qui les nomment. Le nom `notebook-vault` désigne le cœur Rust du dossier (lecture et écriture
fidèles à l'octet, analyse Markdown de l'aperçu, index), distinct de `notebook-core`, qui reste le
composant WASM sans import hôte de la réplique chiffrée (EF-P04-2 interdit à `notebook-core` tout
accès au système de fichiers). Les scripts `check:p04-shell`, `check:p04-bridge` et
`check:p04-editor` sont ajoutés à `package.json` par les paquets qui les citent ; chacun enchaîne
les tests Rust et Bun nommés par ses critères.

Portes : les paquets WP-1 à WP-5 sont `two-way` (code, tests, corpus et rapport se défont par une
pull request ; aucune dépendance de flotte, aucun acte du propriétaire). Le paquet WP-6 est
`one-way` : la signature `codesign` engage un certificat Developer ID du compte Apple Developer du
propriétaire, la notarisation soumet l'empreinte du binaire à Apple et le ticket émis n'est pas
retiré par un revert, et la fiche publiée change le critère de sortie de P04 lu par les gates de
flotte.

| WP | CA-n couverts | Périmètre (chemins, globs) | Vérification (commande) | Porte anticipée |
| --- | --- | --- | --- | --- |
| `WP-1` | `CA-34`, `CA-35`, `CA-36` | `tools/qualification/p04-tauri/**` | `bun test tools/qualification/p04-tauri` | `two-way` |
| `WP-2` | `CA-37`, `CA-38` | `apps/desktop/src-tauri/**`, `apps/desktop/tests/shell/**`, `apps/desktop/package.json`, `apps/desktop/index.html`, `apps/desktop/tsconfig.json`, `Cargo.toml`, `Cargo.lock`, `deny.toml`, `package.json`, `bun.lock` | `bun run check:p04-shell` | `two-way` |
| `WP-3` | `CA-39`, `CA-40` | `crates/notebook-vault/**`, `apps/desktop/src-tauri/src/**`, `apps/desktop/src/bridge/**`, `apps/desktop/tests/bridge/**`, `Cargo.toml`, `Cargo.lock`, `deny.toml`, `package.json` | `bun run check:p04-bridge` | `two-way` |
| `WP-4` | `CA-41`, `CA-42` | `apps/desktop/src/**`, `apps/desktop/e2e/**`, `apps/desktop/tests/editor/**`, `apps/desktop/package.json`, `apps/desktop/DEPENDENCIES.md`, `apps/desktop/playwright.config.ts`, `bun.lock`, `package.json` | `bun run check:p04-editor` | `two-way` |
| `WP-5` | `CA-43`, `CA-44` | `tools/qualification/p04-tauri/reports/**`, `docs/apps/p04-tauri-qualification.md` | `bun tools/qualification/p04-tauri/check-report.ts` | `two-way` |
| `WP-6` | `CA-45`, `CA-46` | `.github/workflows/p04-desktop-macos.yml`, `apps/desktop/src-tauri/entitlements.plist`, `project.v1.yaml`, `README.md`, `README.fr.md` | `gh run list -R libre-ai/personal-knowledge-workspace --workflow p04-desktop-macos.yml --limit 1 --json conclusion` | `one-way` |
