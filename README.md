# Les Portes du Soleil — 3D Ski Experience

Site Next.js / TypeScript : carte 3D du domaine des Portes du Soleil sur le relief réel, pistes et remontées issues d'OpenStreetMap, météo par secteur, calcul d'itinéraire et **Ski Simulator** qui reconstruit la descente à partir du tracé GPS et du modèle numérique de terrain.

## Mettre en ligne sur GitHub Pages (sans installer Node)

1. Crée un compte sur https://github.com puis un nouveau dépôt **public** (ex. `portes-du-soleil-3d`).
2. Sur la page du dépôt : **Add file → Upload files**, glisse **tout le contenu** du dossier (y compris le dossier `.github` — sur Mac, Cmd+Maj+. affiche les fichiers cachés), puis **Commit changes**.
3. **Settings → Pages → Source : GitHub Actions**.
4. Onglet **Actions** : le déploiement démarre (relance-le avec « Run workflow » s'il a démarré avant l'étape 3). Environ 2-3 min.
5. Le site est en ligne sur `https://<ton-pseudo>.github.io/<nom-du-depot>/`.

Chaque nouvel envoi de fichiers republie automatiquement le site.

## Développer en local (optionnel, nécessite Node 18.17+)

```bash
npm install
npm run dev        # http://localhost:3000
npm run test:libs  # tests : parsing OSM, itinéraires, météo, physique du skieur
npm run build      # génère le site statique dans out/
```

Site 100 % statique : le navigateur interroge directement Overpass (OpenStreetMap) et Open-Meteo.
Premier chargement des pistes : 10 à 60 s, puis cache 24 h dans le navigateur (IndexedDB).

## D'où viennent les données

| Élément | Source | Statut |
|---|---|---|
| Relief 3D (carte) | AWS Terrain Tiles (Terrarium : SRTM, EU-DEM…) | **réel** |
| Relief du simulateur | IGN RGE ALTI® (Licence Ouverte Etalab) au pas de 5 m sur le secteur, AWS Terrain Tiles à l'horizon — pré-calculé dans `public/world` | **réel** |
| Arbres du simulateur (~1,1 million : forêts, bosquets, arbres isolés) | chaque sapin est placé là où l'orthophoto IGN BD ORTHO® (Etalab) montre un résineux | **réel** (position), forme générée |
| Largeur des pistes du simulateur | bord réel de la forêt mesuré sur l'orthophoto, sinon largeur type par couleur | **réel** / estimation |
| Pylônes, routes, bâtiments, lacs, rivières, rochers, parkings, restaurants | OpenStreetMap | **réel** |
| Imagerie / fond topo | Esri World Imagery / OpenTopoMap | réel |
| Pistes, remontées, restaurants, snowparks, points de vue | OpenStreetMap via Overpass (`lib/clientData.ts`) | **réel** (qualité = celle d'OSM) |
| Altitudes départ/arrivée, dénivelé, pentes | calculées sur le MNT | calcul |
| Météo, neige au sol, chutes 24/72 h, iso 0 °C, visibilité | Open-Meteo (`lib/clientData.ts`) | **modèle**, affiché comme tel |
| Temps de descente / de montée | estimations (vitesse type) sauf tag OSM `aerialway:duration` | estimation, signalée |
| Ouverture pistes/remontées, risque d'avalanche | `lib/live.ts` | **non branché** → l'interface affiche « Non disponible » |
| Webcams | `data/webcams.ts` + tag OSM `contact:webcam` | à compléter avec les flux officiels |

Aucune donnée « en direct » n'est inventée : tant qu'un flux officiel n'est pas branché, l'interface le dit.

## Fonctionnalités

**Carte (phase 1)**
- MapLibre GL avec terrain 3D, ciel, ombrage du relief, bascule 3D/2D et satellite/topo.
- Pistes colorées selon la difficulté OSM (`novice`→verte, `easy`→bleue, `intermediate`→rouge, `advanced/expert`→noire, `freeride`→itinéraire en pointillés).
- Remontées, gares, 12 stations (marqueurs FR/CH), noms de pistes le long des tracés.
- Animation d'introduction, bouton « Explorer le domaine ».

**Points interactifs et conditions (phase 2)**
- Fiche piste : longueur, dénivelé, altitudes, pente moyenne/max, profil altimétrique, passages raides (> 45 %), temps moyen, neige du secteur, état (si flux), bouton **SKIER CETTE PISTE**.
- Fiche remontée : type, altitudes, longueur, temps de montée, débit, horaires OSM.
- Restaurants d'altitude (= à moins de 200 m d'une piste ou remontée), bars, snowparks, points de vue, refuges, zones débutants, itinéraires hors-piste (information), espaces de repos.
- Panneau latéral rétractable : météo par secteur, vent, rafales, visibilité, neige au sol, chutes récentes, filtres d'affichage.
- Recherche (stations, pistes, remontées, POI, webcams) avec déplacement automatique de la caméra.

**Ski Simulator (phase 3)** — `game/`, `scripts/bake/`, `public/world/`
- **Une seule carte fixe du secteur Pléney – Nyon – Les Gets** (10,2 × 9 km : Pléney, Nyon, Chamossière, Chavannes, Mont-Chéry, Ranfoilly, Rosta, villages de Morzine et des Gets), pré-calculée une fois pour toutes et chargée d'un bloc (≈ 24 Mo, barre de progression). Plus de « zone max » : mode libre sur tout le secteur, les 48 remontées sont jouables.
- Pré-calcul (`npm run bake`, voir plus bas) : relief IGN 5 m, textures du sol à 2,5 m/pixel (neige, pistes damées, routes déneigées, sous-bois, rochers, lacs gelés), ombres du relief, des sapins et des chalets, occlusion ambiante, sens de damage, ~1,1 million de sapins à leur emplacement réel, 7 800 chalets OSM terrassés.
- Pistes peintes à leur vraie largeur (bord de la forêt mesuré sur la photo aérienne), jalons posés au bord réel de la piste damée, tracé de course = plus longue descente continue à travers les tronçons OSM (plus d'allers-retours).
- Gameplay arcade inspiré de Rider Republic :
  - saut chargé (maintenir Espace, relâcher ; « pop » au bord des tremplins) ;
  - en l'air : spins par demi-tours (180, 360, 540…) avec ←/→, frontflips/backflips avec ↑/↓, grabs avec Shift (Mute, Japan, Nose, Tail) ;
  - réception Perfect / Good / Sloppy (bonus de vitesse sur Perfect, ralenti sur les grosses figures), réception en switch ;
  - combos avec multiplicateur (jusqu'à x5), perdus en cas de chute ;
  - tremplins et rails/boxes le long de la piste et aux emplacements réels des snowparks ; grinds ;
  - rewind (T) de 3 s, fantôme de votre meilleur temps, sons procéduraux (vent, carres, réceptions).
- Signalisation et infrastructures : jalons à la couleur des pistes, panneaux directionnels (une lame par piste) aux carrefours, flèches jaunes « LES GETS / MORZINE / LE PLÉNEY… » aux arrivées, panneaux danger et filets, gares de télécabine (bardage métallique, auvent, nom de la remontée), télésièges débrayables (carénage profilé + garage des sièges), télésièges fixes (poulie apparente), pylônes avec échelle, passerelles et matelas de protection sur les pistes, cabines de télécabine vitrées, restaurants d'altitude avec leur vrai nom et leur terrasse, enneigeurs.
- Personnage articulé redessiné (veste bleue à bande orange, pantalon orange, casque jaune, masque miroir, chaussures à boucles, skis cambrés) : genoux, buste, bras, bâtons qui piquent dans les virages, position aéro, grabs, assis sur le télésiège ; il s'assombrit à l'ombre des crêtes et des forêts ; caméras poursuite / proche / côté / subjective (C).
- Performance (objectif 60 images/s) : tout est préparé au chargement, rien n'est calculé pendant la descente ; sol en carreaux de 640 m à 5 niveaux de détail ; sapins dessinés en 2 appels (épicéa détaillé près de vous, silhouette plus loin, puis la forêt « peinte » au sol) ; décor fusionné par carrés de 2,5 km (≈ 3 000 objets → quelques dizaines d'appels de dessin) ; inscriptions regroupées dans un atlas ; ombres temps réel limitées au skieur, le reste est pré-calculé ; plus de tampon de profondeur logarithmique ; résolution dynamique.
- Remontées jouables en mode libre (E pour embarquer, Espace pour accélérer), mini-carte (M).
- Graphismes : ciel physique, lumière pré-calculée (soleil de fin de matinée en mars), grain de la neige et stries de damage dans le sens de la pente de près, paillettes au soleil, épicéas chargés de neige, montagnes jusqu'au massif du Mont-Blanc à l'horizon, brume de distance. Trois niveaux de qualité (Basse / Haute / Ultra) sélectionnables en jeu.
- Le bouton « Skier cette piste » n'apparaît que pour les pistes du secteur pré-calculé.

**Championnat Pleney · Nyon · Les Gets** — `data/morzineLesGets.ts`, `lib/sectorMatch.ts`, `lib/championship.ts`
- Les 74 pistes du forfait Morzine – Les Gets (Pleney, Nyon, Chamossière, Chavannes, Ranfoilly-Nauchets, Rosta-Perrières, Mont-Chéry), d'après les pages officielles d'ouverture des pistes (portesdusoleil.com).
- Couleurs : officielles pour Morzine ; recoupées sur des guides pour Les Gets ; sinon couleur OSM (la source est indiquée au survol).
- Chaque piste officielle est rapprochée de ses tracés OSM par le nom (accents, articles, pluriels tolérés) et la position ; les tronçons « partie haute / basse » sont fusionnés. Les pistes sans tracé OSM sont listées « tracé manquant » (rien n'est inventé).
- Médailles or / argent / bronze par piste, avec des temps cibles calculés sur la longueur réelle du tracé et une vitesse moyenne par couleur. Rouges débloquées à 4 points, noires à 12. Progression enregistrée dans le navigateur.

**Itinéraires (phase 4, première version)** — `lib/routing.ts`
- Graphe orienté : pistes vers l'aval (sens vérifié sur le MNT), remontées vers l'amont, liaisons à pied courtes.
- Dijkstra sur le temps estimé ; option « éviter les noires » ; les remontées fermées sont exclues dès que le flux d'état est branché.

**Classements**
- Records stockés dans le navigateur ; classement en ligne si Supabase est configuré (`.env.local` + `supabase/schema.sql`).

## Brancher les données officielles

- **Ouverture pistes/remontées** : exposer un JSON au format `LiveStatus` (`lib/live.ts`) et renseigner `NEXT_PUBLIC_LIVE_STATUS_URL`. Côté exploitant : Lumiplan, Skidata, ou Infosnow (côté suisse).
- **Avalanches** : API Météo-France (BRA, massif du Chablais, clé gratuite) et SLF pour la Suisse → `NEXT_PUBLIC_AVALANCHE_URL`.
- **Webcams** : ajouter les entrées vérifiées dans `data/webcams.ts` (page officielle + URL d'intégration autorisée).

## Limites connues

- L'emprise de chargement (`DOMAIN_BBOX`) inclut quelques pistes voisines hors Portes du Soleil (ex. Roc d'Enfer). Pour les exclure, remplacer la bbox par le polygone du domaine.
- Les coordonnées des stations (`lib/stations.ts`) sont des centres de village approximatifs (étiquettes, météo, secteur).
- La complétude des pistes dépend d'OSM ; les pistes découpées en morceaux sont chaînées automatiquement (tolérance 40 m).
- Simulateur : les formes des sapins, chalets et gares sont génériques (seules les positions et emprises sont réelles) ; le relief IGN servi par le WMS est à ~5 m sur le secteur, il est lissé pour éviter les marches ; les pistes absentes d'OSM ne sont pas jouables.
- Tuiles Esri/OpenTopoMap/demotiles : adaptées à un prototype. En production, passer sur un fournisseur avec clé (MapTiler, IGN Géoplateforme, swisstopo) et respecter leurs conditions.

## Refaire la carte du jeu (pré-calcul)

Les fichiers de `public/world` sont déjà dans le dépôt : rien à faire pour publier. Pour les régénérer (nouvelle version d'OSM, autre soleil…) :

```bash
npm i -D sharp          # une fois : décodage/encodage des images
npm run bake            # téléchargements IGN/AWS/OSM (~120 Mo, mis en cache dans scripts/bake/.cache) puis calculs (~2 min)
npm run check:world     # vérifie qu'aucun sapin n'est posé sur l'axe d'une piste
```

Étapes : `fetch.mts` (relief IGN 2,5 m, orthophoto IGN 1,25 m, relief et photo lointains), `osm.mts` (extrait OSM via l'API 0.6), `data.mts` (assemblage, largeur réelle des pistes, terrassement, sapins), `render.mts` (textures, ombres, fichiers finaux). L'emprise et la maille sont dans `scripts/bake/def.mts`.

## Structure

```
app/            page Next.js (export statique)
.github/        workflow de déploiement GitHub Pages
components/     App, MapView, Sidebar, SearchBar, DetailCard, RoutePlanner, SkiSimulator
game/           SkiGame (Three.js), world (chargement de la carte), terrain, trees, sunvis, batch, atlas,
                physics (pure, testée), track, runline (tracé de course), lifts, buildings, infra, signage
scripts/bake/   pré-calcul de la carte du jeu → public/world
lib/            types, géo, parsing OSM, MNT, itinéraires, estimations, météo, scores, flux live
data/           webcams
supabase/       schéma SQL (scores, profils)
scripts/        tests sans réseau
```

Attributions : © contributeurs OpenStreetMap (ODbL) · IGN RGE ALTI® et BD ORTHO® (Licence Ouverte Etalab 2.0) · AWS Terrain Tiles / Mapzen · Esri · OpenTopoMap (CC-BY-SA) · Open-Meteo (CC BY 4.0).
