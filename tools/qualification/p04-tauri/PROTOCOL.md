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

- Une frappe dont le rendu n'est pas observé en 2 s (2 000 ms) vaut +oo (infini) : elle reste dans
  l'échantillon, triée en dernier, et elle n'est pas rejetée.
- Un lancement fait session verrouillée ou écran éteint est rejeté et refait ; le nombre de
  lancements rejetés et leur cause sont consignés dans le rapport, et l'effectif de 60 est
  complété par des lancements valides.
- Précisions de ce protocole, hors texte de CA-36 : aucune autre valeur n'est écartée (une valeur
  aberrante lente reste dans l'échantillon) ; une passe AT-01 interrompue par une erreur n'est pas
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
seuil est de 100 % (`ADR-0057:66`, arbitrage distinct du 2026-10-23). Le harnais de la série (paquet
WP-5) fixe les attributs et les appels d'accessibilité lus, avant la première mesure, et les écrit
dans le rapport.

## 9. Ce que ce protocole ne fait pas

- Il ne contient aucune valeur mesurée : aucune mesure n'a été faite sous Tauri à ce commit
  (`docs/prd.md` § 5, colonne « Valeur courante »).
- Il ne qualifie pas la machine de mesure et ne signe rien : la qualification macOS est le paquet
  WP-6.
- Le choix du paragraphe édité par fichier pour AT-01 est fixé par le harnais de WP-5 avant la
  série et consigné dans le manifeste du rapport ; il ne dépend d'aucun résultat.
