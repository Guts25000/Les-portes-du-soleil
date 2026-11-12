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
| Relief du simulateur | IGN RGE ALTI® (~4 m, Licence Ouverte Etalab) + AWS hors France | **réel** |
| Arbres du simulateur (forêts, bosquets, arbres isolés) | détectés sur l'orthophoto IGN BD ORTHO® (Etalab), sinon forêts OSM | **réel** |
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

**Ski Simulator (phase 3)** — `game/`
- Monde ouvert : la piste choisie + 1,3 km autour en relief détaillé (MNT zoom 13–14), panorama réel sur 5,5 km.
- Concordance avec le réel : pistes, remontées, bâtiments, routes déneigées et snowparks viennent d'OpenStreetMap ; le terrain est terrassé sous chaque bâtiment ; les gares OSM remplacent les gares génériques.
- Gameplay arcade inspiré de Rider Republic :
  - saut chargé (maintenir Espace, relâcher ; « pop » au bord des tremplins) ;
  - en l'air : spins par demi-tours (180, 360, 540…) avec ←/→, frontflips/backflips avec ↑/↓, grabs avec Shift (Mute, Japan, Nose, Tail) ;
  - réception Perfect / Good / Sloppy (bonus de vitesse sur Perfect, ralenti sur les grosses figures), réception en switch ;
  - combos avec multiplicateur (jusqu'à x5), perdus en cas de chute ;
  - tremplins et rails/boxes le long de la piste et aux emplacements réels des snowparks ; grinds ;
  - rewind (T) de 3 s, fantôme de votre meilleur temps, sons procéduraux (vent, carres, réceptions).
- Signalisation et infrastructures : jalons à la couleur des pistes, panneaux directionnels (une lame par piste) aux carrefours, panneaux danger et filets, gares avec poulie, auvent, portiques et file d'attente, restaurants d'altitude avec leur vrai nom et leur terrasse, enneigeurs, lacs gelés, rivières, rochers, parkings, toutes les remontées visibles dans le paysage.
- Personnage articulé (genoux, buste, bras, bâtons qui piquent dans les virages, position aéro, grabs, assis sur le télésiège) ; caméras poursuite / proche / côté / subjective (C).
- Performance : forêt à niveaux de détail par carrés de 200 m, terrain découpé en carreaux, résolution dynamique visant 60 images/s (FPS affichés).
- Remontées jouables en mode libre (E pour embarquer, Espace pour accélérer), mini-carte (M).
- Graphismes : ciel physique à diffusion atmosphérique, éclairage d'environnement (IBL), bloom, MSAA, étalonnage/vignettage dynamique, ombres jusqu'à 4096, paillettes de neige au soleil, neige à micro-relief, épicéas enneigés. Trois niveaux de qualité (Basse / Haute / Ultra) sélectionnables en jeu.
- Si le MNT est indisponible, un terrain approximatif est reconstruit **et signalé**.

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
- Tuiles Esri/OpenTopoMap/demotiles : adaptées à un prototype. En production, passer sur un fournisseur avec clé (MapTiler, IGN Géoplateforme, swisstopo) et respecter leurs conditions.

## Structure

```
app/            page Next.js (export statique)
.github/        workflow de déploiement GitHub Pages
components/     App, MapView, Sidebar, SearchBar, DetailCard, RoutePlanner, SkiSimulator
game/           SkiGame (Three.js), physics (pure, testée), track (géométrie du parcours)
lib/            types, géo, parsing OSM, MNT, itinéraires, estimations, météo, scores, flux live
data/           webcams
supabase/       schéma SQL (scores, profils)
scripts/        tests sans réseau
```

Attributions : © contributeurs OpenStreetMap (ODbL) · AWS Terrain Tiles / Mapzen · Esri · OpenTopoMap (CC-BY-SA) · Open-Meteo (CC BY 4.0).
