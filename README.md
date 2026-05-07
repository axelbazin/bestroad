# BestRoad

Simulateur d'itinéraire à la Michelin : compare le trajet **le plus rapide**,
**le moins gourmand en carburant** et **le moins cher** (carburant + péages estimés)
entre un point A et un point B, avec visualisation cartographique.

## Lancer en local

Ouvre simplement `index.html` dans un navigateur, ou sers le dossier :

```bash
python3 -m http.server 8080
# puis http://localhost:8080
```

## Stack

- **Carte** : [Leaflet](https://leafletjs.com/) + tuiles OpenStreetMap
- **Géocodage** : [Nominatim](https://nominatim.org/) (OSM)
- **Routage** : serveur public [OSRM](http://project-osrm.org/) (`alternatives=3`)
- Pas de build step, pas de dépendance npm — du HTML/CSS/JS pur.

## Fonctionnement

1. Tu saisis une adresse de départ et d'arrivée (autocomplétion via Nominatim).
2. OSRM renvoie jusqu'à 3 itinéraires alternatifs.
3. Pour chacun on calcule :
   - durée et distance,
   - carburant consommé (avec surconsommation autoroutière estimée),
   - coût du carburant + péages,
   - part autoroutière (estimée à partir de la vitesse moyenne).
4. On classe les routes (rapide / éco / pas cher) et on les trace en couleurs sur la carte.

## Limites & idées d'évolution

- Le coût des péages est aujourd'hui une **estimation** basée sur un tarif moyen au km.
  Pour des prix exacts en France, intégrer la matrice ASFA publiée sur
  [data.gouv.fr](https://www.data.gouv.fr/).
- Pour des données mondiales en temps réel : APIs HERE, TomTom ou Mapbox (payantes).
- Le serveur OSRM public est rate-limité ; pour de la production, héberger son propre
  OSRM ou utiliser GraphHopper.
