/* BestRoad — simulateur d'itinéraire
 * Carte: Leaflet + tuiles OpenStreetMap
 * Géocodage: Nominatim (OSM)
 * Routage: OSRM public demo (alternatives=true)
 */

const OSRM_BASE = "https://router.project-osrm.org";
const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";

const ROUTE_STYLES = {
  fast:  { color: "#3b82f6", label: "Le plus rapide",        emoji: "⚡" },
  eco:   { color: "#22c55e", label: "Le moins gourmand",     emoji: "🌿" },
  cheap: { color: "#a855f7", label: "Le moins cher",         emoji: "💶" },
  alt:   { color: "#64748b", label: "Itinéraire alternatif", emoji: "•"  },
};

const state = {
  map: null,
  routes: [],
  analyses: [],
  layers: [],
  markers: { from: null, to: null },
  points: { from: null, to: null },
  activeIndex: null,
};

/* ---------------- Map ---------------- */

function initMap() {
  state.map = L.map("map", { zoomControl: true }).setView([46.6, 2.5], 6);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap",
  }).addTo(state.map);
}

function clearLayers() {
  state.layers.forEach((l) => state.map.removeLayer(l));
  state.layers = [];
}

function setMarker(kind, lat, lon, label) {
  if (state.markers[kind]) state.map.removeLayer(state.markers[kind]);
  const icon = L.divIcon({
    className: "br-marker",
    html: `<div style="background:${kind === "from" ? "#fbbf24" : "#22c55e"};color:#0b1226;font-weight:700;border-radius:999px;padding:4px 9px;border:2px solid #0b1226;box-shadow:0 2px 6px rgba(0,0,0,.4);">${kind === "from" ? "A" : "B"}</div>`,
    iconSize: [28, 28],
    iconAnchor: [14, 14],
  });
  state.markers[kind] = L.marker([lat, lon], { icon, title: label }).addTo(state.map);
}

/* ---------------- Geocoding ---------------- */

async function geocode(query) {
  const url = `${NOMINATIM_BASE}/search?format=json&limit=5&addressdetails=1&q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: { "Accept-Language": "fr" } });
  if (!res.ok) throw new Error("Échec du géocodage");
  return res.json();
}

function attachAutocomplete(inputId, suggestionsId, kind) {
  const input = document.getElementById(inputId);
  const list = document.getElementById(suggestionsId);
  let timer;

  const close = () => list.classList.remove("visible");

  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 3) { close(); return; }
    timer = setTimeout(async () => {
      try {
        const results = await geocode(q);
        list.innerHTML = "";
        results.forEach((r) => {
          const li = document.createElement("li");
          li.textContent = r.display_name;
          li.addEventListener("click", () => {
            input.value = r.display_name;
            state.points[kind] = { lat: parseFloat(r.lat), lon: parseFloat(r.lon), label: r.display_name };
            setMarker(kind, state.points[kind].lat, state.points[kind].lon, r.display_name);
            close();
          });
          list.appendChild(li);
        });
        if (results.length) list.classList.add("visible");
      } catch (e) {
        console.error(e);
      }
    }, 300);
  });

  input.addEventListener("blur", () => setTimeout(close, 200));
}

/* ---------------- Routing ---------------- */

async function fetchRoutes(from, to, profile) {
  const coords = `${from.lon},${from.lat};${to.lon},${to.lat}`;
  const url = `${OSRM_BASE}/route/v1/${profile}/${coords}?alternatives=3&overview=full&geometries=geojson&steps=false&annotations=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("Échec du routage");
  const json = await res.json();
  if (json.code !== "Ok" || !json.routes?.length) throw new Error(json.message || "Aucun itinéraire trouvé");
  return json.routes;
}

/* ---------------- Cost model ---------------- */

/**
 * Surconsommation à haute vitesse (autoroute) vs route urbaine.
 * On utilise la vitesse moyenne comme proxy: jusqu'à +18 % à 100+ km/h.
 */
function highSpeedConsumptionFactor(avgKmh) {
  const fastShare = Math.max(0, Math.min(1, (avgKmh - 50) / 50));
  return 1 + 0.18 * fastShare;
}

function computeMetrics(route, vehicle, tolls) {
  const distanceKm = route.distance / 1000;
  const durationH = route.duration / 3600;
  const avgKmh = durationH > 0 ? distanceKm / durationH : 0;

  const fuelL = vehicle.type === "car"
    ? (distanceKm / 100) * vehicle.consumption * highSpeedConsumptionFactor(avgKmh)
    : 0;
  const fuelCost = fuelL * vehicle.fuelPrice;

  const tollCost = vehicle.type === "car" && tolls ? tolls.totalCost : 0;
  const tolledKm = tolls ? tolls.tolledKm : 0;
  const tollBreakdown = tolls ? tolls.breakdown || {} : {};
  const totalCost = fuelCost + tollCost;

  return {
    distanceKm,
    durationH,
    avgKmh,
    fuelL,
    fuelCost,
    tollCost,
    tolledKm,
    tollBreakdown,
    totalCost,
  };
}

/* ---------------- Ranking & Render ---------------- */

function rankRoutes(routes) {
  const tags = new Array(routes.length).fill(null);
  let fastIdx = 0, ecoIdx = 0, cheapIdx = 0;
  routes.forEach((r, i) => {
    if (r.metrics.durationH < routes[fastIdx].metrics.durationH) fastIdx = i;
    if (r.metrics.fuelL < routes[ecoIdx].metrics.fuelL) ecoIdx = i;
    if (r.metrics.totalCost < routes[cheapIdx].metrics.totalCost) cheapIdx = i;
  });
  // Une route peut cumuler plusieurs labels; on garde le plus prioritaire pour la couleur
  // Priorité: cheap > eco > fast (les économies financières d'abord)
  tags[fastIdx] = tags[fastIdx] || "fast";
  if (!tags[ecoIdx] || tags[ecoIdx] === "fast") tags[ecoIdx] = "eco";
  if (!tags[cheapIdx] || tags[cheapIdx] !== "cheap") tags[cheapIdx] = "cheap";
  for (let i = 0; i < tags.length; i++) if (!tags[i]) tags[i] = "alt";
  return tags;
}

function fmtDuration(h) {
  const totalMin = Math.round(h * 60);
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  if (hh === 0) return `${mm} min`;
  return `${hh} h ${String(mm).padStart(2, "0")}`;
}

function fmtKm(km) {
  return km >= 100 ? `${km.toFixed(0)} km` : `${km.toFixed(1)} km`;
}

function fmtMoney(eur) {
  return `${eur.toFixed(2)} €`;
}

function fmtLiters(l) {
  return `${l.toFixed(2)} L`;
}

function drawRoutes(routes, tags) {
  clearLayers();
  routes.forEach((r, i) => {
    const tag = tags[i];
    const style = ROUTE_STYLES[tag];
    const latlngs = r.geometry.coordinates.map(([lon, lat]) => [lat, lon]);
    const halo = L.polyline(latlngs, { color: "#0b1226", weight: 9, opacity: 0.35 }).addTo(state.map);
    const line = L.polyline(latlngs, {
      color: style.color,
      weight: 5,
      opacity: tag === "alt" ? 0.55 : 0.9,
      lineCap: "round",
      lineJoin: "round",
    }).addTo(state.map);
    line.on("click", () => selectRoute(i));
    state.layers.push(halo, line);
  });

  const allPoints = routes.flatMap((r) => r.geometry.coordinates.map(([lon, lat]) => [lat, lon]));
  if (allPoints.length) state.map.fitBounds(L.latLngBounds(allPoints).pad(0.15));
}

function renderResults(routes, tags) {
  const container = document.getElementById("results");
  container.innerHTML = "";

  // Trier les cartes: cheap, eco, fast en premier, puis alt
  const order = ["cheap", "eco", "fast", "alt"];
  const indices = routes.map((_, i) => i).sort((a, b) => order.indexOf(tags[a]) - order.indexOf(tags[b]));

  const labels = (window.BR_Tolls && window.BR_Tolls.OPERATOR_LABELS) || {};

  indices.forEach((i) => {
    const tag = tags[i];
    const style = ROUTE_STYLES[tag];
    const m = routes[i].metrics;

    const breakdownEntries = Object.entries(m.tollBreakdown || {})
      .sort((a, b) => b[1].cost - a[1].cost);
    const breakdownHtml = breakdownEntries.length
      ? `<div class="breakdown">${breakdownEntries
          .map(([op, v]) => `<span class="chip"><b>${labels[op] || op}</b> · ${v.km.toFixed(0)} km · ${fmtMoney(v.cost)}</span>`)
          .join("")}</div>`
      : "";

    const card = document.createElement("div");
    card.className = `route-card ${tag}`;
    card.dataset.index = i;
    card.innerHTML = `
      <div class="head">
        <div class="title">${style.emoji} ${style.label}</div>
        <span class="badge">${tag === "alt" ? "Alt." : tag.toUpperCase()}</span>
      </div>
      <div class="stats">
        <div class="stat"><span class="label">Durée</span><span class="value">${fmtDuration(m.durationH)}</span></div>
        <div class="stat"><span class="label">Distance</span><span class="value">${fmtKm(m.distanceKm)}</span></div>
        <div class="stat"><span class="label">Carburant</span><span class="value">${fmtLiters(m.fuelL)} · ${fmtMoney(m.fuelCost)}</span></div>
        <div class="stat"><span class="label">Péages</span><span class="value">${fmtMoney(m.tollCost)} · ${m.tolledKm.toFixed(0)} km</span></div>
        <div class="stat"><span class="label">Coût total</span><span class="value">${fmtMoney(m.totalCost)}</span></div>
        <div class="stat"><span class="label">Vitesse moy.</span><span class="value">${m.avgKmh.toFixed(0)} km/h</span></div>
      </div>
      ${breakdownHtml}
    `;
    card.addEventListener("click", () => selectRoute(i));
    container.appendChild(card);
  });
}

function selectRoute(index) {
  state.activeIndex = index;
  // Met en valeur la polyligne sélectionnée
  state.layers.forEach((l) => {
    if (l.options && l.options.weight === 5) l.setStyle({ weight: 5, opacity: 0.45 });
  });
  // chaque route a 2 layers (halo + line), donc index*2+1
  const line = state.layers[index * 2 + 1];
  if (line) {
    line.setStyle({ weight: 7, opacity: 1 });
    line.bringToFront();
  }
  document.querySelectorAll(".route-card").forEach((el) => {
    el.classList.toggle("active", parseInt(el.dataset.index, 10) === index);
  });
}

/* ---------------- Main flow ---------------- */

function readVehicle() {
  return {
    consumption: parseFloat(document.getElementById("consumption").value) || 6.5,
    fuelPrice: parseFloat(document.getElementById("fuelPrice").value) || 1.85,
    type: document.getElementById("vehicleType").value,
  };
}

function setStatus(msg, isError = false) {
  const el = document.getElementById("status");
  el.textContent = msg || "";
  el.classList.toggle("error", isError);
}

async function ensurePoint(kind) {
  if (state.points[kind]) return state.points[kind];
  const q = document.getElementById(kind).value.trim();
  if (!q) throw new Error(kind === "from" ? "Renseigne un point de départ" : "Renseigne une arrivée");
  const results = await geocode(q);
  if (!results.length) throw new Error(`Adresse introuvable: ${q}`);
  const r = results[0];
  state.points[kind] = { lat: parseFloat(r.lat), lon: parseFloat(r.lon), label: r.display_name };
  setMarker(kind, state.points[kind].lat, state.points[kind].lon, r.display_name);
  return state.points[kind];
}

async function runSearch() {
  const btn = document.getElementById("search");
  btn.disabled = true;
  setStatus("Recherche d'itinéraires…");

  try {
    const vehicle = readVehicle();
    const profile = vehicle.type === "bike" ? "bike" : vehicle.type === "foot" ? "foot" : "driving";
    const [from, to] = await Promise.all([ensurePoint("from"), ensurePoint("to")]);

    const rawRoutes = await fetchRoutes(from, to, profile);

    let analyses = rawRoutes.map(() => null);
    if (vehicle.type === "car" && window.BR_Tolls) {
      setStatus(`Détection des péages sur ${rawRoutes.length} itinéraire${rawRoutes.length > 1 ? "s" : ""}…`);
      try {
        analyses = await window.BR_Tolls.analyzeRoutes(rawRoutes);
      } catch (e) {
        console.warn("Analyse des péages indisponible :", e);
        setStatus("Péages indisponibles (Overpass injoignable). Distances et carburant calculés.", true);
      }
    }

    const routes = rawRoutes.map((r, i) => ({ ...r, metrics: computeMetrics(r, vehicle, analyses[i]) }));
    state.routes = routes;
    state.analyses = analyses;
    const tags = rankRoutes(routes);

    drawRoutes(routes, tags);
    renderResults(routes, tags);

    const cheapIdx = tags.indexOf("cheap");
    selectRoute(cheapIdx >= 0 ? cheapIdx : 0);

    if (!document.getElementById("status").classList.contains("error")) {
      setStatus(`${routes.length} itinéraire${routes.length > 1 ? "s" : ""} comparé${routes.length > 1 ? "s" : ""}.`);
    }
  } catch (e) {
    console.error(e);
    setStatus(e.message || "Erreur inattendue", true);
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- Boot ---------------- */

function boot() {
  initMap();
  attachAutocomplete("from", "from-suggestions", "from");
  attachAutocomplete("to", "to-suggestions", "to");
  document.getElementById("search").addEventListener("click", runSearch);

  // Pré-remplit avec un exemple sympa
  document.getElementById("from").value = "Paris, France";
  document.getElementById("to").value = "Lyon, France";

  // Réagit aux changements de paramètres véhicule (recalcule sans re-router)
  ["consumption", "fuelPrice"].forEach((id) => {
    document.getElementById(id).addEventListener("change", () => {
      if (!state.routes.length) return;
      const vehicle = readVehicle();
      state.routes = state.routes.map((r, i) => ({
        ...r,
        metrics: computeMetrics(r, vehicle, state.analyses?.[i]),
      }));
      const tags = rankRoutes(state.routes);
      drawRoutes(state.routes, tags);
      renderResults(state.routes, tags);
      if (state.activeIndex != null) selectRoute(state.activeIndex);
    });
  });
}

document.addEventListener("DOMContentLoaded", boot);
