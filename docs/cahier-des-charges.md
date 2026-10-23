# personal-knowledge-workspace — cahier des charges de P04

Maturité : décision

Provenance : ce document reprend la spécification de mission
`specs/personal-knowledge-workspace/cahier-des-charges.md` de l'analyse du 2026-10-14 (306 lignes,
33 critères), écrite avant ADR-0054 et ADR-0057, et l'amende sur trois points : les chapitres,
exigences, interfaces, menaces, métriques et critères de P02 en sortent (ADR-0054 § 2 : P02 est
porté par `libre-ai/information-watch`, le code P02 de ce dépôt est une référence) ; la surface de
P04 est la coquille Tauri 2 et l'éditeur CodeMirror 6 d'ADR-0057 ; treize critères sont ajoutés
pour le jalon ouvert par ADR-0057. Les critères de la mission conservés gardent leur numéro, soit
les critères CA-1 à CA-17, CA-31 et CA-32 ; les numéros de la mission qui portaient P02, soit les
numéros de CA-18 à CA-30 et le numéro CA-33, ne sont pas réutilisés, pour que chaque numéro
désigne la même chose ici et dans la mission ; les critères ajoutés vont de CA-34 à CA-46.
Réécritures de forme exigées par la norme des
paquets de travail de `libre-ai/project-governance` (`docs/specifications/WORK-PACKAGES.md`) :
chaque paramètre écrit entre chevrons dans la mission est écrit en capitales (`SHA`, `ORG/DEPOT`,
`ID`, `PID`) ; les caractères hors de l'alphabet de la norme sont remplacés. `prd.md` est à côté de
ce fichier et porte la table des références épinglées de la doctrine (abréviations `ADR-0042`,
`ADR-0044`, `ADR-0054`, `ADR-0057`, `REGISTRE`, `INVARIANTS`, toutes au commit
`cd39dfd2861f183fe1472631f809b390bb3c8a4e` de `libre-ai/project-governance`) ; `architecture.md`,
`tests-et-evaluation.md`, `questions-ouvertes.md`, `CADRAGE.md` et `clones.json` désignent
l'analyse de mission et ne sont pas dans ce dépôt.

Projet : `libre-ai/personal-knowledge-workspace`, dépôt du domaine Connaissance, marque publique
« Libre AI Knowledge Workspace » (LEXICON § 14.1). Produits portés : P01 et P03 à P07
(`ADR-0042:162-199`, § 7, amendé par `ADR-0054:35-41`, § 2). Produit en réalisation : P04. SHA lu :
`aec3eba39c192a66e2d32e74c4b11a8e614b9718`, tête de la branche servie quand ce document a été écrit
(`git rev-parse HEAD` dans le clone de la branche servie ; la tête servie avance, voir `prd.md`). Chemins relatifs à la racine du dépôt sauf préfixe. Positionnement : « décision de
mission du 2026-10-14 » (CADRAGE § 1.2) ; les P-xx entrent au catalogue parce que le propriétaire
en a exprimé le besoin ; leur lien au socle est d'être fabriqués par la méthode avec preuves
versionnées (I-13, I-15).

## 1. État des lieux

### 1.1 Ce que le dépôt contient

| Élément | Constat | Source |
| --- | --- | --- |
| Rôle d'inventaire | `reserved-product-home`, `couche-1`, `lifecycle: active` | `ecosystem/repositories.v1.yaml` de l'autorité |
| Fiche d'état | `maturity: idea`, `exposure: idea`, `confidence: medium`, `freshness 2026-10-07`, critère `qualified-scope` `pending`, `kill_predicates: []`, aucune mention de P01 à P07, aucune phase P04, aucun plafond de mémoire | `project.v1.yaml:27-29,31,33-41,48` ; `grep -c 'P0' project.v1.yaml` → 0 |
| Workspace Rust | 5 crates : `notebook-core` (P04) ; `p02-domain`, `p02-fetch`, `p02-store`, `p02-worker` (P02, référence) ; aucun crate Tauri | `Cargo.toml:5-11` ; `grep -c tauri Cargo.lock` → 0 |
| Applications Bun | `apps/notebook` (host de sauvegarde Gate B, React 19, désactivé par défaut) ; `apps/p02-api` (P02, référence) ; aucune coquille, aucun paquet CodeMirror | `package.json:62-65` ; `apps/notebook/README.md:3` ; `grep -c codemirror bun.lock` → 0 |
| Contrats consommés | monde WIT `libre-ai:notebook-core@2.0.0` ; `p02-job-v1` vendorisé (référence P02) | `vendored/wit/notebook-core-v2/world.wit:1` ; `vendored/contracts/p02-job-v1/provenance.json` |
| Patch vendorisé | `third_party/rustcrypto-aes-0.8.4` (sélection `fixslice64` sur wasm32, SHA-256 déclaré) appliqué à tout le graphe | `Cargo.toml:73-77` ; `crates/notebook-core/DEPENDENCIES.md:31-36` |
| Qualification | harnais `tools/qualification/notebook-core-v2/` (34 fichiers), classes matérielles, toolchain Node 26.5.0 et Playwright 1.61.1 épinglés par SHA-256 ; aucun harnais de mesure de l'éditeur | `toolchains/notebook-qualification.json` ; `toolchains/notebook-resource-classes.json` |
| CI | 2 workflows verts le 2026-10-14 (`Code validation`, `Notebook WebKit macOS`) ; composition de flotte épinglée `0db2e10e` ; aucun workflow macOS pour une coquille | `.github/workflows/code-validation.yml:13` ; `.github/workflows/notebook-webkit-macos.yml` |
| Licence | EUPL-1.2 déclarée (`package.json:4`, `Cargo.toml:17`) ; REUSE : EUPL-1.2 `**`, CC-BY-4.0 `*.md` et `docs/`, Apache-2.0 `vendored/contracts/**`, `LicenseRef-ThirdParty-Notices` pour le patch aes ; conforme à I-11 | `REUSE.toml:8-65` |

### 1.2 Contradictions document / code au SHA

- **E14** — `LICENSE:1-4` et `REUSE.toml:3-4` affirment « contains/carries no application and no
  product runtime code » ; l'arbre porte 2 applications et 5 crates. `project.v1.yaml:15` décrit
  encore un « recovered source snapshot c81ad342 ». Question Q4 de la mission, jamais réécrite ici.
- **ADR-0054 § 2 vs arbre** — P02 n'est plus un produit de ce dépôt, mais 43 mentions de P02
  subsistent dans l'arbre (`git ls-files | xargs grep -hoE '\bP0[1-9]\b' | sort | uniq -c`, mission :
  43 P02, 1 P04) et `Cargo.toml:2-4` décrit encore P02 comme chantier du workspace. Ce document ne
  retire pas ce code : il cesse de le mesurer (§ 4.1).
- **Modèle de données P04** — `apps/notebook/src/domain/block.ts` (modèle par blocs, IndexedDB,
  révisions immuables) contredit « le Markdown sur disque fait foi » (`ADR-0042:94-95`) ;
  `ROADMAP.md:9-13` planifie encore de brancher ce modèle. La décision propriétaire Y3 (PRD 11,
  2026-10-08) retire ce modèle comme autorité et conserve `notebook-core`. Question Q2 de la
  mission.
- **Spécification héritée** — `docs/apps/notebook.md:6` cite ADR-0002 et des chemins de contrats
  qui vivent dans `schemas-and-contracts` ; c'est la spécification du code récupéré, antérieure à
  ADR-0042. `docs/product-readiness.md` est déclassé au profit de la fiche (le fichier reste dans l'arbre).
- **Fiche sans phase P04** — la fiche n'a ni phase de qualification de P04, ni plafond de mémoire
  figé, ni critère de sortie « série de mesures verte » (`ADR-0057:52`, `ADR-0057:72`). Voir le
  critère CA-46.

### 1.3 Doctrine applicable

Contraintes : les ADR `accepted` et les invariants de `INVARIANTS`. Les invariants les plus engagés
par P04 : I-05 (copies vendorisées = projections sous gate), I-06 (Bun + React 19 pour le front de
la coquille ; Rust pour moteurs, WASM, sécurité ; `INVARIANTS:12`), I-08 (preuve dans la fiche,
protocole commité avant mesure ; `INVARIANTS:14`), I-10 (digest canonique des exportations, AEAD
hors contexte de confiance ; `INVARIANTS:16`), I-11 (licences ; `INVARIANTS:17`), I-19
(dogfooding ; `INVARIANTS:25`), I-21 (frontière code / données ; `INVARIANTS:27`), I-27 (gate de
parité ; `INVARIANTS:33`), I-28 (patch vendorisé à foyer unique), I-32 (isolation contre
l'injection ; `INVARIANTS:38`), I-37 (CSP ; `INVARIANTS:43`).

Décisions de surface qui s'appliquent à P04, toutes signées :

| ADR | Effet sur P04 | Source |
| --- | --- | --- |
| 0042 § 3 | le Markdown sur disque fait foi, le stockage chiffré en est la réplique ; B' exige une première utilisation réelle de la boucle documentaire par le propriétaire | `ADR-0042:94-95`, `ADR-0042:78-80` |
| 0042 § 8 amendé par 0057 § 1 | premier palier : application macOS, coquille Tauri 2 ; extension navigateur parlant au même cœur par native messaging et stdio ; aucun port ouvert ; distribution à un tiers = signature et notarisation | `ADR-0042:200-234` ; `ADR-0057:34-40` ; D96 |
| 0044 D3, maintenu | aucun caractère modifié que la personne n'a pas tapé | `ADR-0044:19` ; `ADR-0057:46` |
| 0057 § 2 | éditeur CodeMirror 6 servi depuis la mémoire sans réseau ; cœur Rust (octets, Markdown de l'aperçu, index) appelé par le pont Tauri, rien réimplémenté côté front ; six contrôles de coquille prouvés par vecteur rouge | `ADR-0057:42-48` ; D97 |
| 0057 § 3 | seuils d'ADR-0044 re-mesurés sous Tauri, protocole commité d'abord ; série = critère de sortie de la qualification, pas précondition au code ; un rouge = décision de surface | `ADR-0057:50-66` ; D97 |
| 0057 § 4 | plafond de mémoire figé avant mesure ; qualification macOS (runner, `lsof -i -P`, `codesign --verify --strict`, `spctl --assess`, notarisation, Playwright webkit) ; mobiles, Windows, Linux au second palier | `ADR-0057:68-74` ; D98 |
| 0054 § 2 | P02 hors de ce dépôt ; son code ici est une référence | `ADR-0054:35-41` |

## 2. Problème résolu

Le propriétaire prend ses notes dans une application propriétaire dont la synchronisation lit
chemins et horodatages ; le format n'est pas maître (PRD 11 § 3.1). Le domaine Connaissance doit
fournir une boucle documentaire — accès aux sources (P01), veille (P02, dépôt `information-watch`),
corpus (P03), notes (P04), wiki (P05), recherche transversale (P06), révision (P07) — où le
fichier Markdown local fait foi, où chaque élément porte sa provenance, où l'export est sans
verrou et où aucun contenu non fiable ne devient instruction (`ADR-0042:73-108` ; I-10 ; I-32). Le
code récupéré (modèle par blocs dans IndexedDB) ne résout pas ce problème ; la frontière
cryptographique `notebook-core` en résout une partie délimitée (la réplique chiffrée). L'éditeur,
le dossier, l'aperçu et l'index restent à écrire, sous les seuils figés par ADR-0044 et repris sans
révision par ADR-0057.

## 3. Utilisateurs cibles

- **Primaire** : le propriétaire de l'organisation `libre-ai`, seul membre d'une organization
  personnelle, utilisateur v0 de P04 (remplacement de l'outil de notes actuel, PRD 11 § 3.2). Le
  jalon B' exige « une première utilisation réelle de la boucle documentaire par le propriétaire »
  (`ADR-0042:78-80` ; I-19).
- **Secondaires** : contributeurs qualifiant le code récupéré (`project.v1.yaml:7-9`) ;
  propriétaires de machines modestes pour les campagnes facultatives 8 Gio et 16-24 Gio
  (`tools/qualification/notebook-core-v2/CONTRIBUTING-DEVICE-QUALIFICATION.md:3-11`).
- **Hors v1** : utilisateurs externes, équipes, organisations réglementées. La distribution signée
  à un tiers est une exigence de distribution, pas d'usage propre (`ADR-0042:226-229`) ; la
  qualification macOS de D98 la prépare sans la promettre.

## 4. Périmètre

### 4.1 Dans le périmètre (spec du domaine, un chapitre par produit)

| Chapitre | Contenu au SHA | Statut de spec |
| --- | --- | --- |
| **P04 — notes et mémoire personnelle** | `crates/notebook-core` (scellement et ouverture, canonicalisation Context v2, bornes), `apps/notebook` (host Gate B sous feature gate), harnais de qualification ; cible : coquille Tauri 2 `apps/desktop`, cœur du dossier `crates/notebook-vault`, harnais `tools/qualification/p04-tauri` | exigences, critères d'acceptation : § 5, § 8 |
| P02 — veille documentaire | `crates/p02-*`, `apps/p02-api`, contrat `p02-job-v1`, migrations `0001`, `0002` : **référence**, pas un produit de ce dépôt (`ADR-0054:39`) | aucune exigence ni critère ici ; spec portée par `libre-ai/information-watch` |
| P01 — accès aux sources | aucun code | chapitre de cadrage ; ligne de catalogue « neuf » |
| P03 — entretien du corpus bibliographique | aucun code | chapitre de cadrage ; candidat « intégration » (Zotero AGPL-3.0 par son API seule, `ADR-0042` § 4) |
| P05 — wiki | aucun code ; capacité `knowledge` absorbée en projection dans l'autorité (ADR-0041 § 4) | chapitre de cadrage ; candidat « intégration » |
| P06 — recherche transversale | aucun code ; « en avance de son domaine » (`ADR-0042:99-100`) | chapitre de cadrage ; dépendance de P04 (index plein texte, porté par `notebook-vault`) |
| P07 — apprentissage et révision | aucun code ; ancien porteur archivé (`ai-practice-workbench`) | chapitre de cadrage ; catalogue `archive` |

Les chapitres P01, P03, P05, P06 et P07 ne portent aucun critère d'acceptation : un critère sans
code à mesurer serait une assertion sur rien. Les critères de P04 qui portent sur du code
inexistant au SHA le déclarent par leur préfixe `[état : à construire]` (§ 8). Le code P02 ne porte
aucun critère : ses tests restent dans l'arbre et dans `bun run check` tant qu'il n'est pas retiré,
mais aucun critère de ce cahier ne les cite.

### 4.2 Hors périmètre (non-objectifs)

- Collaboration temps réel sur le carnet, publication web publique, analytics de lecture,
  télémétrie (PRD 11 F30, F32, F49, F51 ; `docs/apps/notebook.md:21-25`).
- Code exécutable dans le contenu des notes (PRD 11 F24 X) ; CSS ou JavaScript personnalisés ;
  front chargé depuis un hôte distant (`ADR-0057:48`).
- Traitement par un modèle de langage en v1 (P33 non qualifié ; PRD 11 F41 à F44) : aucune
  exigence AI Act n'est retenue en v1 (hypothèse, champ d'application AI Act art. 2 non relu
  `[NON VÉRIFIÉ]`).
- Veille, flux, règles, OPML : P02, dépôt `information-watch` (`ADR-0054:35-41`).
- Distribution signée à un tiers : exigence de distribution, pas d'usage propre
  (`ADR-0042:226-229`) ; la qualification macOS (CA-45) prépare la signature sans distribuer.
- Sync multi-appareils de P04 : hors v1 (décision Y1), format prêt dès la v1 ; le dépôt qui porte
  la sync chiffrée de bout en bout est `collaborative-data-sync` (I-34).
- Mobiles, Windows et Linux : second palier (`ADR-0057:74`) ; Tauri 2 les cible, ce qui n'est pas
  une promesse.
- Révision d'un seuil de qualification après mesure : interdite (`ADR-0057:66`) ; un rouge est une
  décision de surface prise par ADR.

## 5. Exigences

Langage MUST / SHOULD / MAY du standard. Cadres réglementaires (CADRAGE § 1.3) marqués par
exigence : **RGPD** : une note ou une préférence est une donnée concernant la personne ;
l'exemption d'activité exclusivement personnelle ou domestique (RGPD art. 2 § 2 c) n'est pas
discutée ici et reste à trancher pour l'usage du propriétaire `[NON VÉRIFIÉ]` ; **AI Act** : aucune
exigence n'est retenue tant qu'aucune fonction IA n'existe (hors v1) ; **NIS2 / DORA /
RGS-SecNumCloud** : non retenus pour un outil local sur le poste du propriétaire, sous la lecture
d'I-21 (les données concernant une personne physique restent sur son device, `INVARIANTS:27`),
que P04 satisfait (dossier et réplique locaux, aucun port, aucune transmission).

### 5.1 Exigences fonctionnelles

Domaine :

- EF-D-1 Le dépôt MUST déclarer dans `project.v1.yaml` les produits portés (P01, P03 à P07), le
  chantier actif (P04), ses phases et le critère de sortie de chaque phase (I-08, I-15).
- EF-D-2 Toute exportation (sauvegarde P04, document de contexte) MUST porter un digest canonique
  RFC 8785 vérifié à l'import avec refus fermé, et MUST être authentifiée par AEAD ou signature
  hors du contexte qui l'a produite (I-10 ; réalisé pour la sauvegarde :
  `crates/notebook-core/src/crypto.rs:16-17`, domaines `aad` et `digest`).
- EF-D-3 P04 MUST recevoir un extrait de P02 (`libre-ai/information-watch`) par un fichier Markdown
  avec provenance, écrit à l'emplacement choisi par l'utilisateur et importé par action
  explicite ; P04 MUST NOT lire le stockage de P02. L'authentification de cet extrait au sens
  d'I-10 est la question Q15 de la mission, portée désormais par le contrat `knowledge-excerpt.v1`
  à créer dans l'autorité.

P04, existant :

- EF-P04-1 Le cœur `notebook-core` MUST sceller et ouvrir une sauvegarde sous Argon2id v19 +
  AES-256-GCM avec enveloppe canonique JCS, secret de récupération de 16 octets, salt 16 octets,
  nonce 12 octets, plaintext 1 octet à 16 Mio, et MUST n'exposer que le `error-code` fermé
  (`vendored/wit/notebook-core-v2/world.wit:4-12,43-50` ; `crates/notebook-core/src/validate.rs:7-19`).
- EF-P04-2 Le composant WASM MUST n'avoir aucun import hôte (ni horloge, ni aléa, ni réseau, ni
  stockage, ni journal) ; identifiants, salt, nonce et secret sont des entrées explicites de l'hôte
  (`world.wit:53-58` ; `crates/notebook-core/README.md:8-9`). Conséquence : la lecture et
  l'écriture du dossier, l'analyse Markdown et l'index ne vivent pas dans `notebook-core` mais
  dans un crate natif distinct, `notebook-vault` (EF-P04-9).
- EF-P04-3 Le host de sauvegarde `apps/notebook` MUST rester désactivé sans
  `NOTEBOOK_BACKUP_FEATURE_ENABLED=1`, MUST n'utiliser que la fixture publique avant décision de
  release, MUST créer un worker neuf par opération et le terminer dans tous les cas, et MUST
  afficher le code de récupération seulement après persistance chiffrée et déclenchement du
  téléchargement (`apps/notebook/src/backup/feature.ts` ; `apps/notebook/README.md:7-15`).

P04, cible (ADR-0057) :

- EF-P04-4 Le Markdown sur disque MUST faire foi ; index, état de fusion, réplique chiffrée et
  caches MUST être dérivés et reconstructibles depuis le seul dossier (`ADR-0042:94-95` ; PRD 11
  G1). Le modèle par blocs IndexedDB MUST NOT être autorité (décision Y3).
- EF-P04-5 L'éditeur MUST NOT modifier un caractère non tapé par la personne : substitutions
  automatiques (guillemets, tirets, remplacements), correction, détection de liens et de données,
  insertion intelligente d'espaces désactivées ; l'aperçu ne change que des attributs
  (`ADR-0044:19`, D3 maintenu par `ADR-0057:46`). Une contribution qui en retire une rouvre AT-01.
- EF-P04-6 Une édition concurrente (éditeur externe, hôte de capture, autre appareil en v1.1) MUST
  être fusionnée à trois voies ; un conflit non fusionnable MUST conserver les deux versions
  (décision Y3 ; PRD 11 F29).
- EF-P04-7 La capture depuis le navigateur SHOULD passer par native messaging (hôte lancé par le
  navigateur, stdio, manifeste restreint à l'identifiant de l'extension) et MUST NOT ouvrir de port
  local (`ADR-0042:211-216`, partie du § 8 inchangée par `ADR-0057:38`).
- EF-P04-8 L'application macOS MUST être une coquille Tauri 2 dont le front est rendu dans la
  WKWebView du système, sous six contrôles (`ADR-0057:48`) : (1) le front est servi depuis la
  mémoire de l'application par un gestionnaire de schéma privé, jamais depuis un hôte distant ;
  (2) la configuration Tauri n'autorise aucune URL distante ; (3) la politique de sécurité de
  contenu est `default-src 'none'` élargie aux seules origines du schéma privé ; (4) le magasin de
  données de la vue web est non persistant ; (5) les capacités Tauri exposées au front sont
  énumérées par commande, deny-by-default ; (6) le processus Rust n'ouvre aucun port. Chaque
  contrôle MUST avoir un vecteur rouge écrit avant le code, refusé et compté ; un contrôle sans
  vecteur n'est pas un contrôle (I-08).
- EF-P04-9 Le cœur Rust du dossier (`crates/notebook-vault`) MUST porter la lecture et l'écriture
  fidèles à l'octet (écriture atomique : fichier temporaire, `fsync`, renommage), l'analyse
  Markdown de l'aperçu et l'index plein texte ; le front MUST l'appeler par le pont de la coquille
  Tauri (commandes et événements entre le front et le processus Rust), non par UniFFI, et MUST
  NOT réimplémenter aucune de ces fonctions (`ADR-0057:46`).
- EF-P04-10 L'éditeur MUST être CodeMirror 6, servi depuis la mémoire de l'application sans
  réseau (`ADR-0057:42-44`) ; ses paquets et ceux du front MUST être épinglés en version exacte,
  publiés depuis au moins trois jours (`bunfig.toml`, `minimumReleaseAge` 259200), sous une
  licence admise par I-11 et `ADR-0042` § 4 et § 11.
- EF-P04-11 Le front MUST maintenir l'arbre d'accessibilité de l'éditeur de sorte que 100 % du
  texte de la note soit exposé à l'API d'accessibilité (`ADR-0057:66`) ; WebKit ne l'expose pas de
  lui-même pour un éditeur CodeMirror.
- EF-P04-12 La série de mesures de qualification MUST être décrite par un protocole commité avant
  la première mesure (effectifs, seuils, statistiques, règles de rejet, machine, corpus) ; la
  série MUST être rejouée dans la coquille construite, sur le corpus CR-10k versionné ; un seuil
  rouge MUST ouvrir une décision de surface et MUST NOT réviser le seuil (`ADR-0057:50-66`).

Chapitres sans code (exigences de cadrage, pas de critère) :

- EF-P01-1 Le cœur de P01 (plan de collecte, provenance, extraction, politique, confinement) est
  écrit ; les connecteurs sont des adaptateurs appelant en processus séparé des briques
  compatibles (`ADR-0042:96-98`).
- EF-P03-1 Zotero (AGPL-3.0) n'entre jamais en dépendance ; l'intégration passe par son API
  (catalogue P03 ; `ADR-0042` § 4).
- EF-P05-1 Aucun wiki n'est écrit avant une décision « intégration ou écriture » (CADRAGE § 1.6 ;
  question Q7 de la mission).
- EF-P06-1 L'index transversal est une capacité consommée par P04 ; sa place (crate
  `notebook-vault`, cœur Tantivy MIT) est déclarée dans la fiche avant tout code d'index
  transversal hors P04.
- EF-P07-1 Toute réutilisation de l'archive `ai-practice-workbench` passe par un import avec
  provenance (`ADR-0042:183-191`, acte 3).

### 5.2 Exigences non fonctionnelles

- ENF-1 **Sécurité / RGPD** : aucune URL, titre, contenu, jeton, secret ni chemin de dossier dans
  un journal, un message d'erreur ou un artefact (PRD 11 NFR-15 ; `crates/notebook-core/src/model.rs:41-50`).
- ENF-2 **Sécurité** : CSP de `web-platform` sur toute surface HTML servie par Bun, seul
  relâchement nommé `'wasm-unsafe-eval'`, échec fermé si la base attendue manque (I-37 ;
  `apps/notebook/src/server/handler.ts:75-81`) ; dans la coquille Tauri, CSP `default-src 'none'`
  élargie aux seules origines du schéma privé (EF-P04-8, contrôle 3).
- ENF-3 **Sécurité** : le workspace déclare `unsafe_code = "forbid"` et `unwrap`, `expect`,
  `panic`, `todo`, `unimplemented`, `indexing_slicing` en `deny` (`Cargo.toml:81-90`) ;
  `crates/notebook-core/Cargo.toml` n'a pas de table `[lints]` et ne reçoit ni le `forbid` ni les
  `deny` clippy (`crates/notebook-core/src/lib.rs:1` : `#![deny(unsafe_code)]` seulement) ; ses
  `unwrap()` sont tous dans des modules `#[cfg(test)]`. Le crate MUST hériter des lints du
  workspace, ou porter une exception nommée dans `docs/` (CA-32, rouge au SHA). Les crates
  `notebook-vault` et celui de la coquille MUST hériter des lints du workspace dès leur création.
  Deux modules `unsafe` sont autorisés dans `notebook-core` par `#[allow(unsafe_code)]` :
  `component` (wasm32, livré) et `qualification_allocator` (wasm32, non livré).
- ENF-4 **Supply chain** : versions exactes, publiées depuis au moins trois jours (`Cargo.toml:37-38` ;
  `bunfig.toml` `minimumReleaseAge` 259200 s) ; licences dans la liste `allow` de
  `deny.toml:33-47` ; sources `crates.io` et organisation `libre-ai` seulement (`ADR-0042` § 4,
  § 11 ; I-26). Les crates Tauri et les paquets CodeMirror entrent sous les mêmes règles
  (EF-P04-10).
- ENF-5 **Reproductibilité** : aucun chemin machine dans les binaires, modules WASM et bundle de
  la coquille (décision Y40 ; `scripts/check-artifact-paths.ts`) ; empreinte du cœur indépendante
  du chemin et de l'utilisateur (`docs/notebook-build-migration.md` § Machine paths).
- ENF-6 **Performance P04**, seuils figés par le PRD 11, restitués par `ADR-0044:37-48`, repris sans
  révision par `ADR-0057:56-64` : AT-01 100 % des 10 000 fichiers de CR-10k identiques à l'octet
  sur 20 passes et aucun octet modifié hors du paragraphe édité ; AT-02 frappe → rendu avec aperçu
  en direct p95 ≤ 16 ms (5 000 lignes) et ≤ 50 ms (1 Mio) ; NFR-03 première ouverture d'une note
  de 1 Mio p95 ≤ 100 ms ; NFR-10 mémoire résidente application + index + interface ≤ 500 Mio ;
  texte exposé à l'accessibilité 100 % ; indexation à froid de CR-10k ≤ 20 s et recherche p95
  ≤ 150 ms (PRD 11 NFR-01 et NFR-05, non repris par ADR-0057, mesurés dans la même série sans être
  critères de sortie). Mesures datées hors Tauri : `prd.md` § 5.
- ENF-7 **Plafond de mémoire figé avant mesure** (`ADR-0057:72`) : le plafond de P04 est la valeur
  propre de NFR-10, 500 Mio, écrit dans la fiche avant toute mesure sous Tauri ; un dépassement
  mesuré est une décision de surface (retour au natif pour P04), jamais une révision du plafond.
- ENF-8 **Performance sauvegarde** : profil producteur p95 ≤ 5 s et RSS additionnel ≤ 256 Mio,
  profil maximal p95 ≤ 10 s et ≤ 512 Mio, trois moteurs, classe 32+ Gio
  (`docs/apps/notebook-resource-floor.md:10`).
- ENF-9 **Accessibilité** : parcours clavier complet, focus visible, contraste WCAG 2.2 AA, lecteur
  d'écran (VoiceOver) ; équivalent tableau du graphe (PRD 11 G8 ; `docs/apps/notebook.md:75`) ;
  EF-P04-11 pour le texte de l'éditeur.
- ENF-10 **Mode dégradé** : quota, clé ou dossier indisponible bloque la mutation sans perdre la
  version précédente (`docs/apps/notebook.md:59,75`) ; un échec d'écriture atomique laisse le
  fichier d'origine intact (EF-P04-9).
- ENF-11 **Hors ligne** : toutes les fonctions locales de P04 sans réseau (PRD 11 F27) ; la
  coquille n'émet aucune requête (CA-13, CA-38).
- ENF-12 **Rétention / RGPD** : rétention jusqu'à suppression locale explicite, suppression des
  enregistrements et des clés (`docs/apps/notebook.md:63`).
- ENF-13 **Journal d'usage** : compteurs locaux agrégés (dates et nombres), lisibles et effaçables
  par l'utilisateur, aucun envoi (PRD 11 FR-33).

## 6. Interfaces

| Interface | Direction | Format | Source |
| --- | --- | --- | --- |
| Cœur de sauvegarde | hôte → WASM | WIT `libre-ai:notebook-core@2.0.0` : `canonicalize-context`, `seal-backup`, `open-backup` ; `result<_, error-code>` | `vendored/wit/notebook-core-v2/world.wit` |
| Enveloppe de sauvegarde | WASM → fichier | `libre-ai.notebook-backup.v2` (JSON canonique : `schemaVersion`, `id`, `cipher`, `kdf`, `nonce`, `ciphertext`, `digest`) ; téléchargement `notebook-backup.lai` ; secret `libre-ai.recovery-secret-code.v1` (32 hex minuscules) | `crates/notebook-core/src/model.rs:7-10,78-95` ; `apps/notebook/README.md:14` |
| Document de contexte | P04 → tiers | `context-document.v2` (schéma dans `schemas-and-contracts`) canonicalisé RFC 8785 ; bornes 1 000 blocs, 16 384 liens, profondeur 64, 100 000 nœuds | `crates/notebook-core/src/validate.rs:20-27` |
| Pont Tauri (cible) | front → processus Rust | commandes énumérées par la capacité, deny-by-default : `open_vault` (dossier), `read_note` (octets exacts), `write_note` (octets exacts, écriture atomique, révision attendue), `render_preview` (arbre d'attributs de l'aperçu, jamais du HTML interprété), `search` (requête, résultats), `rebuild_index` ; événements `vault_changed` (chemin, empreinte) ; refus fermés `vault.*` ; aucune chaîne libre dans un code de refus | EF-P04-8, EF-P04-9 ; CA-39 |
| Front de la coquille (cible) | processus Rust → WKWebView | front servi depuis la mémoire par un schéma privé ; CSP `default-src 'none'` élargie aux origines du schéma ; magasin non persistant | EF-P04-8 ; CA-37 |
| Extrait P02 → P04 (cible) | fichier → P04 | `knowledge-excerpt.v1` (extrait, ancrage, URL, dates, `source_id`, `item_id`, version) — contrat à créer dans l'autorité ; émis par `information-watch`, importé ici par action explicite | EF-D-3 |
| Native messaging (cible) | extension ↔ hôte | messages `{data, meta}` validés par schéma, ≤ 64 Kio, liste fermée de commandes, manifestes `allowed_origins` et `allowed_extensions` | PRD 11 F45 ; EF-P04-7 |
| Protocole et rapport de mesure (cible) | harnais → dépôt | `tools/qualification/p04-tauri/PROTOCOL.md` (effectifs, seuils, statistiques, règles de rejet, machine, SHA-256 du corpus) ; `reports/ID/` (sorties brutes, manifeste JSON liant commit, machine, SHA-256 du corpus, verdict par seuil) | EF-P04-12 ; CA-36, CA-43 |

## 7. Contraintes de sécurité

Menaces prises en compte, avec la parade existante ou exigée :

| Menace | Parade | État au SHA |
| --- | --- | --- |
| Oracle sur le secret de récupération | secret invalide remplacé par une constante et passé au même KDF | réalisé (`crates/notebook-core/src/lib.rs:139-150`) |
| Fuite de plaintext dans le navigateur (host Gate B) | worker jetable par opération, transfert d'ownership, effacement best-effort, aucune persistance du recovery | réalisé sur fixture ; effacement physique non prouvé (`apps/notebook/README.md:27`) |
| Fuite de contenu par les journaux | erreurs sans donnée ; `Debug` d'`OpenedBackup` expose `schema_version`, `id`, `digest` et la taille (`model.rs:41-50`) ; scan des journaux à construire | partiel (CA-7) |
| Chemin ou nom d'utilisateur embarqué dans un artefact | remap et scan des artefacts (Y40) | réalisé (CA-5) ; à étendre au bundle de la coquille |
| Dépendance cryptographique altérée | copie vendorisée avec SHA-256 déclaré et diff d'une ligne ; `cargo deny` sources | réalisé ; gate de provenance I-28 à vérifier (AB-4) |
| Exécution de contenu actif (SVG, HTML, script) dans une note | aperçu rendu par attributs, jamais par HTML interprété (`render_preview`) ; CSP `default-src 'none'` ; assainissement par liste blanche ; types actifs jamais exécutés | CSP du host réalisée ; aperçu et assainisseur absents du SHA (CA-39, CA-41) |
| Port local ouvert sur le poste (CSRF, DNS rebinding depuis une page) | aucun port : le processus Rust n'écoute pas ; native messaging pour l'extension | cible (CA-38, CA-45) |
| Moteur web dans le processus de l'application et ses processus auxiliaires (trois de plus, mesurés par ADR-0044), risque assumé par `ADR-0057:80` | les six contrôles d'EF-P04-8, chacun avec son vecteur rouge refusé et compté ; `lsof -i -P` sans port | cible (CA-37, CA-38) ; aucune autre ligne n'est inventée pour la coquille (`ADR-0057:80`) |
| Front chargé depuis un hôte distant ou mis à jour hors du dépôt | schéma privé servi depuis la mémoire ; aucune URL distante dans la configuration ; vecteur rouge « requête hors schéma refusée » | cible (CA-37, CA-38) |
| Commande du pont appelée hors de la liste énumérée | capacités deny-by-default ; vecteur rouge « commande non déclarée refusée et comptée » | cible (CA-38) |
| Persistance de la vue web (cookies, stockage) hors du dossier | magasin non persistant ; vecteur rouge « écriture dans le magasin persistant refusée » | cible (CA-38) |
| Texte de l'éditeur invisible aux technologies d'assistance (0,54 % mesuré sur la voie (b), `ADR-0044:47`) | arbre d'accessibilité maintenu par le front (EF-P04-11) ; seuil bloquant 100 % | cible (CA-44) |
| Injection de prompt indirecte par une note ou une page capturée | aucun contenu n'atteint un contexte de modèle à outil (aucune fonction IA en v1) ; validation par schéma à vocabulaire fermé (I-32) | aucune fonction IA en v1 |

Zéro donnée personnelle en journal : exigence ENF-1 ; les compteurs d'usage sont des nombres datés
(ENF-13).

Lieu d'exécution et I-21 : P04 s'exécute sur le poste du propriétaire ; dossier, index, réplique et
journal d'usage y restent (`INVARIANTS:27`). Aucune hypothèse NIS2 / DORA n'est conditionnée par
un déploiement serveur, ce dépôt n'en portant plus (P02 sorti).

## 8. Critères d'acceptation

Chaque critère porte un préfixe d'état au SHA lu : `[état : vert]` = test ou gate existant et run CI
`success` sur le SHA (CA-4), non rejoué ici ; `[état : rouge]` = écart constaté par lecture
statique ; `[état : à construire]` = code, corpus ou instrument absent du SHA ; `[état : partiel]`
= une partie du critère est à construire. Décompte :
`grep -cE '^- CA-[0-9]+ \[état : à construire\]' docs/cahier-des-charges.md`, et de même pour
`rouge`, `vert`, `partiel`. Les critères CA-34 à CA-46 sont ceux du jalon ouvert par ADR-0057 et
sont découpés en paquets de travail dans `prd.md` § 10.

Transverses au dépôt :

- CA-1 [état : rouge] La fiche `project.v1.yaml` déclare les six produits portés (P01, P03 à P07)
  et le chantier actif de P04. Validation : `grep -oE '\bP0[1-7]\b' project.v1.yaml | sort -u | wc -l`
  → 6, sans `P02` (`grep -c 'P02' project.v1.yaml` → 0) ; rejoué au SHA : 0 et 0 ; et
  `check-inventory-drift` de `project-governance` vert sur la génération épinglée.
- CA-2 [état : rouge] Aucune surface déclarative du dépôt n'affirme l'absence de code.
  Validation : `cat LICENSE REUSE.toml | grep -ciE 'no (application|product runtime)'` → 0 (rejoué :
  2 au SHA, une ligne par fichier) et `reuse lint` vert (après arbitrage Q4).
- CA-3 [état : vert] Les épinglages de l'autorité `project-governance` (workflow réutilisable,
  `tooling_ref`, `ref` du checkout macOS, `pinned` de la fiche) sont de la même génération.
  Validation : `grep -h -oE '(project-governance[^ ]*[@#]|tooling_ref: |^ +ref: )[0-9a-f]{40}' .github/workflows/code-validation.yml .github/workflows/notebook-webkit-macos.yml project.v1.yaml | grep -oE '[0-9a-f]{40}' | sort -u | wc -l`
  → 1 (rejoué : 4 occurrences, 1 valeur) et `check-fleet-pins` (`ecosystem/check-fleet-pins.ts`)
  vert avec son compteur imprimé.
- CA-4 [état : vert] La chaîne `bun run check` et `cargo test --locked` sont vertes sur la branche
  servie pour le commit livré. Validation :
  `gh run list -R libre-ai/personal-knowledge-workspace --commit SHA --json name,conclusion`
  contient au moins un `success` pour chacun des noms `Code validation` et `Notebook WebKit macOS`
  et aucun `failure` (rejoué au SHA le 2026-10-23 : 5 runs, 5 `success`) ; ce critère recouvre les critères
  numérotés CA-5, CA-6, CA-9 (première moitié) et CA-13 (première moitié), qui sont des étapes
  de `bun run check` (`package.json:50`).
- CA-5 [état : vert] Aucun chemin machine dans les binaires et modules livrés. Validation :
  `bun run check:artifact-paths` imprime le volume scanné et 0 hit ; la build de qualification
  imprime 17 fichiers scannés et 0 hit ; le bundle de la coquille entre dans le scan à sa
  création (critère CA-45).
- CA-6 [état : vert] Toute dépendance Rust est sous une licence de la liste `allow` et provient de
  `crates.io` ou de l'organisation. Validation : `bun run check:dependency-policy` sort 0 ; 0
  licence hors liste dans la sortie `cargo deny`.
- CA-7 [état : partiel] Aucune chaîne du corpus de test (contenu de note, chemin de dossier,
  secret) n'apparaît dans les journaux produits par les suites e2e du host et de la coquille.
  Validation : scan des journaux e2e par les chaînes du corpus → 0 occurrence (PRD 11 NFR-15 ;
  scan à construire, aucun scan de journaux dans `bun run check`) ; `Debug` d'`OpenedBackup` à limiter
  à la taille (il expose aujourd'hui `schema_version`, `id`, `digest` et la taille :
  `crates/notebook-core/src/model.rs:41-50`).
- CA-8 [état : rouge] Chaque clé `@libre-ai/*` du bloc `overrides` de `package.json` est déclarée
  en `dependencies` ou `devDependencies` d'un des `package.json` du workspace, ou importée, ou
  justifiée dans `docs/`. Validation :
  `comm -23 <(jq -r '.overrides|keys[]|select(startswith("@libre-ai/"))' package.json | sort) <( (for f in package.json apps/*/package.json; do jq -r '((.dependencies//{})+(.devDependencies//{}))|keys[]|select(startswith("@libre-ai/"))' $f; done; grep -rhoE 'from "@libre-ai/[a-z-]+' apps tools scripts | sed 's/from "//') | sort -u) | wc -l`
  → 0 (rejoué : 11 clés dans `overrides`, 7 restantes au SHA : `auth-web`, `contracts`, `data`,
  `envelope`, `policy-core-ref`, `rgpd-kit`, `testing`).

P04, existant :

- CA-9 [état : vert] Les 38 vecteurs dorés de l'autorité épinglée passent dans le cœur natif et le
  harnais. Validation : `cargo test --locked -p libre-ai-notebook-core` → 21 tests verts (rejoué
  statiquement : 21 `#[test]` dans `crates/notebook-core/src` et `tests`) ;
  `bun run check:qualification` imprime 38 vecteurs examinés, 0 manquant.
- CA-10 [état : vert] Le composant construit n'a aucun import et exporte exactement le monde
  `notebook-core`. Validation : `node scripts/check-component-encoding.ts` et l'inspection
  `wasmparser` du build de qualification rendent 0 import.
- CA-11 [état : vert] Le host de sauvegarde scelle, télécharge, stage et restaure sur fixture
  publique, refuse un mauvais secret sans libérer de plaintext et nettoie un staging interrompu,
  dans Chromium, Firefox et WebKit. Validation : `bun run --cwd apps/notebook test:e2e` rend 17
  `passed` sous 5 projets (`grep -c 'name:' apps/notebook/playwright.config.ts` → 5 ; 5 tests
  joués sous `chromium`, `firefox` et `webkit`, plus 1 sous `webkit-storage-estimate-removed` et 1
  sous `chromium-no-js`) ; le workflow `Notebook WebKit macOS` rejoue `--project=webkit` sur
  macOS ; compte lu dans le journal du run `Code validation` du même SHA par `gh run view ID --log`.
- CA-12 [état : vert] La CSP servie par le host contient `script-src 'self' 'wasm-unsafe-eval'` et
  rien d'autre comme source de script. Validation : test
  `serves the strict content security policy on every product surface` vert.
- CA-13 [état : partiel] L'application n'émet aucune requête sortante. Validation :
  `bun run check:no-transmission` vert avec la seule exemption `notebook-core-worker.ts`
  (existant) ; capture réseau d'une session e2e de 30 minutes dans la coquille → 0 requête hors du
  schéma privé (à construire : PRD 11 AT-35 ; CA-38 en porte le vecteur rouge).
- CA-14 [état : rouge] L'empreinte qualifiée du cœur correspond au cœur livré, ou les campagnes
  produit refusent la build. Validation : `QUALIFIED_CORE_SHA256` égale le SHA-256 du cœur
  transpilé mesuré après rejeu de `qualify:notebook-product-host:faults` et `:storage` sur la
  classe `desktop-arm64-high-memory-reference` (décision Y41) ; sinon les campagnes sortent non
  nul.
- CA-15 [état : à construire] Le Markdown fait foi : après suppression de l'index, du cache et de
  l'état local, le coffre, les rétroliens et la recherche sont identiques à l'oracle et 0 octet du
  dossier a changé. Validation : PRD 11 AT-32 sur CR-10k (générateur à graine fixe versionné du
  critère CA-34), comparaison SHA-256 fichier par fichier par l'oracle de CA-35 ; test
  `cargo test --locked -p libre-ai-notebook-vault rebuild_from_folder_is_lossless` (à écrire).
- CA-16 [état : à construire] Fidélité à l'octet : 100 % des 10 000 fichiers de CR-10k identiques
  après ouverture et fermeture ; une édition d'un paragraphe ne modifie aucun octet hors du
  paragraphe. Validation : AT-01 du protocole de CA-36, rejoué dans la coquille construite par
  le critère CA-43 ; mesure datée hors Tauri : `ADR-0044:39-40`, 200 000 / 200 000 (voie (a)) et
  100 000 / 100 000 (voie (b)), ni verdict ni baseline pour Tauri.
- CA-17 [état : vert] Le secret de récupération ne donne aucun oracle : un secret de 15 ou 17
  octets traverse le KDF et finit `authentication-failed`. Validation :
  `maps_out_of_range_open_secrets_to_authentication_failure` vert ; distribution de temps des quatre
  refus anti-oracle de la campagne performance dans la marge déclarée.

P04, usage et lints :

- CA-31 [état : à construire] Usage réel de P04 : sur 28 jours consécutifs, au moins une note créée
  ou modifiée sur au moins 24 jours, l'outil de notes précédent non lancé (0 lancement lu dans le
  même export que le nombre de jours). Validation : journal local agrégé (PRD 11 FR-33) et script
  du propriétaire hors produit (PRD 11, objectif O1) ; les deux comptes (jours, lancements, attendu
  0) sont lus dans le même export ; seuil lu par AB-6 ; `prd.md` § 5 cite ces conditions.
- CA-32 [état : rouge] `crates/notebook-core` hérite des lints du workspace (`unsafe_code =
  "forbid"`, `unwrap_used`, `expect_used`, `panic`, `indexing_slicing` en `deny`) ou porte une
  exception justifiée par écrit dans `docs/` (ENF-3). Validation :
  `grep -A1 '\[lints\]' crates/notebook-core/Cargo.toml` contient `workspace = true` (rejoué :
  sortie vide au SHA) ; si l'héritage est retenu,
  `cargo clippy --locked -p libre-ai-notebook-core --all-targets` sans avertissement.

P04, jalon ADR-0057 — protocole et corpus (paquet WP-1) :

- CA-34 [état : à construire] Le générateur du corpus CR-10k est versionné dans
  `tools/qualification/p04-tauri/` : graine fixe, 10 000 notes, 60 000 liens wiki, une note de
  1 Mio et une de 5 000 lignes, pièges d'octets énumérés (CRLF, CR seul, BOM, tabulations, espaces
  de fin de ligne, fin de fichier sans saut de ligne, NFD et NFC, caractères hors BMP) ; deux
  exécutions donnent le même SHA-256 d'ensemble. Validation :
  `bun test tools/qualification/p04-tauri/cr10k.test.ts` (compte des fichiers → 10 000, présence
  de chaque piège, égalité des deux empreintes) ; le SHA-256 d'ensemble est écrit dans
  `PROTOCOL.md`.
- CA-35 [état : à construire] L'oracle octet à octet compare chaque fichier avant et après une
  passe (SHA-256 par fichier) et, pour une édition de paragraphe, borne le diff aux octets du
  paragraphe ; il rougit sur un fichier muté d'un octet et sur un octet changé hors du paragraphe.
  Validation : `bun test tools/qualification/p04-tauri/oracle.test.ts`, dont deux vecteurs rouges
  (mutation d'un octet, octet hors paragraphe) vus rouges puis le cas nominal vert.
- CA-36 [état : à construire] Le fichier `tools/qualification/p04-tauri/PROTOCOL.md` est commité
  avant la première mesure et porte : effectifs (20 passes AT-01, 3 000 frappes AT-02, 60
  lancements NFR-03 et NFR-10), les seuils de `prd.md` § 5 sans révision, statistique p95 au rang
  le plus proche sur les échantillons poolés, règles de rejet (frappe non rendue en 2 s = +oo ;
  lancement fait session verrouillée ou écran éteint rejeté et refait), la machine de mesure
  (classe de `toolchains/notebook-resource-classes.json`), le plafond de mémoire 500 Mio, le SHA-256
  du corpus (CA-34) et la méthode de mesure de l'accessibilité (API d'accessibilité macOS,
  proportion du texte exposé). Validation : `bun test tools/qualification/p04-tauri/protocol.test.ts`
  (chaque champ présent, seuils égaux à ceux du tableau de `prd.md` § 5) ; ordre des commits :
  `git log --diff-filter=A --format=%ct -- tools/qualification/p04-tauri/PROTOCOL.md` antérieur à
  `git log --diff-filter=A --format=%ct -- tools/qualification/p04-tauri/reports`.

P04, jalon ADR-0057 — coquille Tauri 2 (paquet WP-2) :

- CA-37 [état : à construire] La configuration de la coquille tient les contrôles statiques
  d'EF-P04-8 : `apps/desktop/src-tauri/tauri.conf.json` ne déclare aucune URL distante (ni
  `devUrl` en build de release, ni `frontendDist` hors du bundle), sa CSP est `default-src 'none'`
  élargie aux seules origines du schéma privé, le magasin de la vue web est déclaré non
  persistant, et `apps/desktop/src-tauri/capabilities/` énumère chaque commande du pont par nom,
  sans joker. Validation : `bun test apps/desktop/tests/shell/config.test.ts` (lit la
  configuration et les capacités ; trois vecteurs rouges vus rouges : une URL `https://` ajoutée,
  une directive CSP hors liste, une capacité `*`).
- CA-38 [état : à construire] Les contrôles dynamiques d'EF-P04-8 sont prouvés par vecteur rouge
  dans la coquille lancée : une requête du front vers une URL hors du schéma privé est refusée et
  comptée ; une commande non déclarée dans la capacité est refusée et comptée ; une écriture dans
  le magasin persistant de la vue web est refusée et comptée ; aucun port n'est en écoute pour le
  PID du processus Rust, le contrôle étant vu rouge quand un écouteur TCP est ouvert volontairement
  dans le processus de test (une ligne rendue par `lsof`, le contrôle échoue). Validation : `cargo test --locked -p libre-ai-p04-desktop shell_controls`
  (trois refus comptés) et `lsof -i -P -a -p PID` → 0 ligne pendant `bun run --cwd apps/desktop test:e2e` ;
  le compteur de refus est imprimé.

P04, jalon ADR-0057 — pont vers le cœur Rust (paquet WP-3) :

- CA-39 [état : à construire] Les commandes du pont (`open_vault`, `read_note`, `write_note`,
  `render_preview`, `search`, `rebuild_index`) sont portées par `crates/notebook-vault` et exposées
  par la coquille ; `read_note` rend les octets exacts du fichier ; `write_note` écrit par fichier
  temporaire, `fsync` et renommage, et laisse le fichier d'origine intact si l'écriture échoue ;
  `render_preview` rend un arbre d'attributs, jamais du HTML interprété. Validation :
  `cargo test --locked -p libre-ai-notebook-vault` (aller-retour exact sur les pièges d'octets du
  critère CA-34, écriture interrompue par injection d'erreur laissant l'original intact, aperçu sans
  balise) et `cargo test --locked -p libre-ai-p04-desktop bridge` (chaque commande répond par le
  type attendu ou un refus `vault.*` fermé).
- CA-40 [état : à construire] Le front ne réimplémente aucune fonction du cœur : aucun parseur
  Markdown, aucun accès direct au système de fichiers, aucun index côté TypeScript ; les
  dépendances de `apps/desktop/package.json` sont une liste fermée. Validation :
  `bun test apps/desktop/tests/bridge/no-reimplementation.test.ts` (refuse toute dépendance hors
  liste, tout import de `@tauri-apps/plugin-fs` ou d'un paquet Markdown, toute fonction de parsage
  dans `apps/desktop/src/` hors `src/bridge/` ; vecteur rouge : un import de `marked` ajouté vu
  rouge).

P04, jalon ADR-0057 — éditeur et aperçu (paquet WP-4) :

- CA-41 [état : à construire] L'éditeur CodeMirror 6 ne modifie aucun caractère non tapé : une
  séquence de frappe portant guillemets droits, deux tirets, trois points, une URL, deux espaces,
  un mot mal orthographié et une adresse est reçue par `write_note` octet pour octet ; l'aperçu
  en direct ne change que des attributs (le texte du document est inchangé après rendu).
  Validation : `bun run --cwd apps/desktop test:e2e` (Playwright webkit, test
  `the editor writes exactly the typed bytes` et test `the live preview changes attributes only`) ;
  vecteur rouge : une extension de substitution activée vue rouge.
- CA-42 [état : à construire] Les paquets du front sont épinglés en version exacte, publiés depuis
  au moins trois jours à l'épinglage, sous une licence admise (MIT, Apache-2.0, BSD, ISC, Zlib,
  Unicode-3.0, MPL-2.0), et consignés dans `apps/desktop/DEPENDENCIES.md` (nom, version, licence
  lue dans le paquet, date de publication). Validation :
  `bun test apps/desktop/tests/editor/dependencies.test.ts` (chaque entrée de `package.json` a une
  ligne du fichier, version exacte sans intervalle, licence dans la liste) et
  `bun install --frozen-lockfile` sous `bunfig.toml` (`minimumReleaseAge` 259200) sort 0.

P04, jalon ADR-0057 — série de mesures (paquet WP-5) :

- CA-43 [état : à construire] La série du protocole (CA-36) est rejouée dans la coquille construite,
  sur la machine déclarée et le corpus CR-10k, et son rapport est commité avec ses sorties brutes :
  AT-01 100 % des 10 000 fichiers identiques sur 20 passes et aucun octet hors du paragraphe édité ;
  AT-02 avec aperçu en direct p95 ≤ 16 ms (5 000 lignes) et ≤ 50 ms (1 Mio) ; NFR-03 p95 ≤ 100 ms
  (rendu de la zone visible d'abord admis) ; chaque ligne porte un verdict. Validation :
  `bun tools/qualification/p04-tauri/check-report.ts` (lit `reports/ID/manifest.json` : commit,
  machine, SHA-256 du corpus égal à celui de `PROTOCOL.md`, sorties brutes présentes, verdict par
  seuil ; sort non nul sur un rouge ou une sortie manquante ; imprime le nombre de seuils
  examinés).
- CA-44 [état : à construire] NFR-10 ≤ 500 Mio (application + index + interface, pic de vie sur 60
  lancements) et texte exposé à l'accessibilité = 100 % sur la note de 1 Mio sont mesurés dans la
  même série ; les seuils du rapport sont ceux du protocole, sans révision ; un rouge est consigné
  comme décision de surface à prendre par ADR, jamais comme seuil à réviser. Validation :
  `bun tools/qualification/p04-tauri/check-report.ts` (mêmes contrôles que CA-43 sur ces deux
  lignes) et `diff` des seuils entre `PROTOCOL.md` et `docs/apps/p04-tauri-qualification.md` → 0
  ligne.

P04, jalon ADR-0057 — qualification macOS et fiche (paquet WP-6) :

- CA-45 [état : à construire] La coquille est construite et lancée sur un runner macOS ;
  `lsof -i -P -a -p PID` ne montre aucun port en écoute ; `codesign --verify --strict --deep`
  passe ; `spctl --assess --type execute` passe ; un ticket de notarisation existe pour la release
  candidate (`xcrun stapler validate` sur le bundle) ; le bundle passe le scan de chemins machine
  du critère CA-5. Validation : workflow `.github/workflows/p04-desktop-macos.yml` vert, son journal portant
  les quatre sorties verbatim ;
  `gh run list -R libre-ai/personal-knowledge-workspace --workflow p04-desktop-macos.yml --limit 1 --json conclusion`
  → `success`.
- CA-46 [état : à construire] La fiche `project.v1.yaml` déclare la phase de qualification de P04
  avec le critère de sortie « série du protocole verte (CA-43, CA-44) », le plafond de mémoire
  résidente 500 Mio écrit avant toute mesure (texte du critère de sortie tant que le schéma de
  fiche n'a pas de champ dédié), et des `kill_predicates` reprenant AB-3 à AB-6 ; le commit qui
  écrit le plafond précède le premier rapport. Validation :
  `grep -c '500 Mio' project.v1.yaml` ≥ 1 et `grep -c 'kill_predicates: \[\]' project.v1.yaml` → 0 ;
  `git log --diff-filter=A --format=%ct -- tools/qualification/p04-tauri/reports` postérieur au
  commit qui ajoute `500 Mio` à la fiche (`git log -S'500 Mio' --format=%ct -- project.v1.yaml`) ;
  `check-inventory-drift` de `project-governance` vert.

## 9. Critères d'abandon

- AB-2 Si le propriétaire retire le besoin d'un P-xx du domaine (seule cause d'abandon admise,
  CADRAGE § 1.6), le chapitre correspondant est retiré de cette spécification et sa ligne du
  catalogue passe en « abandon ». Validation : une entrée de `docs/decisions/DECISION-REGISTER.md`
  de `project-governance` nomme le P-xx et le retrait ; sans cette entrée, le retrait n'a pas eu
  lieu.
- AB-3 Si les campagnes Gate B rejouées sur la classe `desktop-arm64-high-memory-reference` (CA-14)
  échouent deux fois de suite sur deux candidats corrigés, pour une cause autre que le refus par
  empreinte historique `QUALIFIED_CORE_SHA256` (décision Y41), le host web `apps/notebook` est
  retiré et seul le cœur `notebook-core` est conservé comme bibliothèque de la réplique chiffrée.
  Validation : deux rapports de campagne consécutifs liés au commit et au SHA-256 du manifeste de
  ressources (`docs/apps/notebook-resource-floor.md:50`), chacun en échec avec un code de refus
  différent du refus d'empreinte.
- AB-4 Si, à la levée du feature gate `NOTEBOOK_BACKUP_FEATURE_ENABLED`, le patch vendorisé
  `third_party/rustcrypto-aes-0.8.4` n'a toujours pas de gate de provenance I-28 dans
  `bun run check` (archive téléchargée, SHA-256 vérifié, `diff -r`) et n'est pas retiré au profit
  d'une version publiée équivalente, le chemin de sauvegarde chiffrée dans le navigateur est
  abandonné au profit du cœur natif seul. Validation : `ls third_party/rustcrypto-aes-0.8.4/`
  existe et `grep -rln 'rustcrypto-aes' package.json scripts tools/quality` ne renvoie aucun
  fichier (rejoué au SHA : aucun fichier).
- AB-5 Si, pour P03, P05, P06 ou P07, un commun dont `gh api repos/ORG/DEPOT --jq '[.archived,.pushed_at]'`
  donne `false` et une date de moins de 365 jours avant la mesure, sous une licence admise par
  I-11, couvre le besoin sans manque constaté par la matrice de parité exécutée ligne à ligne
  (CADRAGE § 1.6), aucun code n'est écrit dans ce dépôt pour ce P-xx et la ligne du catalogue
  devient « intégration ». Validation : matrice de parité versionnée dans le dépôt avec un verdict
  par ligne, et les deux relevés `gh api` datés par produit.
- AB-6 Si le journal local et le script du propriétaire (CA-31), lus le jour 29 de la fenêtre de
  28 jours consécutifs, donnent moins de 24 jours avec une note créée ou modifiée dans P04, ou
  montrent un lancement de l'outil de notes précédent, la part P04 du dépôt retourne au gel.
  Validation : nombre de jours < 24 ou lancements > 0 dans l'export du journal local, consigné par
  une entrée de `docs/decisions/DECISION-REGISTER.md` de `project-governance`.

Un seuil rouge de la série de mesures (CA-43, CA-44) n'est pas un critère d'abandon : c'est une
décision de surface, qui retourne à ADR-0044 pour P04 et se prend par ADR (`ADR-0057:66`). Le
numéro AB-1 de la mission (part P02) n'est pas réutilisé.

## 10. Dépendances

Internes (libre-ai) :

- `project-governance` : workflow `validate-composition.yml@0db2e10e` (`code-validation.yml:13`),
  outillage `@libre-ai/governance` (gates `check-bun-*`, `check-toolchain`, `check-secret-scan`,
  `check-personal-data-boundary`, `check-no-transmission`), `toolchains/bun.json`,
  `toolchains/notebook-qualification.json` ; norme `docs/specifications/WORK-PACKAGES.md` ; fiche
  `project.v1.yaml:24-26`. Attendu de l'autorité (ticket C du cadrage du 2026-10-23) : un champ de
  plafond de mémoire dans le schéma de fiche et un gabarit de coquille Tauri 2 sous `docs/method/` ;
  en attendant, CA-46 écrit le plafond dans le texte du critère de sortie.
- `schemas-and-contracts` : vecteurs dorés `notebook-core-v2` ; schémas `notebook-backup.v2`,
  `notebook-backup-seal-request.v2`, `context-document.v2`, `common.v1`, `problem-details.v1`.
  Contrats à créer : `knowledge-excerpt.v1` (avec `information-watch`), contrat de messages native
  messaging.
- `information-watch` : P02, producteur de l'extrait `knowledge-excerpt.v1` ; consommateur
  éventuel du code P02 de ce dépôt par import avec provenance ; le spike `@wdio/tauri-service` est
  fait une fois pour P02 et son verdict vaut pour la flotte (`ADR-0057:73`).
- `application-development-toolkit` : `@libre-ai/ui` (1 import), `@libre-ai/web-platform`
  (5 imports : CSP, handler) ; licence Apache-2.0 de ces paquets à confronter à EUPL-1.2 du dépôt.
- Bloc `overrides` de `package.json:10-23` : 11 clés `@libre-ai/*`, toutes de nature `override` ;
  7 ni déclarées ni importées au SHA (CA-8).
- Archivé : `ai-practice-workbench` (ancien porteur P07) — import avec provenance seulement.

Chevauchements avec d'autres specs, nommés sans demande de fusion :

- `information-watch` (P02) : frontière par fichier Markdown avec provenance (EF-D-3) ; aucune base
  commune ; le code P02 de ce dépôt en est une référence (`ADR-0054:39`).
- `learning-session-facilitation` (P39 et P07) : frontière non écrite entre P39 et le chapitre P07.
- `organization-data-lifecycle` (P37, P38) : la sauvegarde `notebook-backup.v2` et la rétention
  (ENF-12) relèvent du même périmètre.
- `signalement` : deux formats d'export local authentifié et deux voies de capture de page par
  extension (EF-P04-7) ; aucune comparaison faite.
- `collaborative-data-sync` : porteur de la sync chiffrée de bout en bout exigée par I-34, dont
  dépend la sync multi-appareils de P04 écartée de v1.
- `square-control` (P40) : même coquille Tauri 2 à sa première fenêtre (`ADR-0057:40`) ; exempté
  d'extension (`ADR-0042:235-272`, § 9).

Externes principales (`Cargo.toml:20-58` ; `package.json:24-32` ; `apps/notebook/package.json`) :
RustCrypto `aes` 0.8.4 (patché), `aes-gcm` 0.10.3, `argon2` 0.6.0, `ghash`, `polyval`, `subtle`,
`zeroize` ; `serde`, `serde_jcs` 0.2.0, `serde_json`, `sha2` 0.11.0 ; `wit-bindgen` 0.61.1,
`wasmparser` et `wit-component` 0.253.0 ; Bun ≥ 1.4.0, TypeScript 7.0.2, Biome 2.5.3, React 19.2.7,
`@playwright/test` 1.64.0 (e2e) et Playwright 1.61.1 (campagnes épinglées) ;
`@bytecodealliance/jco-transpile` 0.4.2 ; Node 26.5.0 (build Gate B) ; Rust 1.97.0 +
`wasm32-unknown-unknown` (`rust-toolchain.toml`). Le graphe P02 (`tokio`, `hyper`, `rustls`,
`tokio-postgres`, `blake3`, `flate2`, `url`) reste dans le verrou tant que le code de référence
est dans l'arbre. À adopter par le jalon ADR-0057, sous CA-42 et CA-6 : `tauri` 2 (MIT ou
Apache-2.0, dernière release `tauri-cli-v2.12.4` du 2026-10-21, `ADR-0057:27`), paquets
`@codemirror/*` 6 (MIT `[NON VÉRIFIÉ]`, à relever à l'épinglage), `pulldown-cmark` (MIT) et
`tantivy` (MIT) pour `notebook-vault` (versions mesurées par ADR-0044 : 0.13.4 et 0.26.2,
`ADR-0044:51`). UniFFI n'est plus candidat (`ADR-0057:46`).

## 11. Risques

| # | Risque | Effet | Mesure / parade |
| --- | --- | --- | --- |
| R1 | NFR-10 rouge sous Tauri : 413 Mio mesurés sans index sur la voie (b), 240 Mio de processus GPU WebKit (`ADR-0044:45`), contre un plafond de 500 Mio avec index ; « risque élevé de rouge » écrit dans l'option retenue par le propriétaire (`ADR-0057:92`) | retour au natif pour P04 par ADR ; le code de l'éditeur avance sous ce risque nommé | CA-44 ; plafond figé (ENF-7) ; protocole commité d'abord (CA-36) |
| R2 | Accessibilité rouge : 0,54 % du texte exposé sur la voie (b) (`ADR-0044:47`) ; l'arbre doit être maintenu par le front | même décision de surface | EF-P04-11 ; CA-44 |
| R3 | Modèle par blocs encore présent et planifié par `ROADMAP.md:9-13` alors que Y3 le retire comme autorité | double modèle, format verrouillé | Q2 de la mission ; EF-P04-4 ; CA-15 |
| R4 | Campagnes produit refusant la build migrée (`QUALIFIED_CORE_SHA256` historique) | Gate B non rejouable sur le code courant tant que le matériel de référence n'a pas rejoué | Q9 de la mission ; CA-14 ; AB-3 |
| R5 | Vérité terrain à construire (CR-10k, oracles) avant toute mesure | seuils figés sans mesure sous Tauri | CA-34, CA-35, CA-36 |
| R6 | Machine de mesure : les relevés d'ADR-0044 sont faits sur 36 Gio / 14 CPU, la classe de référence du PRD 11 est 32 Gio / 12 CPU | seuils non transposés à la machine de référence | la machine est déclarée dans `PROTOCOL.md` (CA-36) et dans chaque rapport (CA-43) |
| R7 | Code P02 de référence dans l'arbre : 43 mentions, 4 crates, 1 application, tests dans `bun run check` | charge de `bun run check` et de `Cargo.lock` sur du code sans critère ici | § 4.1 ; retrait = décision distincte, import avec provenance par `information-watch` |
| R8 | 7 clés `@libre-ai/*` du bloc `overrides` ni déclarées ni importées | résolution forcée vers 5 dépôts frères sans usage | CA-8 |
| R9 | `tantivy` candidat P04/P06 (rachat signalé, PRD 11 R11) | dépendance à risque | épinglage, `cargo deny`, interface d'index au seul point d'appel (`notebook-vault`) |
| R10 | Fiche `maturity: idea` sans P-xx, sans phase P04, sans plafond, sans `kill_predicates` | gates de flotte aveugles au chantier réel | CA-1 ; CA-46 ; AB-3 à AB-6 |
| R11 | `LICENSE` niant le code dans un dépôt public | lecteur externe induit en erreur (I-15) | Q4 de la mission ; CA-2 |
| R12 | Signature et notarisation (CA-45) exigent un compte Apple Developer, acte du propriétaire (`ADR-0042:226-229`) | WP-6 bloqué sans cet acte ; porte `one-way` | la qualification locale (CA-37 à CA-44) ne l'attend pas ; l'usage réel par le propriétaire n'en dépend pas |
| R13 | Spike `@wdio/tauri-service` fait pour P02 : son verdict vaut pour la flotte (`ADR-0057:73`) ; s'il est rouge, le parcours e2e de CA-41 doit passer par Playwright webkit contre le front seul | parcours fonctionnel mesuré hors coquille | CA-41 écrit sous Playwright webkit (D93) ; le verdict du spike est lu avant WP-4 |

## 12. Table de conformité à SPECIFICATION-STANDARD

Référence : `docs/specifications/SPECIFICATION-STANDARD.md` de l'autorité (13 sections
obligatoires). Colonne P04 : fichier et section où la section est traitée. Colonne P01, P03, P05,
P06, P07 : « absente : aucun code au SHA », sauf mention.

| # | Section du standard | P04 | P01, P03, P05, P06, P07 |
| --- | --- | --- | --- |
| 1 | Purpose and actors | § 2, § 3 ; `prd.md` § 1 à § 3 | § 2, § 3 (cadrage seul) ; absente : aucun code au SHA |
| 2 | Journeys | `prd.md` § 4 scénarios S1 à S6 ; `docs/apps/notebook.md:12-17` (héritée) | absente : aucun code au SHA |
| 3 | Non-goals | § 4.2 | § 4.2 ; absente : aucun code au SHA |
| 4 | Domain protocol | § 6 (commandes du pont, événements, refus `vault.*`) ; états `notebook.*` du code récupéré retirés comme autorité | absente : aucun code au SHA |
| 5 | Refusal matrix | § 6 (`error-code` WIT, `vault.*`) | absente : aucun code au SHA |
| 6 | Data | EF-P04-4 (autorité : dossier Markdown ; dérivés : index, état de fusion, réplique, caches) ; ENF-12 | absente : aucun code au SHA |
| 7 | Authentication and authorization | local, sans Biscuit ni RLS en v1 (`docs/apps/notebook.md:67`) ; écart à I-09 instruit en Q10 de la mission, dérogation nommée à écrire | absente : aucun code au SHA |
| 8 | Runtime boundaries | § 6 et EF-P04-8, EF-P04-9 : processus Rust (coquille, `notebook-vault`), WKWebView (front, CodeMirror 6), composant WASM (`notebook-core`) ; pont Tauri, aucun FFI UniFFI | absente : aucun code au SHA |
| 9 | Accessibility and degraded mode | ENF-9, ENF-10, ENF-11 ; EF-P04-11 ; CA-44 | absente : aucun code au SHA |
| 10 | Contracts | § 6 (WIT, `notebook-backup.v2`, `context-document.v2`, vecteurs dorés ; à créer : `knowledge-excerpt.v1`, native messaging) | absente : aucun code au SHA |
| 11 | Evidence | § 8 (CA-36, CA-43, CA-44 : protocole, rapport, sorties brutes, manifeste) ; harnais existant `tools/qualification/notebook-core-v2/` | absente : aucun code au SHA |
| 12 | Work packages | `prd.md` § 10 : six paquets, un par ligne, périmètres bornés, commande de vérification, porte | absente : aucun code au SHA |
| 13 | Release and rollback | CA-45 (signature, notarisation, scan du bundle) ; sortie : le dossier Markdown est la donnée, la réplique se rouvre par algorithmes publics ; rollback = revert de la pull request pour WP-1 à WP-5, décision de surface pour WP-6 | absente : aucun code au SHA |

Langage normatif et enveloppe commune : § 5 (MUST / SHOULD / MAY) ; aucune API HTTP dans ce dépôt
depuis le retrait de P02 comme produit, l'enveloppe `{data, meta}` ne s'applique qu'aux messages
de native messaging (§ 6). Protocole de mutation du standard (`commandId`, révision attendue,
`command.stale_revision`) : `write_note` porte une révision attendue (empreinte du fichier lue) et
refuse `vault.stale_revision` si le fichier a changé depuis la lecture ; la forme exacte est à
écrire avec CA-39.
