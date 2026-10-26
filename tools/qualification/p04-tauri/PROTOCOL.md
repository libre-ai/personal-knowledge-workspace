<!-- SPDX-FileCopyrightText: 2026 Libre AI contributors -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# P04 — protocole de la série de mesures (ADR-0057 § 3)

Ce fichier fige le protocole de la série de mesures de P04 avant la première mesure
(`INVARIANTS:14`, I-08 ; `ADR-0057:52`, § 3 ; critère CA-36 de `docs/cahier-des-charges.md`).
Il est commité avant tout rapport : `tools/qualification/p04-tauri/reports/` n'existe pas à ce
commit, et le paquet WP-5 y écrit le rapport de la série.

Une fois la première mesure faite, aucune valeur de ce fichier ne change. Un seuil rouge au terme
de la série n'est pas une révision du seuil : c'est une décision de surface, qui retourne à
ADR-0044 pour P04 et se prend par ADR (`ADR-0057:66`). Le mot « Mio » désigne 1 048 576 octets.

Références : `docs/prd.md` § 5 (seuils) ; `docs/cahier-des-charges.md` critères CA-34 à CA-36,
CA-43, CA-44 ; `ADR-0057:50-66` ; `ADR-0044:35-48` (protocole et mesures datées du 2026-10-08, hors
Tauri, ni verdict ni baseline pour cette série).

## 1. Champs figés

Les champs de ce tableau sont lus par `protocol.test.ts` ; la colonne « Champ » est la clé.

| Champ | Valeur |
| --- | --- |
| `at-01-passes` | 20 |
| `at-02-keystrokes-per-configuration` | 3000 |
| `nfr-03-launches` | 60 |
| `nfr-10-launches` | 60 |
| `percentile` | p95 |
| `percentile-method` | rang le plus proche, sur les échantillons poolés |
| `keystroke-timeout-ms` | 2000 |
| `keystroke-timeout-verdict` | +oo |
| `launch-rejected-when` | session verrouillée ou écran éteint ; le lancement est refait |
| `machine-class` | desktop-arm64-high-memory-reference |
| `memory-ceiling-mib` | 500 |
| `corpus-seed` | 0x50303454 |
| `corpus-files` | 10000 |
| `corpus-sha256` | 451bc87dc3c069d15827af02d2cd799501f98b116967aa984f5a6bc40c457bed |
| `accessibility-method` | API d'accessibilité macOS ; proportion du texte exposé |
| `preview-delay-ms` | 120 |
| `at-01-edit-text` | p04 |
| `at-02-typed-cycle` | abcdefghijklmnopqrstuvwxyz |
| `at-02-pause-ms` | 150 |
| `nfr-10-sample-period-ms` | 100 |
| `nfr-10-hold-ms` | 5000 |
| `save-timeout-ms` | 10000 |
| `at-01-key-gap-ms` | 20 |
| `nfr-03-end-timeout-ms` | 2000 |
| `frame-period-intervals` | 600 |
| `timestamp-control-block-ms` | 500 |
| `timestamp-control-min-latency-ms` | 250 |
| `ax-string-range-chars` | 10000 |
| `series-stop-consecutive` | 3 |

Les quatorze dernières lignes sont des paramètres de procédure du § 10, ajoutés avant la première
mesure ; ce ne sont ni des seuils ni des effectifs.

## 2. Effectifs

- **AT-01** : 20 passes. Une passe comprend un aller-retour sans édition des 10 000 fichiers du
  corpus (ouverture puis fermeture dans la coquille construite) et une édition d'un paragraphe par
  fichier éditable. Chaque passe est comparée à l'état d'avant par l'oracle octet à octet
  (`oracle.ts`, SHA-256 par fichier, diff borné aux octets du paragraphe édité). Le nombre de
  fichiers examinés et le nombre d'éditions examinées sont imprimés et consignés dans le rapport.
- **AT-02** : 3 000 frappes par configuration, pour chacune des deux configurations (note de
  5 000 lignes, note de 1 Mio), aperçu en direct actif. Les 3 000 mesures d'une configuration sont
  un seul échantillon.
- **NFR-03** : 60 lancements, un échantillon par lancement (première ouverture de la note de
  1 Mio, aperçu actif).
- **NFR-10** : 60 lancements, un échantillon par lancement (pic de vie de la mémoire résidente
  de l'application, de l'index et de l'interface, note de 1 Mio ouverte avec aperçu).

## 3. Seuils

Les seuils sont ceux de `docs/prd.md` § 5, sans révision. Ils sont figés avant mesure
(`ADR-0042:146-161`, § 6 ; `INVARIANTS:14`, I-08). Une comparaison est inclusive : une valeur
égale au seuil est conforme.

| Mesure | Seuil |
| --- | --- |
| AT-01, aller-retour sans édition sur CR-10k | 100 % des 10 000 fichiers identiques à l'octet, 20 passes |
| AT-01, édition d'un paragraphe | aucun octet modifié hors du paragraphe |
| AT-02, latence frappe → rendu, aperçu en direct actif, 5 000 lignes | p95 ≤ 16 ms |
| AT-02, latence frappe → rendu, aperçu en direct actif, 1 Mio | p95 ≤ 50 ms |
| NFR-03, première ouverture d'une note de 1 Mio, aperçu actif | p95 ≤ 100 ms |
| NFR-10, mémoire résidente, application + index + interface | ≤ 500 Mio, plafond figé avant mesure |
| Texte d'une note de 1 Mio exposé à l'accessibilité | 100 % |

Pour NFR-03, le rendu de la zone visible d'abord est admis (`ADR-0044:24`) : l'instant mesuré est
celui où la zone visible est rendue.

## 4. Statistique

Le p95 est calculé au rang le plus proche sur l'ensemble des échantillons d'une mesure, tous
passes ou lancements confondus : les échantillons sont triés par valeur croissante, et le p95 est
l'échantillon de rang `ceil(0.95 × N)` (rang compté à partir de 1). Pour 3 000 frappes, le rang est
2 850 ; pour 60 lancements, il est 57. Aucune interpolation, aucune moyenne de p95 par passe.

## 5. Règles de rejet

- Une frappe dont le rendu n'est pas observé en 2 s (`keystroke-timeout-ms`, § 1) vaut +oo
  (infini) : elle reste dans l'échantillon, triée en dernier, et elle n'est pas rejetée.
- Un lancement fait session verrouillée ou écran éteint est rejeté et refait ; le nombre de
  lancements rejetés et leur cause sont consignés dans le rapport, et l'effectif de 60 est
  complété par des lancements valides.
- Précisions de ce protocole, hors texte de CA-36 : aucune autre valeur n'est écartée (une valeur
  aberrante lente reste dans l'échantillon) ; une passe AT-01 interrompue (causes du § 10.7) n'est pas
  comptée, elle est consignée et refaite, jusqu'à 20 passes menées à terme.

## 6. Machine de mesure

La machine appartient à la classe `desktop-arm64-high-memory-reference` de
`toolchains/notebook-resource-classes.json` (darwin, arm64, au moins 32 Gio de mémoire physique et
12 CPU logiques). Le rapport de la série déclare la machine réelle (modèle, mémoire, CPU, système)
dans son manifeste (critère CA-43). Les relevés d'ADR-0044 ont été faits sur une machine de
36 Gio et 14 CPU, ce qui dépasse la classe de référence du PRD (risque R6 du cahier).

Le plafond de mémoire de NFR-10 est de 500 Mio, valeur propre de P04 (`ADR-0057:72`, § 4), figée
avant mesure.

## 7. Corpus CR-10k

Le corpus est produit par `tools/qualification/p04-tauri/cr10k.ts` (critère CA-34) : graine fixe
`0x50303454`, 10 000 notes, 60 000 liens wiki (six par note), une note de 1 Mio exactement
(1 048 576 octets), une note de 5 000 lignes, et les pièges d'octets suivants, chacun présent dans
au moins un fichier : CRLF, CR seul, BOM, tabulations, espaces de fin de ligne, fin de fichier
sans saut de ligne, NFD et NFC, caractères hors BMP. Les données sont synthétiques.

Le SHA-256 d'ensemble est le SHA-256 des lignes `<SHA-256 du fichier>  <chemin>` (deux espaces,
saut de ligne final, format de `sha256sum`) triées par chemin. Il se rejoue par
`bun tools/qualification/p04-tauri/cr10k.ts digest`, et il est égal à `corpus-sha256` du § 1 :
`cr10k.test.ts` le vérifie. Une modification du générateur qui change cette empreinte est un
changement de corpus, donc de protocole ; elle n'est pas admise après la première mesure.

## 8. Mesure de l'accessibilité

Le texte exposé est mesuré par l'API d'accessibilité macOS, lue sur l'application lancée, sur la
note de 1 Mio ouverte dans l'éditeur. La proportion est le nombre de caractères du texte de la note
que l'API restitue, identiques à ceux du fichier à la même position, divisé par le nombre de
caractères du fichier. Un caractère exposé mais différent de celui du fichier ne compte pas. Le
seuil est de 100 % (`ADR-0057:66`, arbitrage distinct du 2026-10-23). Les attributs et les appels
d'accessibilité lus, et l'unité de caractère, sont fixés au § 10.6 avant la première mesure ; le
rapport les reprend.

## 9. Ce que ce protocole ne fait pas

- Il ne contient aucune valeur mesurée des critères de la série : aucune mesure de la série n'a été
  faite à ce commit (`docs/prd.md` § 5, colonne « Valeur courante »). Les relevés datés du § 10
  (instants de rendu et cadence des rappels, résolution des horloges, noms des processus, rappels
  suspendus en fenêtre masquée, boîte du défileur et lignes rendues à l'ouverture) sont des sondes
  de l'instrument, faites hors série, sans frappe système ; aucun n'est un échantillon d'une mesure
  du § 3.
- Il ne qualifie pas la machine de mesure et ne signe rien : la qualification macOS est le paquet
  WP-6.
- Le choix du paragraphe édité par fichier pour AT-01 est fixé au § 10.5 avant la série et
  consigné dans le manifeste du rapport ; il ne dépend d'aucun résultat.
- Les pièges d'octets du § 7 portent sur le contenu des fichiers. Les 10 000 chemins du corpus sont
  en ASCII (`notes/NN/note-NNNNN.md`) : la normalisation Unicode des noms de fichier (NFC et NFD
  sur APFS) n'est pas exercée par ce corpus. Un renommage entre les deux formes serait rapporté par
  l'oracle comme un fichier manquant et un fichier ajouté ; il n'est pas provoqué.
- L'oracle compare des fichiers réguliers. Un répertoire vide ajouté ou supprimé ne porte aucun
  octet et n'est pas rapporté ; un lien symbolique, lui, fait refuser la comparaison. Un instantané
  de référence est produit par l'outil lui-même : l'oracle ne valide pas un instantané écrit à la
  main (clés dupliquées comprises, la dernière valeur est retenue).

## 10. Bornes et procédures de mesure

Cette section fixe, avant la première mesure, ce que chaque mesure lit, entre quelles bornes et
par quelle commande. Elle ne change ni un seuil du § 3 ni un effectif du § 2. Tout se mesure dans
la coquille construite (`ADR-0057:52`) : le binaire de série du paquet WP-7 est bâti sur la
bibliothèque de la coquille et sur son front embarqué ; il n'y ajoute qu'un sélecteur de racine
injecté (le dialogue natif ne s'automatise pas) et un script d'instrumentation, qui rend ses
relevés par le titre du document, sans port. La fenêtre de la coquille est visible et au premier
plan pendant toute mesure. Le dossier ouvert est une copie neuve du corpus CR-10k, écrite par
`cr10k.ts` et vérifiée contre `corpus-sha256` avant chaque passe ou lancement.

### 10.1 Instant peint

L'instant où un changement de l'éditeur est peint est l'horodatage `performance.now()` lu en
première instruction, avant tout contrôle du script, d'un rappel `requestAnimationFrame` : c'est le
début de la mise à jour de rendu qui peint le changement, WebKit exécutant les rappels
`requestAnimationFrame` d'une mise à jour avant son style, sa mise en page et sa peinture. C'est une
borne basse de la peinture observable depuis la page quand le changement est fait avant le début de
cette mise à jour. L'écart entre la borne et la peinture est la durée du style, de la mise en page
et de la peinture de cette mise à jour, puis de sa composition par le processus GPU de WebKit : il
n'est pas observé, et il n'est inférieur à une période de trame que si la mise à jour tient dans
son budget. Le rappel qui porte la borne est fixé par mesure :

- **AT-02** : le premier rappel que le script d'instrumentation demande dès qu'il observe le
  changement, par un `MutationObserver` posé sur l'élément de contenu de l'éditeur (`.cm-content`),
  qui existe alors (la note est ouverte avant la première frappe), avec les options `childList`,
  `subtree` et `characterData` vraies. Le caractère tapé entre dans le DOM pendant la tâche de
  l'événement clavier, hors de tout rappel `requestAnimationFrame` (inféré du cheminement de la
  saisie dans WebKit, non mesuré) ; s'il y entrait pendant un rappel, la borne aurait une mise à
  jour de retard, et l'écart consigné ci-dessous la montrerait de l'ordre d'une période de trame.
- **NFR-03** : la racine de l'éditeur, son point de montage et son élément de contenu naissent dans
  une même tâche synchrone (`openNote`, `apps/desktop/src/editor/note-editor.ts`, lu au dépôt), qu'aucun
  observateur posé sur `.cm-content` ne peut voir ; que le premier dessin de la zone visible ait lieu
  dans cette même tâche est inféré du constructeur de CodeMirror, non mesuré. Le script demande donc
  un rappel `requestAnimationFrame` dès la borne de début, puis un nouveau rappel depuis chaque
  rappel tant que l'état de fin du § 10.3 n'est pas atteint ; il évalue cet état après la lecture de
  l'horodatage, et la borne est l'horodatage du premier rappel où il est atteint. Cette boucle a
  deux effets, tous deux vers le haut (sévères) : elle cale le rendu sur les trames, de sorte qu'un
  état atteint entre deux trames attend la suivante (de 0 à une période de trame, inféré du même
  régime qu'au paragraphe ci-dessous) ; et quand l'éditeur dessine la zone dans l'un de ses propres
  rappels de la même mise à jour, exécuté après celui du script, l'état n'est vu qu'au rappel
  suivant (une période de trame). Le biais total va de 0 à deux périodes de trame ; le nombre de
  rappels et la période de trame consignés ci-dessous permettent de le lire.

Le rapport consigne, par configuration d'AT-02, l'écart entre l'observation du changement et la
borne de fin (nombre, p50, p95, maximum), ce qui distingue cette borne de toute autre ; pour
chaque lancement de NFR-03, le nombre de rappels demandés jusqu'à la borne. La période de trame est
relevée au début de chaque lancement d'AT-02 et de NFR-03, avant toute frappe et avant l'ouverture
mesurée : `frame-period-intervals` (§ 1) intervalles entre rappels `requestAnimationFrame`
successifs, dont le nombre, le p50, le p95 et le maximum sont consignés. Pendant les frappes
d'AT-02, le script ne demande aucun rappel `requestAnimationFrame` en dehors de ceux de la borne
de fin : le relevé qui a fondé cette
définition a été fait page au repos, et une boucle de rappels continue cale le rendu sur les
trames, de sorte qu'un changement attendrait la trame suivante (inféré, non mesuré). Cette règle ne
lie que le script : les rappels propres de l'application (mesure de CodeMirror, aperçu) font partie
de ce qui est mesuré, et l'écart consigné par configuration montre le régime dans lequel la série
a eu lieu.

Décision du propriétaire du 2026-10-24, avant toute mesure : « Premier rAF ». La définition
précédente, le rappel demandé depuis ce premier rappel (début de la trame suivante), ajoutait au
moins une période de trame à chaque échantillon. Relevé du 2026-10-24 dans la WKWebView du binaire
de série (Mac16,6, changement par `view.dispatch` depuis le script d'instrumentation après une
attente tirée entre 100 et 150 ms, page au repos, sans frappe système, 200 échantillons) : écart à
la dispatch p95 2 ms et maximum 2 ms au premier rappel, p95 19 ms au second, pour des rappels
cadencés à p50 17 ms et p95 18 ms quand une boucle continue les demande (600 intervalles) ; AT-02
sur la note de 5 000 lignes (p95 ≤ 16 ms) aurait été rouge par construction. La frappe système
n'a pas été sondée : l'écart consigné par configuration est la mesure qui le dira.

Résolution des horloges, relevé du 2026-10-24 dans la WKWebView du binaire de série (Mac16,6,
macOS 26.6.2, page non isolée, `crossOriginIsolated` faux) : `performance.now()` et
`Event.timeStamp` avancent par pas de 1 ms au moins (200 000 lectures consécutives de chacun, pas
minimal entre valeurs distinctes : 1 ms). Une latence, différence de deux lectures, est donc un
nombre entier de millisecondes, à 1 ms près de la valeur vraie. Conséquence pour les seuils : le
verdict se prend sur la valeur mesurée (comparaison inclusive, § 3). Contre 16 ms, un échantillon
mesuré 16 ms est conforme alors que sa valeur vraie peut approcher 17 ms ; un échantillon mesuré
17 ms est rouge alors que sa valeur vraie peut dépasser 16 ms de très peu. La résolution ne permet
pas de trancher à mieux que 1 ms ; elle est consignée dans le rapport.

### 10.2 AT-02, de la frappe système au caractère peint

Décision du propriétaire du 2026-10-24 : « Caractère tapé peint », de la frappe système au
caractère peint dans l'éditeur, l'aperçu en direct actif en arrière-plan.

- **Frappe** : un événement clavier du système, `keyDown` puis `keyUp` d'une seule touche sans
  modificateur, créé par `CGEventCreateKeyboardEvent` et posté par `CGEventPost` au point
  `kCGHIDEventTap`. Les caractères tapés suivent le cycle `at-02-typed-cycle` du § 1, dans l'ordre,
  repris au début après le dernier.
- **Borne de début** : l'horodatage de l'événement système, lu dans la page comme
  `KeyboardEvent.timeStamp` du `keydown`. Ce protocole suppose que WebKit le dérive de
  l'horodatage de l'événement de la plateforme, et non de l'instant de sa distribution à la page ;
  cette supposition n'est pas mesurée à ce commit. Le harnais la vérifie avant la série par un
  contrôle discriminant : la page signale, puis bloque son fil principal
  `timestamp-control-block-ms` (§ 1) ; le harnais poste une frappe dès le signal ; la latence
  mesurée doit être d'au moins `timestamp-control-min-latency-ms` (§ 1) (un horodatage pris à la
  distribution donnerait de l'ordre d'une trame). Si ce contrôle échoue, la série ne démarre
  pas, et aucune autre borne de début n'est substituée sans révision de ce protocole avant mesure.
- **Borne de fin** : l'instant peint (§ 10.1) du premier changement du DOM de l'éditeur postérieur
  au `keydown` qui porte le caractère tapé.
- **Configuration** : un lancement par configuration ; la note (indice 1, 5 000 lignes ; indice 0,
  1 Mio, `cr10k.ts`) est ouverte, puis le curseur est placé par le script d'instrumentation, par
  une sélection de l'éditeur et non par une frappe, à la fin de la ligne de numéro `ceil(L / 2)`
  (comptée à partir de 1), `L` étant le nombre de lignes de la note dans l'éditeur. Les 3 000
  frappes de la configuration sont faites dans ce lancement. Aucun `rebuild_index` n'est appelé
  pour AT-02 (ni pour AT-01, NFR-03 et l'accessibilité) : seul le scénario de NFR-10 l'appelle.
- **Aperçu actif** : l'extension d'aperçu en direct est montée avec son délai livré,
  `preview-delay-ms` du § 1 (`apps/desktop/src/editor/preview.ts:44`) ; elle recalcule en arrière-plan
  pendant la série. Une frappe est postée `at-02-pause-ms` après l'instant peint de la précédente,
  ou après son délai `keystroke-timeout-ms` (§ 1) : l'aperçu, déclenché `preview-delay-ms` après
  chaque frappe, recalcule entre deux frappes et peut chevaucher la suivante.
- **Verdict d'une frappe** : la différence fin moins début, en millisecondes ; +oo si la borne de
  fin n'est pas observée en `keystroke-timeout-ms` (§ 1, § 5). Une différence négative est une
  erreur d'instrument : la configuration est interrompue, consignée et refaite.

### 10.3 NFR-03, première ouverture de la note de 1 Mio

- **Lancement** : la coquille est lancée sur une copie neuve du corpus, le dossier est choisi par
  le sélecteur injecté, et la note de 1 Mio est la première note ouverte du processus. Aucun
  `rebuild_index` n'est appelé. Le cache de fichiers du système n'est pas vidé (cela exige des
  droits d'administrateur) ; le rapport le dit.
- **Borne de début** : `performance.now()` juste avant que le script d'instrumentation soumette le
  formulaire d'ouverture de la note (`#open-form`, `requestSubmit()`).
- **Borne de fin** : l'instant peint (§ 10.1) du premier état où l'éditeur est monté et où la zone
  visible est rendue. Dans la coquille, le défileur de l'éditeur (`.cm-scroller`) ne défile pas : il
  prend la hauteur de toute la note (aucune hauteur n'est imposée à `.cm-editor` ni à `#editor`,
  `apps/desktop/src/editor/styles.ts`, `apps/desktop/src/style.css`), et c'est la fenêtre qui
  défile ; relevé du 2026-10-24, essai hors série sur la note de 1 Mio : boîte du défileur de 80 à
  761 063 px, 28 lignes rendues. La zone visible est donc la partie de la boîte du défileur que
  montre la fenêtre : en coordonnées de `getBoundingClientRect()`, de `max(0, haut du défileur)` à
  `min(window.innerHeight, bas du défileur)`. Elle
  est rendue quand les éléments de ligne de l'éditeur (`.cm-line`) dont la boîte coupe cette zone
  sont, dans l'ordre, les lignes 1 à `k` de la note (`k` au moins 1), chacun portant le texte de la
  ligne de même rang de la note, et quand le bas de la boîte de la ligne `k` est au bas de la zone
  ou au-delà (la ligne `k` peut être coupée par le bas de la zone), ou que `k` est la dernière
  ligne de la note. La note est ouverte en haut (ligne 1 en tête). C'est le rendu de la zone visible
  d'abord admis par le § 3 ; le reste de la note n'est pas attendu. Si cet état n'est pas observé
  `nfr-03-end-timeout-ms` (§ 1) après la borne de début, l'échantillon du lancement vaut +oo, comme
  une frappe non rendue (§ 5) : il reste dans l'échantillon et le lancement n'est pas refait.
- **Aperçu actif** : l'extension d'aperçu est montée à l'ouverture ; ses marques, calculées après
  `preview-delay-ms`, ne sont pas attendues par la borne de fin (même lecture que la décision
  « Caractère tapé peint » pour AT-02 : l'aperçu travaille en arrière-plan).
- Les lancements de NFR-03 sont distincts de ceux de NFR-10 et de ceux de l'accessibilité.

### 10.4 NFR-10, mémoire résidente

- **Métrique** : la somme, sur les processus comptés, de la taille résidente (RSS) que rend un même
  relevé `ps -A -o pid=,rss=,comm=`, en kibioctets, convertie en Mio. Chaque processus compte ses
  pages partagées (bibliothèques du système) : la somme majore la mémoire propre de l'application.
- **Processus comptés** : le processus de la coquille et les trois processus auxiliaires de WebKit
  qu'il fait naître, `com.apple.WebKit.WebContent`, `com.apple.WebKit.GPU` et
  `com.apple.WebKit.Networking`, fils de `launchd` et non de la coquille. Le nom d'un processus est
  le dernier composant du chemin de son exécutable tel que le rend `ps -A -o pid=,comm=` : sous
  macOS, `comm` rend le chemin complet, sans troncature (relevé du 2026-10-24, macOS 26.6.2 :
  `/System/Library/Frameworks/WebKit.framework/Versions/A/XPCServices/com.apple.WebKit.GPU.xpc/Contents/MacOS/com.apple.WebKit.GPU`,
  et de même pour `WebContent` et `Networking`). `ucomm` est tronqué à 16 caractères
  (`com.apple.WebKit` pour les trois) et n'est pas employé. Les processus sont attribués par
  différence : ceux de ces trois noms présents pendant le lancement et absents du relevé d'avant.
  Le relevé d'avant est la dernière opération qui précède la création du processus de la
  coquille : il suit les lectures de rejet (§ 10.7) et la sortie du processus du lancement
  précédent. Si la différence ne compte pas exactement un processus de chacun des trois noms, le
  lancement n'est pas un échantillon : il est consigné et refait (§ 10.7). Une autre application
  qui fait naître des processus de ces noms pendant un lancement fausse la différence : pendant la
  série, aucune autre application qui emploie WebKit n'est ouverte.
- **Période** : les relevés sont lancés aux échéances `t0 + n × nfr-10-sample-period-ms` (§ 1),
  `t0` étant la création du processus, jusqu'à sa sortie ; un relevé commence à son échéance et
  non à la fin du précédent. Une échéance déjà passée quand le relevé précédent se termine est
  sautée et comptée ; le rapport consigne, par lancement, le nombre de relevés, le nombre
  d'échéances sautées et la durée médiane d'un relevé.
- **Scénario d'un lancement** : lancement, choix du dossier par le sélecteur injecté, appel de
  `rebuild_index` par le script d'instrumentation (l'index n'existe qu'après lui), ouverture de la
  note de 1 Mio, attente de la première application des marques de l'aperçu, tenue de
  `nfr-10-hold-ms` (§ 1), sortie normale.
- **Agrégation** : l'échantillon d'un lancement est le maximum des sommes relevées pendant sa vie
  (pic de vie). Le seuil est un plafond : il est comparé au maximum des 60 échantillons, pas à leur
  p95 ; le p95 du § 4 est consigné à côté, sans verdict.

### 10.5 AT-01, fichiers, paragraphe, fermeture

- **Passe** : une copie neuve du corpus, vérifiée contre `corpus-sha256`, puis instantané de
  référence par `oracle.ts`. Un premier lancement fait l'aller-retour sans édition des 10 000
  fichiers, par ordre de chemin, puis sort ; l'instantané est comparé à la référence
  (`compareSnapshots`). Un second lancement, sur la même copie, édite un paragraphe de chaque fichier
  éditable, par ordre de chemin, puis sort ; chaque fichier est alors comparé à ses octets d'avant
  ce second lancement. Une passe donne les comptes des deux lignes d'AT-01 ; elle n'est menée à
  terme que si ses deux lancements le sont (§ 5). La passe suivante repart d'une copie neuve.
- **Ouverture et fermeture** : une note est ouverte par la soumission du formulaire d'ouverture avec
  son chemin. Elle est fermée quand la note suivante est ouverte à sa place (l'application détruit
  l'éditeur, ce qui écrit ce qui reste à écrire), et la dernière note d'un lancement par la sortie
  normale du processus. Avant d'ouvrir la note suivante, le harnais attend que l'état
  d'enregistrement (`#save-state`, attribut `data-state`) ne soit ni `dirty` ni `saving` ; après une
  édition, le script retire le focus de l'éditeur, ce qui écrit sans attendre la pause de frappe
  (`apps/desktop/src/editor/note-editor.ts`, gestionnaire `blur`), puis le harnais attend `saved`,
  au plus `save-timeout-ms` (§ 1). Un état `conflict`, `refused` ou
  `failed`, ou un délai dépassé, est consigné pour ce fichier.
- **Fichier éditable** : un fichier du corpus dont les octets se décodent en UTF-8 strict (la marque
  d'ordre des octets étant gardée comme caractère, comme le fait l'éditeur) et qui compte au moins un
  paragraphe. Le nombre de fichiers éditables se compte sur le corpus, avant la série, et figure dans
  le manifeste.
- **Paragraphe** : une plage d'octets rendue par `paragraphRanges` de `oracle.ts` (suite maximale de
  lignes non vides, terminateurs exclus). Le paragraphe édité d'un fichier qui en compte `P` est
  celui de rang `floor(P / 2)`, compté à partir de 0.
- **Édition** : le curseur est placé par le script d'instrumentation, par une sélection de
  l'éditeur, à la fin du paragraphe (octet de fin de la plage, converti en position de l'éditeur),
  puis le texte `at-01-edit-text` du § 1 est tapé par des frappes système (§ 10.2), une frappe par
  caractère, une frappe postée `at-01-key-gap-ms` (§ 1) après la précédente.
- **Comptes** : le rapport imprime, par passe, le nombre de fichiers examinés, d'identiques, de
  modifiés, de manquants et d'ajoutés à l'aller-retour, et le nombre d'éditions examinées. Une
  édition est examinée quand le fichier diffère de ses octets d'avant ; elle est conforme quand
  `checkParagraphEdit` rend `ok`. Une édition attendue et non constatée (fichier inchangé, note
  refusée, état d'enregistrement en échec) rend la ligne rouge : la ligne ne peut pas être verte
  faute d'édition. Les fichiers non éditables restent identiques à l'octet.

### 10.6 Accessibilité

- **Lancement** : distinct de ceux de NFR-10 ; la note de 1 Mio est ouverte et l'éditeur a le
  focus. Le processus qui lit doit être autorisé par macOS dans Réglages, Confidentialité et
  sécurité, Accessibilité (`AXIsProcessTrusted()` vrai) ; sans cette autorisation, la mesure n'a pas
  lieu et le rapport le dit (verdict indisponible, jamais un zéro ni un vert).
- **Élément lu** : l'élément de contenu de l'éditeur, qui a le focus, ne porte que les lignes que
  CodeMirror dessine ; la note entière est exposée par la copie du paquet WP-8, un élément de rôle
  ARIA `document` nommé « Note text, whole note, read only », hors de l'élément de contenu et sans
  focus. L'élément lu est celui-ci : depuis `AXUIElementCreateApplication(pid)` sur le processus de
  la coquille, puis `AXWindows`, l'arbre est parcouru en profondeur par `AXChildren`, dans l'ordre,
  et l'élément lu est le premier dont `AXDescription` ou `AXTitle` vaut ce nom. Aucun élément de ce
  nom au terme du parcours : la proportion vaut 0 (le texte n'est pas exposé), ce n'est pas une
  mesure indisponible ; une erreur de l'API pendant le parcours est une `instrument-error`
  (§ 10.7). Le rapport consigne, à part de la proportion, si l'élément a été trouvé et le nombre
  d'éléments parcourus, pour qu'un 0 par élément introuvable se distingue d'un 0 par texte.
  L'élément `AXFocusedUIElement` de l'application est lu aussi, par les mêmes attributs, et
  consigné à côté, sans verdict.
- **Attributs et appels lus** : `AXRole` et `AXSubrole` (consignés). Trois lectures du texte de
  l'élément sont toujours faites : (1) si l'élément porte `AXNumberOfCharacters`, `AXValue`, ou, si
  `AXValue` est absent ou plus court que `AXNumberOfCharacters`, la lecture par l'attribut
  paramétré `AXStringForRange` par tranches de `ax-string-range-chars` (§ 1) caractères jusqu'à
  `AXNumberOfCharacters` ; (2) l'`AXValue` de l'élément s'il est une chaîne ; (3) la
  concaténation, dans l'ordre du même parcours, de l'`AXValue` de ses descendants de rôle
  `AXStaticText`. Un attribut est absent quand l'appel rend `kAXErrorNoValue` ou
  `kAXErrorAttributeUnsupported` ; tout autre code d'erreur d'un appel, pendant une lecture comme
  pendant le parcours, est une `instrument-error` (§ 10.7). Une lecture qui ne s'applique pas
  (attribut absent, aucun descendant) vaut le texte vide, et un descendant dont l'`AXValue` est
  absent ou n'est pas une chaîne y contribue le texte vide. La proportion du § 8 est calculée pour
  chacune des trois ; la mesure est la plus haute des trois proportions, celle du texte que l'API
  restitue par au moins une des lectures fixées ici, et une lecture tronquée, préfixée ou dans un
  autre ordre ne masque donc pas une autre qui restitue la note. Le
  rapport consigne les trois proportions, leurs longueurs en unités UTF-16, et laquelle donne la
  mesure (la première dans l'ordre (1), (2), (3) à proportion égale). Tous les appels passent par
  `AXUIElementCopyAttributeValue` et `AXUIElementCopyParameterizedAttributeValue`. Les rôles et
  attributs que WebKit donne à cette copie ne sont pas mesurés à ce commit (l'autorisation
  Accessibilité manquait) : ces trois lectures et leur agrégation sont fixées avant mesure sans que
  leur couverture des formes de WebKit soit établie ; une forme qu'aucune ne lit donne une
  proportion basse, jamais un vert, et aucune autre lecture ni agrégation n'est substituée sans
  révision de ce protocole avant mesure.
- **Unité de caractère** : l'unité de code UTF-16, celle des chaînes de l'API d'accessibilité. Le
  texte de référence est le fichier décodé en UTF-8 strict, marque d'ordre des octets gardée, en
  unités UTF-16 ; la proportion du § 8 compte les unités égales à la même position.

### 10.7 Rejet d'un lancement

Avant et après chaque lancement, puis à chaque relevé de NFR-10, le harnais lit :

- **Session verrouillée** : `ioreg -n Root -d1 -a` ; la session est verrouillée quand l'entrée de
  `IOConsoleUsers` de l'utilisateur courant porte `CGSSessionScreenIsLocked` à vrai.
- **Écran éteint** : `CGDisplayIsAsleep(CGMainDisplayID())` de CoreGraphics ; l'écran est éteint
  quand l'appel rend une valeur non nulle.

Un lancement pendant lequel l'une des deux lectures est vraie est rejeté et refait (§ 5) ; de même
un lancement dont les processus de NFR-10 ne s'attribuent pas (§ 10.4). Le rapport consigne, par
cause, le nombre de lancements rejetés ; les causes forment un ensemble fermé :
`session-locked`, `display-asleep`, `helpers-unattributed`.

La fenêtre doit rester visible : WebKit suspend `requestAnimationFrame` dans une fenêtre masquée
(relevé du 2026-10-24 : pendant que la fenêtre était derrière une autre application au premier
plan, la page est passée en `visibilityState` `hidden` et l'instrumentation n'a plus reçu aucune
trame). Ces interruptions sont consignées à part des lancements rejetés. Une passe, une configuration
ou un lancement est interrompu, consigné avec sa cause et refait, et ce n'est pas un échantillon,
pour l'une des causes de cet ensemble fermé :

- `page-hidden` : `document.visibilityState` vaut `hidden`, lu par le script d'instrumentation à
  chaque échantillon et à chaque événement `visibilitychange` ;
- `shell-exited` : le processus de la coquille sort avant la fin prévue de la passe, de la
  configuration ou du lancement (sortie du processus fils observée par le harnais) ; cette lecture
  précède celle du premier plan, de sorte qu'une coquille morte n'est jamais lue
  `shell-not-frontmost` ;
- `shell-not-frontmost` : au moment d'une frappe système, l'application au premier plan n'est pas
  la coquille, lu par le harnais juste avant chaque `CGEventPost` comme
  `NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier` différent du pid de la
  coquille ;
- `instrument-error` : une différence négative (§ 10.2), ou une erreur du harnais ou du script
  d'instrumentation lui-même (exception, relevé illisible), consignée avec son message.

`series-stop-consecutive` (§ 1, trois) rejets ou interruptions consécutifs de même cause arrêtent
la série : elle est consignée avec cette cause, sans verdict. `shell-exited` y est nommé défaut
du produit mesuré, pas de la machine. La série ne reprend qu'après correction de la machine, de
l'instrument ou du produit, sur une copie neuve du corpus. Après une correction de la machine seule (une application fermée, un
réglage rétabli), le binaire et l'instrument sont les mêmes et la série se poursuit, les
échantillons déjà valides restant acquis. Un instrument corrigé change la procédure de mesure, et un
produit corrigé est un autre binaire mesuré, dont l'empreinte est consignée au manifeste : dans
les deux cas la série repart de zéro, chaque effectif du § 2 complet sous le seul instrument et sur
le seul binaire de la reprise, et aucun échantillon d'avant n'entre dans ses verdicts.

### 10.8 Contrôle de gel

Le protocole est gelé quand le premier rapport existe. Soit `P` le dernier commit qui modifie ce
fichier (`git log -1 --format=%H -- tools/qualification/p04-tauri/PROTOCOL.md`) et `R` le premier
commit qui ajoute un fichier sous `tools/qualification/p04-tauri/reports/`
(`git log --diff-filter=A --format=%H -- tools/qualification/p04-tauri/reports`, dernière ligne).
Le gel tient quand `P` diffère de `R` et que `git merge-base --is-ancestor P R` sort 0. Un
historique tronqué (`git rev-parse --is-shallow-repository` rend `true`) ne permet pas ce contrôle :
il échoue, il ne passe pas.

Le gel lie aussi chaque rapport au texte mesuré. Le harnais consigne dans le manifeste le SHA-256
des octets de ce fichier lus au moment de la mesure (`protocolSha256`). Le vérificateur lit ce
fichier au commit `P` (`git show P:tools/qualification/p04-tauri/PROTOCOL.md`), jamais dans l'arbre
de travail ; il en tire les seuils, les effectifs et les paramètres qu'il applique, et refuse le
rapport si le SHA-256 de ce contenu diffère de `protocolSha256`. `check-report.ts` (paquet WP-7)
applique ces contrôles.
