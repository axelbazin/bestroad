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

// Tarifs €/km pour la classe 1 (voiture), basés sur les barèmes
// utilisateur 2024 publiés par chaque concessionnaire. Ce sont des
// prix de bout-en-bout : on les applique aux km péagés détectés sur
// le tracé. Pour de l'exact gare-à-gare il faudrait la matrice ASFA.
const OPERATOR_RATES = {
  ASF:       0.102,
  COFIROUTE: 0.097,
  ESCOTA:    0.107,
  APRR:      0.099,
  AREA:      0.107,
  SANEF:     0.096,
  SAPN:      0.108,
  ATMB:      0.165,
  ADELAC:    0.150,
  ALBEA:     0.090,
  ALIAE:     0.104,
  ALIENOR:   0.135,
  ALIS:      0.135,
  ATLANDES:  0.155,
  CEVM:      0.500,
  SFTRF:     1.000,
};

const DEFAULT_RATE = 0.110;

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
  ALIS:      "ALIS (A28)",
  ATLANDES:  "Atlandes (A63)",
  CEVM:      "Viaduc de Millau",
  SFTRF:     "Tunnel du Fréjus",
  OTHER:     "Autre concessionnaire",
};

// Fallback ref → opérateur quand le tag `operator` OSM est manquant ou
// non normalisable. Approximatif : certaines autoroutes ont plusieurs
// concessionnaires sur leur longueur (A10, A28, A40…). On choisit le
// concessionnaire majoritaire ou le plus probable pour un usage courant.
const REF_TO_OPERATOR = {
  A1: "SANEF", A2: "SANEF", A4: "SANEF", A16: "SANEF", A26: "SANEF", A29: "SANEF",
  A13: "SAPN", A14: "SAPN", A131: "SAPN", A150: "SAPN", A151: "SAPN", A154: "SAPN",
  A28: "ALIS",
  A19: "ALIAE",
  A5: "APRR", A6: "APRR", A31: "APRR", A36: "APRR", A39: "APRR", A40: "APRR", A406: "APRR", A77: "APRR",
  A41: "AREA", A43: "AREA", A48: "AREA", A49: "AREA", A51: "AREA",
  A11: "COFIROUTE", A71: "COFIROUTE", A81: "COFIROUTE", A85: "COFIROUTE", A86: "COFIROUTE",
  A7: "ASF", A9: "ASF", A10: "ASF", A20: "ASF", A52: "ASF", A54: "ASF", A57: "ASF",
  A61: "ASF", A62: "ASF", A64: "ASF", A66: "ASF", A75: "ASF", A87: "ASF", A89: "ASF",
  A8: "ESCOTA",
  A63: "ATLANDES",
  A65: "ALIENOR",
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
  if (s.includes("ALIS")) return "ALIS";
  if (s.includes("ATMB")) return "ATMB";
  if (s.includes("AREA")) return "AREA";
  if (s.includes("APRR")) return "APRR";
  if (s.includes("SAPN")) return "SAPN";
  if (s.includes("SANEF")) return "SANEF";
  if (s.includes("ASF")) return "ASF";
  return null;
}

function refToOperator(refRaw) {
  if (!refRaw) return null;
  const candidates = String(refRaw).split(/[;,/]/).map((r) =>
    r.trim().replace(/\s+/g, "").toUpperCase()
  );
  for (const r of candidates) {
    if (REF_TO_OPERATOR[r]) return REF_TO_OPERATOR[r];
  }
  return null;
}

function detectOperator(tags) {
  if (!tags) return null;
  const direct = normalizeOperator(
    tags.operator || tags["operator:short"] || tags.network || tags.owner
  );
  if (direct) return direct;
  return refToOperator(tags.ref);
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

async function fetchTollDataNearCoords(coords, { around = 400, maxSamples = 90 } = {}) {
  const samples = downsample(coords, maxSamples);
  const around_str = samples
    .map(([lon, lat]) => `${lat.toFixed(5)},${lon.toFixed(5)}`)
    .join(",");
  const query = `
[out:json][timeout:40];
(
  way[highway=motorway][toll=yes](around:${around},${around_str});
  node[barrier=toll_booth](around:${around},${around_str});
);
out geom tags;
`;
  const json = await postOverpass(query);
  const ways = [];
  const booths = [];
  for (const el of json.elements || []) {
    if (el.type === "way" && Array.isArray(el.geometry) && el.geometry.length >= 2) {
      ways.push({
        id: el.id,
        operator: detectOperator(el.tags),
        operatorRaw: el.tags?.operator || el.tags?.["operator:short"] || el.tags?.network || null,
        ref: el.tags?.ref || null,
        geometry: el.geometry.map((p) => [p.lon, p.lat]),
      });
    } else if (el.type === "node") {
      booths.push({
        id: el.id,
        lat: el.lat,
        lon: el.lon,
        name: el.tags?.name || null,
        ref: el.tags?.ref || null,
        operator: detectOperator(el.tags),
      });
    }
  }
  return { ways, booths };
}

// Backwards-compatible helper kept for clarity
async function fetchTollWaysNearCoords(coords, opts) {
  const { ways } = await fetchTollDataNearCoords(coords, opts);
  return ways;
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

function filterBoothsOnRoute(route, booths, toleranceM = 80) {
  if (!booths.length) return [];
  const lineRoute = turf.lineString(route.geometry.coordinates);
  const totalKm = turf.length(lineRoute, { units: "kilometers" });
  return booths
    .map((b) => {
      const pt = turf.point([b.lon, b.lat]);
      const d = turf.pointToLineDistance(pt, lineRoute, { units: "meters" });
      if (d > toleranceM) return null;
      // distance traversée (en km) au point le plus proche sur la route
      let alongKm = 0;
      try {
        const sliced = turf.lineSlice(turf.point(route.geometry.coordinates[0]), pt, lineRoute);
        alongKm = turf.length(sliced, { units: "kilometers" });
      } catch (_) { alongKm = 0; }
      if (alongKm > totalKm) alongKm = totalKm;
      return { ...b, distanceFromStartKm: alongKm };
    })
    .filter(Boolean)
    .sort((a, b) => a.distanceFromStartKm - b.distanceFromStartKm);
}

/**
 * Lance une seule requête Overpass couvrant l'union des itinéraires,
 * puis analyse chaque route séparément.
 */
async function analyzeRoutes(routes) {
  if (!routes.length) return [];
  const allCoords = routes.flatMap((r) => r.geometry.coordinates);
  const { ways, booths } = await fetchTollDataNearCoords(allCoords);
  return routes.map((r) => {
    const analysis = analyzeRouteAgainstWays(r, ways);
    const routeBooths = filterBoothsOnRoute(r, booths);
    return { ...analysis, booths: routeBooths };
  });
}

window.BR_Tolls = {
  analyzeRoutes,
  analyzeRouteAgainstWays,
  fetchTollWaysNearCoords,
  fetchTollDataNearCoords,
  filterBoothsOnRoute,
  OPERATOR_RATES,
  OPERATOR_LABELS,
  DEFAULT_RATE,
};
