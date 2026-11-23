<!-- SPDX-FileCopyrightText: 2026 Libre AI contributors -->
<!-- SPDX-License-Identifier: CC-BY-4.0 -->

# Développement local

Le code récupéré est intégré dans `crates/notebook-core`. L'hôte `apps/notebook`, récupéré avec lui, a été retiré de l'arbre le 2026-11-23 (décision du propriétaire en chat). Les sous-paquets conservent leurs noms et versions propres ; ce dépôt n’est pas un paquet monolithique. La provenance par fichier et les notices historiques sont dans `code-recovery-provenance.json` et `source-licensing/`.

## Installer et vérifier

Utilisez le [guide commun de composition locale](https://github.com/libre-ai/project-governance/blob/HEAD/docs/LOCAL-COMPOSITION.md) avec la cible `personal-knowledge-workspace` et le SHA du commit à vérifier. Il prépare les voisins épinglés, installe les workspaces dans l’ordre et construit UI avant les consommateurs. Après cette préparation, exécutez les commandes propres à cette application depuis sa racine dans la composition.

L’installation est une étape explicite ; `check` ne télécharge plus de dépendances. Les contrôles Bun, toolchain, secrets, données personnelles et les suites applicables restent bloquants. Les tests d’intégration utilisant PGlite n’ouvrent pas de base de données de production. Les scripts de déploiement hérités ne sont pas nécessaires à ces vérifications et ne doivent pas être exécutés pour un test local.

## État et limites

Les résultats observés sont dans [verification-status.json](verification-status.json). Les suites navigateur utilisant le même port doivent être exécutées séquentiellement. Un build local ne constitue ni publication de paquet, ni déploiement, ni validation de toutes les intégrations futures. Les README d’applications et les documents historiques décrivent aussi des étapes non réalisées ; leur ancien statut n’est pas une preuve actuelle.

Rust1.97.0 et wasm32-unknown-unknown sont utilisés par les moteurs. Préchargez les dépendances avec `cargo fetch --locked`, puis lancez la vérification native avec `cargo test --locked --offline`. Les tests WASM doivent être distingués des tests natifs.

Le build WASM de `notebook-core` (`bun run qualify:notebook-core-v2:build`) exige le Node 26.5.0 correspondant exactement au SHA du manifeste `toolchains/notebook-qualification.json`. Voir [les limites de la preuve du build](notebook-build-migration.md).

## Navigateurs et sauvegardes

Cette section décrivait l'hôte de sauvegarde `apps/notebook` : son build avec et sans sauvegarde, sa suite navigateur sous Chromium, Firefox et WebKit, et le workflow macOS qui rejouait WebKit. L'hôte a été retiré de l'arbre le 2026-11-23 (décision du propriétaire en chat) ; le texte reste lisible dans l'historique git. Le workflow macOS garde le contrôle racine, les tests natifs et le build WASM de `notebook-core`.
