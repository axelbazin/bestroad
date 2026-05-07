# BestRoad

Simulateur d'itinéraire à la Michelin : compare le trajet **le plus rapide**,
**le moins gourmand en carburant** et **le moins cher** (carburant + péages
**réels** détectés sur OSM) entre un point A et un point B, avec visualisation
cartographique.

## Lancer en local

Ouvre `index.html` dans un navigateur, ou sers le dossier :

```bash
python3 -m http.server 8080
# puis http://localhost:8080
```

## Stack

- **Carte** : [Leaflet](https://leafletjs.com/) + tuiles OpenStreetMap
- **Géocodage** : [Nominatim](https://nominatim.org/) (OSM)
- **Routage** : serveur public [OSRM](http://project-osrm.org/) (`alternatives=3`)
- **Détection péages** : [Overpass API](https://overpass-api.de/) (OSM) +
  [Turf.js](https://turfjs.org/) pour l'analyse géométrique
- Pas de build step, pas de dépendance npm — du HTML/CSS/JS pur.

## Modèle de péages

Le coût des péages **n'est pas une heuristique**. Pour chaque itinéraire :

1. On interroge Overpass pour récupérer toutes les voies OSM avec
   `highway=motorway` + `toll=yes` à proximité du tracé.
2. On échantillonne l'itinéraire tous les 250 m. Chaque échantillon dont la
   distance au tronçon péager le plus proche est < 30 m est compté comme
   « km péagé », et est attribué au concessionnaire OSM correspondant
   (tag `operator` ou `network`).
3. Le coût est calculé en appliquant un **tarif au km par concessionnaire**,
   issu des moyennes 2024 publiées par l'ASFA et les concessionnaires
   (classe 1 — voiture).

Tarifs embarqués (€/km, dans `tolls.js`) :

| Réseau | €/km | Réseau | €/km |
|---|---|---|---|
| Vinci ASF | 0,094 | Sanef | 0,093 |
| Vinci Cofiroute | 0,090 | SAPN | 0,108 |
| Vinci Escota | 0,102 | ATMB | 0,125 |
| APRR | 0,096 | ADELAC | 0,110 |
| AREA | 0,105 | A'liénor | 0,099 |
| Atlandes | 0,088 | ALIAE | 0,095 |
| Viaduc de Millau | 0,500 | Tunnel du Fréjus | 1,000 |

Pour une précision **gare-à-gare** (au lieu d'un €/km moyen par réseau), il
faudrait intégrer les matrices tarifaires complètes publiées sur
[data.gouv.fr](https://www.data.gouv.fr/) (un fichier par concessionnaire) et
mapper les nœuds OSM `barrier=toll_booth` aux gares ASFA. C'est l'évolution
naturelle si on veut sortir du « tarif moyen par réseau ».

## Limites

- Si Overpass est rate-limité ou injoignable, l'app le signale clairement.
  Aucun fallback heuristique n'est utilisé pour les péages.
- Le coût du carburant intègre une surconsommation jusqu'à +18 % au-delà de
  100 km/h (modèle simple basé sur la vitesse moyenne du tronçon).
- Les profils vélo/marche n'incluent ni carburant ni péages.
- Le serveur OSRM public est rate-limité ; pour de la production, héberger
  son propre OSRM ou utiliser GraphHopper.
