# personal-knowledge-workspace — cadrage de l'adaptateur de source git

Maturité du document : proposition. Statut : **non normatif**.

Objet : décrire un adaptateur qui lit un dépôt git local **aux objets d'une révision** (manifeste,
chevauchement, liste), le chargement vers une destination restant suspendu. Les chemins sans préfixe
sont relatifs à la racine de ce dépôt.

## 1. Statut et portée

Par décision du propriétaire du 2026-11-18 (prise hors de ce dépôt), ce sujet se réduit à une
spécification tant que le gel des produits autres que P04 tient. En conséquence :

- **ce document n'autorise aucun code** : ni crate, ni binaire, ni test, ni script, ni entrée dans la
  chaîne `check` ;
- **il n'ouvre aucun paquet de travail** : `docs/prd.md` § 10 reste la source unique des paquets, et
  son tableau est limité au jalon P04 ;
- **il ne porte aucun critère d'acceptation** : `docs/cahier-des-charges.md` § 4.1 exclut tout
  critère pour un chapitre sans code. Les numéros `INV`, `REF`, `OBS` et `QO` d'ici ne sont pas des
  critères `CA-n` et aucun gate ne les lit ;
- **il ne modifie ni le PRD, ni le cahier, ni la fiche** `project.v1.yaml`, qui priment sur lui en
  cas d'écart.

Le présent de l'indicatif décrit le comportement visé ; il n'oblige personne. Le rattachement du
sujet à un produit n'est pas tranché (§ 2) : le mot « adaptateur » ne préjuge ni du produit ni du
nom du crate.

## 2. Ce qu'il faut décider pour lever la suspension

| # | Décision du propriétaire | Où elle s'écrit | État constaté dans le dépôt | Ce qu'elle débloque |
| --- | --- | --- | --- | --- |
| 1 | Sortie du gel pour ce sujet | registre des décisions de `libre-ai/project-governance` | aucune sortie décidée | tout le reste |
| 2 | Produit porteur : P01 (proposé) ou P06 | `project.v1.yaml`, `products` | seul P04 est déclaré ; CA-1 est rouge. EF-P01-1 fait des connecteurs des adaptateurs de P01 appelant des briques en processus séparé. Si le porteur est P06 : EF-P06-1 impose de déclarer la place de l'index dans la fiche, et AB-5 impose une matrice de parité versionnée | le rattachement du code |
| 3 | Paquet de travail et critères | `docs/prd.md` § 10 (CA-n couverts, périmètre en chemins, commande de vérification, porte) et `docs/cahier-des-charges.md` § 4.1 et § 8 | aucun paquet hors P04 ; § 4.1 donne à P01 et P06 « aucun code » | l'écriture du code en lecture seule |
| 4 | Nom du crate | contrôle contre le LEXICON de l'autorité, absent de ce dépôt | nom candidat `crates/p01-git-source`, sur le modèle des préfixes `crates/p02-*` | la création du crate |
| 5 | Destination du chargement, et dépôt qui la porte | décision distincte, après les quatre premières | aucune destination : l'index de `crates/notebook-vault` est en mémoire, privé au crate, dérivé du seul dossier (EF-P04-4), sans notion de jeu ni de version ; le cahier § 4.2 place le traitement par un modèle de langage hors v1 | le chargement seul (§ 9) |
| 6 | Réponses aux questions du § 8 | ce document, puis le paquet de travail | ouvertes | la forme exacte des entrées, sorties et refus |

Les décisions 1 à 4 et 6 suffisent à la partie en lecture seule ; la décision 5 ne concerne que le
chargement.

## 3. Périmètre fonctionnel

L'adaptateur est un binaire autonome, lancé en processus séparé, sans lien avec `notebook-vault`. Il
lit par le git système en processus fils et n'embarque aucune bibliothèque git : `deny.toml` reste
inchangé.

| Sous-commande | Rôle | Ouvre le dépôt |
| --- | --- | --- |
| `manifest` | valide le manifeste | non |
| `overlap` | compte les entrées incluses et les chevauchements à la révision | oui |
| `list` | imprime les fichiers retenus, un chemin relatif par ligne, puis les compteurs | oui |

Hors périmètre : le chargement (`load`, § 9), toute émission réseau, les connecteurs d'autres
sources, toute modification de `crates/notebook-vault`, de son index ou de ses exports. Le type
`Revision` de `notebook-vault` (empreinte SHA-256 d'une note) est un homonyme : l'adaptateur ne le
réutilise pas et n'exporte aucun type public de ce nom.

## 4. Entrées

| Entrée | Forme | Remarque |
| --- | --- | --- |
| `DEPOT` | chemin d'un dépôt git local | non ouvert par `manifest`, qui accepte un chemin inexistant |
| `REVISION` | expression de révision | résolue une seule fois (INV-2) |
| `MANIFESTE` | chemin d'un fichier JSON | seul fichier lu hors du magasin d'objets ; c'est une entrée, pas une source |

Le manifeste est un objet fermé à trois champs ; tout champ inconnu le rend invalide.

| Champ | Type | Règle |
| --- | --- | --- |
| `schema_version` | chaîne | valeur unique admise, fixée par le crate |
| `include` | liste non vide de chemins | racines à lister |
| `exclude` | liste de chemins, éventuellement vide | chemins qu'aucune racine incluse ne doit couvrir |

```json
{
  "schema_version": "VERSION",
  "include": ["docs", "notes/2026"],
  "exclude": ["archives/prive"]
}
```

Un chemin de manifeste est littéral, relatif, à séparateur `/`. Il est refusé s'il est vide ou
absolu, s'il contient un composant vide, `.` ou `..`, un caractère de contrôle ou une barre oblique
inverse. Aucun motif n'est interprété.

## 5. Sorties

### 5.1 Flux

- **stdout** : lignes `clé=valeur` stables. `list` imprime d'abord les chemins, puis les compteurs ;
  les compteurs occupent les dernières lignes, dans l'ordre du tableau ci-dessous, de sorte qu'un
  fichier nommé `files=3` reste sans ambiguïté.
- **stderr** : un code de refus fermé, sans chemin absolu, jeton ni contenu (ENF-1).

### 5.2 Classes d'une entrée

| Classe | Définition |
| --- | --- |
| `included` | sous une racine incluse et sous aucun chemin exclu |
| `excluded_overlap` | sous une racine incluse et sous un chemin exclu |
| `readable` | `included`, fichier régulier, non vide, nom admis |
| `unsupported` | `included`, lien symbolique ou sous-module |

### 5.3 Compteurs

| Compteur | Sens |
| --- | --- |
| `revision` | identifiant d'objet complet résolu |
| `included_files` | entrées de classe `included` |
| `excluded_overlap` | entrées de classe `excluded_overlap` |
| `readable` | entrées de classe `readable` |
| `unsupported` | entrées de classe `unsupported` |
| `files` | fichiers retenus |
| `bytes` | somme des tailles des fichiers retenus |

Relations : `included_files` = `readable` + `unsupported` + entrées refusées pour leur nom ou parce
qu'elles sont vides ; `files` = `readable` quand le code de sortie est 0 ; `bytes` = somme des tailles
des `files`. La première relation ne se vérifie pas sur la sortie seule (QO-4).

### 5.4 Codes de sortie

| Code | Sens |
| --- | --- |
| 0 | succès |
| 1 | refus (§ 6) |
| 2 | usage : sous-commande ou argument manquant ou inconnu |
| 3 | source illisible : dépôt absent, révision introuvable, objet absent localement, git système absent ou en échec |

## 6. Refus

Un refus est entier : code 1 et aucun chemin imprimé, même si d'autres entrées étaient lisibles.

| # | Cause |
| --- | --- |
| REF-1 | manifeste invalide (§ 4) |
| REF-2 | `excluded_overlap` ≥ 1 |
| REF-3 | `unsupported` ≥ 1 |
| REF-4 | fichier vide sous une racine incluse |
| REF-5 | nom vide ou de plus de 255 caractères |
| REF-6 | nom contenant un guillemet double, une barre oblique inverse ou un caractère de contrôle |
| REF-7 | aucun fichier retenu |

## 7. Invariants de lecture

Les observations `OBS-n` sont au § 7.2. Elles montrent pourquoi une lecture naïve ne tient pas
l'invariant.

### 7.1 Invariants

- **INV-1 — Objets seulement.** L'adaptateur ne lit jamais l'arbre de travail ni l'index. Un fichier
  modifié, supprimé ou non suivi ne change ni la liste ni `bytes` (OBS-1).
- **INV-2 — Révision résolue une fois.** `REVISION` est résolue en identifiant de commit complet, en
  exigeant un commit (`--verify --end-of-options "REVISION^{commit}"`), puis seul cet identifiant sert
  aux lectures suivantes et il est imprimé. Une forme non pelée accepte un identifiant inexistant
  (OBS-2). Sa longueur n'est pas supposée : 40 ou 64 caractères selon le format du dépôt (OBS-3).
- **INV-3 — Aucune substitution d'objet.** Le contenu lu est celui de la révision imprimée : les
  références `refs/replace` sont neutralisées (OBS-4).
- **INV-4 — Le dépôt nommé, et lui seul.** `DEPOT` n'est pas résolu en remontant vers un dépôt parent
  (OBS-5).
- **INV-5 — Environnement scellé.** L'environnement du processus fils est vidé, puis réduit à ce qui
  suit, en plus de ce qu'exige le lancement de git.

  | Variable | Valeur | Effet |
  | --- | --- | --- |
  | `GIT_CONFIG_NOSYSTEM` | `1` | ignore la configuration système |
  | `GIT_CONFIG_GLOBAL` | `/dev/null` | ignore la configuration globale |
  | `GIT_TERMINAL_PROMPT` | `0` | interdit toute invite |
  | `GIT_NO_LAZY_FETCH` | `1` | interdit la récupération paresseuse (OBS-6) |
  | `GIT_LITERAL_PATHSPECS` | `1` | désactive l'interprétation des motifs |
  | `GIT_NO_REPLACE_OBJECTS` | `1` | tient INV-3 |
  | `GIT_CEILING_DIRECTORIES` | répertoire parent de `DEPOT` | tient INV-4 |

- **INV-6 — Aucun réseau.** Un objet absent localement est une source illisible (code 3), jamais un
  accès réseau (OBS-6).
- **INV-7 — L'absence se lit dans la sortie de git.** Le code de sortie de git ne suffit pas : un
  objet absent peut sortir 0 (OBS-7). Toute réponse `missing` ou taille non numérique vaut code 3.
- **INV-8 — Périmètre.** Aucun appel ne nomme un chemin hors des racines incluses. Sous une racine,
  les noms de l'arbre sont parcourus pour classer les entrées ; le contenu d'un chemin exclu n'est
  jamais lu et son nom n'est jamais imprimé (QO-5).
- **INV-9 — Le type vient de l'arbre.** Lien symbolique (`120000`) et sous-module (`160000`) se lisent
  dans le mode de l'entrée, jamais par le système de fichiers (OBS-3).
- **INV-10 — Noms à l'octet.** Les noms sont lus séparés par NUL et rendus octet pour octet (OBS-8).
  Une racine transmise à git n'est pas recomposée au passage (OBS-9).
- **INV-11 — Messages fermés.** La sortie d'erreur de git n'est jamais relayée : elle porte des
  chemins absolus (OBS-10).
- **INV-12 — Lecture sans écriture.** L'adaptateur n'écrit rien dans le dépôt lu (OBS-11) et n'exécute
  aucune commande tirée de sa configuration (OBS-12).

### 7.2 Observations mesurées

Mesures du 2026-11-18 avec git 2.56.1 sur macOS arm64, sur des dépôts synthétiques créés pour
l'occasion. Elles sont datées : à rejouer avec la version de git visée avant de s'en servir. `OID`
désigne un identifiant complet.

| # | Situation | Résultat |
| --- | --- | --- |
| OBS-1 | `ls-tree -r -z -l OID` avant et après une modification, une suppression et un fichier non suivi dans l'arbre de travail | sorties identiques |
| OBS-2 | `rev-parse --verify` sur un identifiant complet inexistant ; même commande avec `^{commit}` ; forme `--output=x^{commit}` après `--end-of-options` | sortie 0 ; sortie 1 ; sortie 1 |
| OBS-3 | `ls-tree -r -l` sur un lien, un sous-module et un fichier vide ; `rev-parse` dans un dépôt `--object-format=sha256` | modes `120000` et `160000` (type `commit`, taille `-`), taille `0` ; identifiant de 64 caractères |
| OBS-4 | `git replace OID AUTRE`, puis `ls-tree -r --name-only OID` | `rev-parse` rend `OID`, mais la liste est celle d'`AUTRE` ; avec `GIT_NO_REPLACE_OBJECTS=1`, la liste est celle d'`OID` |
| OBS-5 | `git -C DEPOT/sous-dossier rev-parse` ; même commande avec `GIT_CEILING_DIRECTORIES=DEPOT` ; à la racine avec le parent de `DEPOT` comme plafond | sortie 0, dépôt parent trouvé ; sortie 128 ; sortie 0 |
| OBS-6 | clone partiel `--filter=blob:none` depuis un distant `file://`, lecture d'un blob absent | sans garde : blob récupéré, sortie 0 ; avec `GIT_NO_LAZY_FETCH=1` : sortie 128 ; avec `GIT_ALLOW_PROTOCOL=none` seul : sortie 128 |
| OBS-7 | blob absent : `ls-tree -r -l` ; `cat-file --batch-check` ; arbre absent : `ls-tree -r` | sortie 0, taille affichée `BAD` ; sortie 0, ligne `OID missing` ; sortie 1 |
| OBS-8 | nom accentué listé sans `-z`, puis avec `-z` | `"docs/\303\251 t.md"` entre guillemets ; octets bruts |
| OBS-9 | dépôt créé sur macOS (`core.precomposeunicode=true`), arbre dont le nom est en NFD, racine NFD passée en argument de `ls-tree` ; même appel avec `-c core.precomposeunicode=false` | sortie vide ; entrée trouvée |
| OBS-10 | `git -C` sur un chemin inexistant | le chemin absolu figure dans stderr |
| OBS-11 | empreintes SHA-256 des 27 fichiers de `.git` avant et après trois passes de `ls-tree`, `cat-file --batch-check` et `cat-file blob` | identiques |
| OBS-12 | `core.fsmonitor`, `core.sshCommand`, `core.pager`, `core.gitProxy`, `core.editor` et `alias.ls-tree` posés dans la configuration locale, lecture par `rev-parse`, `ls-tree`, `cat-file --batch-check` | aucune commande exécutée (0 fichier témoin) ; mesure limitée à ces six réglages et ces trois commandes |
| OBS-13 | racine absente, seule ou à côté d'une racine présente, passée à `ls-tree -r` | sortie 0, aucune ligne pour la racine absente |
| OBS-14 | blob tronqué de moitié dans le magasin d'objets | `ls-tree -l` et `cat-file --batch-check` : taille rendue, sortie 0 ; `cat-file blob` : sortie 128 |
| OBS-15 | arbres construits par `git mktree -z` avec les noms `..`, `.`, `.git`, `-rf` ; répertoire nommé `..` | noms acceptés et listés ; `../n.md` listé |
| OBS-16 | arbre construit avec le nom d'octets `62 61 64 ff 2e 6d 64` | listé tel quel : un nom de l'arbre n'est pas forcément de l'UTF-8 |
| OBS-17 | `objects/info/alternates` pointant vers un autre dépôt | un objet absent du dépôt nommé devient lisible |
| OBS-18 | racines imbriquées `docs` et `docs/sub` passées au même `ls-tree -r` | chaque entrée listée une fois |

## 8. Questions ouvertes

Chaque question appelle une décision avant le paquet de travail. La recommandation n'engage rien
tant que le propriétaire n'a pas répondu.

| # | Question | Pourquoi elle se pose | Recommandation |
| --- | --- | --- | --- |
| QO-1 | Refuser les composants `.`, `..` et `.git` venus de l'arbre ? | REF-5 et REF-6 ne les couvrent pas, alors qu'un arbre peut les porter (OBS-15) : `list` imprimerait `../n.md` à un consommateur qui s'en servirait comme chemin | oui, comme nouvelle cause de refus ; s'aligner sur la grammaire fermée de `crates/notebook-vault/src/path.rs`, qui refuse tout composant commençant par `.` |
| QO-2 | Que vaut une racine incluse absente de la révision ? | git ne la signale pas (OBS-13) : une racine manquante à côté d'une racine présente passerait pour un succès partiel silencieux | refus, code 1 : une source déclarée et non trouvée n'est pas un zéro |
| QO-3 | `list` doit-elle lire le contenu des fichiers retenus ? | les tailles viennent de l'en-tête de l'objet : un blob tronqué sort 0 (OBS-14), donc un code 0 n'atteste pas que le contenu est lisible | oui : lire chaque blob retenu, tout échec vaut code 3 ; à défaut, écrire que `bytes` est une taille déclarée qui n'atteste aucune intégrité |
| QO-4 | Imprimer un huitième compteur `refused` ? | sans lui, `included_files` = `readable` + `unsupported` + refusés ne se vérifie pas sur la sortie ; il faut aussi fixer la partition (le type avant le nom) et la valeur de `files` et `bytes` après un refus | oui ; le type prime sur le nom ; `files=0` et `bytes=0` après un refus |
| QO-5 | `exclude` est-il bien une assertion, et non un filtre ? | tout chevauchement refuse la liste entière, donc `exclude` ne retranche jamais rien d'une racine ; détecter le chevauchement oblige à parcourir les noms sous la racine, ce que « ni lus ni listés » ne dit pas | confirmer l'assertion, et lire « ni lus » comme « contenu jamais lu, nom jamais imprimé » (INV-8) |
| QO-6 | Comment comparer `exclude` aux noms de l'arbre ? | à l'octet, `Secret` ou une forme NFD échappent à un `exclude` écrit `secret` ou en NFC (OBS-9) | comparaison à l'octet, écrite comme telle ; décider si les variantes de casse et de normalisation refusent aussi, ce qui demanderait une dépendance directe |
| QO-7 | Admettre un nom qui n'est pas de l'UTF-8 ? | l'arbre le permet (OBS-16) et la sortie est du texte | refus, comme nouvelle cause |
| QO-8 | La limite de 255 porte-t-elle sur des caractères ou des octets, sur un composant ou sur le chemin ? | REF-5 ne le précise pas | 255 octets par composant et 1 024 octets par chemin, comme `crates/notebook-vault/src/path.rs` |
| QO-9 | Racines dupliquées ou imbriquées dans `include` ? | une lecture racine par racine compterait deux fois la même entrée ; un appel unique ne le fait pas (OBS-18) | manifeste invalide |
| QO-10 | Accepter un dépôt à objets alternatifs ? | des objets viendraient d'un autre dépôt que celui nommé (OBS-17) | refus, code 3 |
| QO-11 | Quelle version minimale de git, et quel exécutable ? | une version qui ignore `GIT_NO_LAZY_FETCH` laisserait passer un accès réseau sans le dire ; cette version n'est pas relevée ici. Résoudre `git` par `PATH` laisse le choix du binaire à l'environnement appelant | relever le plancher et le vérifier au lancement ; ajouter `GIT_ALLOW_PROTOCOL=none` comme seconde barrière (OBS-6) ; décider d'un chemin d'exécutable explicite |
| QO-12 | Quelles expressions de `REVISION` admettre ? | `:/texte` ou `@{1}` dépendent de l'état local du dépôt | référence ou identifiant complet |
| QO-13 | Que rendent `manifest` et `overlap` ? | leur stdout n'est pas fixé, ni les refus de `overlap` au-delà de REF-1 et REF-2, ni l'ordre entre les codes 1 et 3 quand les deux s'appliquent | `manifest` n'imprime que `schema_version` ; `overlap` n'applique que REF-1 et REF-2 ; le code 3 prime, les compteurs étant alors incomplets et non imprimés |
| QO-14 | Borner la taille du manifeste et le nombre de ses chemins ? | le manifeste est une entrée de confiance limitée, lue en entier | oui, bornes à fixer avec le paquet de travail |
| QO-15 | Le stdout de `list` est-il compatible avec ENF-1 ? | ENF-1 écarte les chemins de dossier des journaux et des artefacts ; `list` imprime par fonction des chemins relatifs | écrire que ce flux est un résultat, jamais un journal, et que son consommateur ne le journalise pas |

## 9. Chargement suspendu

Aucune sous-commande `load` n'est décrite ici : sa destination n'existe pas (§ 2, décision 5). Quand
elle sera nommée, ces contraintes seront à reprendre :

- une seule requête par chargement, une partie par fichier nommée par le chemin relatif exact, un
  jeu neuf par révision ;
- le corps relu par l'analyseur de la destination, de sorte qu'un document modifié après la première
  passe ou un nom coupé à son dernier segment soit détecté ;
- un délai borné, aucun suivi de redirection, une clé lue dans l'environnement et jamais imprimée,
  le refus des adresses portant des identifiants.

Le réseau n'entrerait dans l'adaptateur que par cette décision : ENF-11 demande aujourd'hui des
fonctions locales sans réseau pour P04, et le cahier § 4.2 place le traitement par un modèle de
langage hors v1.
