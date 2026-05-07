/* BestRoad — analyse des péages
 *
 * 1) On interroge Overpass pour récupérer les voies à péage (highway=motorway,
 *    toll=yes) à proximité de l'itinéraire.
 * 2) On échantillonne l'itinéraire tous les 250 m et on regarde si chaque
 *    point se trouve à <30 m d'une de ces voies.
 * 3) On agrège les kilomètres péagés par concessionnaire et on applique le
 *    tarif au km publié par l'ASFA (classe 1 — voiture).
 *
 * Tarifs : moyennes 2024 publiées par les concessionnaires (€/km, classe 1).
 * C'est une approximation en €/km — pour une précision gare-à-gare il faudrait
 * intégrer la matrice tarifaire complète de chaque réseau (data.gouv.fr).
 */

const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

const OPERATOR_RATES = {
  ASF:       0.094,
  COFIROUTE: 0.090,
  ESCOTA:    0.102,
  APRR:      0.096,
  AREA:      0.105,
  SANEF:     0.093,
  SAPN:      0.108,
  ATMB:      0.125,
  ADELAC:    0.110,
  ALBEA:     0.090,
  ALIAE:     0.095,
  ALIENOR:   0.099,
  ATLANDES:  0.088,
  CEVM:      0.500,
  SFTRF:     1.000,
};

const DEFAULT_RATE = 0.095;

const OPERATOR_LABELS = {
  ASF:       "Vinci ASF",
  COFIROUTE: "Vinci Cofiroute",
  ESCOTA:    "Vinci Escota",
  APRR:      "APRR",
  AREA:      "AREA",
  SANEF:     "Sanef",
  SAPN:      "SAPN",
  ATMB:      "ATMB",
  ADELAC:    "ADELAC",
  ALBEA:     "ALBEA",
  ALIAE:     "ALIAE",
  ALIENOR:   "A'liénor",
  ATLANDES:  "Atlandes",
  CEVM:      "Viaduc de Millau",
  SFTRF:     "Tunnel du Fréjus",
  OTHER:     "Autre concessionnaire",
};

function normalizeOperator(raw) {
  if (!raw) return null;
  const s = raw.toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (s.includes("MILLAU") || s.includes("CEVM")) return "CEVM";
  if (s.includes("FREJUS") || s.includes("SFTRF")) return "SFTRF";
  if (s.includes("COFIROUTE")) return "COFIROUTE";
  if (s.includes("ESCOTA")) return "ESCOTA";
  if (s.includes("ATLANDES")) return "ATLANDES";
  if (s.includes("ALIENOR") || s.includes("LIENOR")) return "ALIENOR";
  if (s.includes("ADELAC")) return "ADELAC";
  if (s.includes("ALBEA")) return "ALBEA";
  if (s.includes("ALIAE")) return "ALIAE";
  if (s.includes("ATMB")) return "ATMB";
  if (s.includes("AREA")) return "AREA";
  if (s.includes("APRR")) return "APRR";
  if (s.includes("SAPN")) return "SAPN";
  if (s.includes("SANEF")) return "SANEF";
  if (s.includes("ASF")) return "ASF";
  return null;
}

/* ---------------- Overpass query ---------------- */

function downsample(coords, maxPoints) {
  if (coords.length <= maxPoints) return coords.slice();
  const step = (coords.length - 1) / (maxPoints - 1);
  const out = [];
  for (let i = 0; i < maxPoints; i++) out.push(coords[Math.round(i * step)]);
  return out;
}

async function postOverpass(query) {
  let lastErr;
  for (const url of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(url, {
        method: "POST",
        body: "data=" + encodeURIComponent(query),
      });
      if (!res.ok) {
        lastErr = new Error(`Overpass HTTP ${res.status}`);
        continue;
      }
      return await res.json();
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Overpass injoignable");
}

async function fetchTollWaysNearCoords(coords, { around = 400, maxSamples = 90 } = {}) {
  const samples = downsample(coords, maxSamples);
  const around_str = samples
    .map(([lon, lat]) => `${lat.toFixed(5)},${lon.toFixed(5)}`)
    .join(",");
  const query = `[out:json][timeout:40];way[highway=motorway][toll=yes](around:${around},${around_str});out geom tags;`;
  const json = await postOverpass(query);
  return (json.elements || [])
    .filter((w) => w.type === "way" && Array.isArray(w.geometry) && w.geometry.length >= 2)
    .map((w) => ({
      id: w.id,
      operator: normalizeOperator(
        w.tags?.operator || w.tags?.["operator:short"] || w.tags?.network
      ),
      operatorRaw: w.tags?.operator || w.tags?.["operator:short"] || w.tags?.network || null,
      ref: w.tags?.ref || null,
      geometry: w.geometry.map((p) => [p.lon, p.lat]),
    }));
}

/* ---------------- Spatial analysis ---------------- */

function bboxOfCoords(coords, pad = 0) {
  let minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
  for (const [lon, lat] of coords) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  return [minLon - pad, minLat - pad, maxLon + pad, maxLat + pad];
}

function bboxOverlaps(a, b) {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

function pointBboxAround(lon, lat, padDeg) {
  return [lon - padDeg, lat - padDeg, lon + padDeg, lat + padDeg];
}

function analyzeRouteAgainstWays(route, tollWays, { sampleM = 250, toleranceM = 30 } = {}) {
  const coords = route.geometry.coordinates;
  if (coords.length < 2 || tollWays.length === 0) {
    return { tolledKm: 0, byOperator: {}, totalCost: 0 };
  }

  const lineRoute = turf.lineString(coords);
  const totalKm = turf.length(lineRoute, { units: "kilometers" });
  if (totalKm === 0) return { tolledKm: 0, byOperator: {}, totalCost: 0 };

  const ways = tollWays
    .map((w) => ({
      operator: w.operator,
      line: turf.lineString(w.geometry),
      bbox: bboxOfCoords(w.geometry, 0.005),
    }));

  const numSamples = Math.max(2, Math.ceil((totalKm * 1000) / sampleM));
  const stepKm = totalKm / numSamples;
  const padDeg = toleranceM / 111000 + 0.001;

  const byOperator = {};
  let tolledKm = 0;

  for (let i = 0; i < numSamples; i++) {
    const along = stepKm * (i + 0.5);
    const pt = turf.along(lineRoute, along, { units: "kilometers" });
    const [plon, plat] = pt.geometry.coordinates;
    const ptBbox = pointBboxAround(plon, plat, padDeg);

    let bestDist = Infinity;
    let bestOp = null;
    for (const w of ways) {
      if (!bboxOverlaps(ptBbox, w.bbox)) continue;
      const d = turf.pointToLineDistance(pt, w.line, { units: "meters" });
      if (d < bestDist) {
        bestDist = d;
        bestOp = w.operator;
      }
    }

    if (bestDist <= toleranceM) {
      const op = bestOp || "OTHER";
      byOperator[op] = (byOperator[op] || 0) + stepKm;
      tolledKm += stepKm;
    }
  }

  let totalCost = 0;
  const breakdown = {};
  for (const [op, km] of Object.entries(byOperator)) {
    const rate = OPERATOR_RATES[op] || DEFAULT_RATE;
    const cost = km * rate;
    totalCost += cost;
    breakdown[op] = { km, cost };
  }

  return { tolledKm, byOperator, breakdown, totalCost };
}

/**
 * Lance une seule requête Overpass couvrant l'union des itinéraires,
 * puis analyse chaque route séparément. Retourne un tableau d'analyses
 * dans le même ordre que `routes`.
 */
async function analyzeRoutes(routes) {
  if (!routes.length) return [];
  const allCoords = routes.flatMap((r) => r.geometry.coordinates);
  const tollWays = await fetchTollWaysNearCoords(allCoords);
  return routes.map((r) => analyzeRouteAgainstWays(r, tollWays));
}

window.BR_Tolls = {
  analyzeRoutes,
  analyzeRouteAgainstWays,
  fetchTollWaysNearCoords,
  OPERATOR_RATES,
  OPERATOR_LABELS,
  DEFAULT_RATE,
};
