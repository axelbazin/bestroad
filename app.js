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
  boothMarkers: [],
  markers: { from: null, to: null },
  points: { from: null, to: null },
  activeIndex: null,
  view: "form", // 'form' | 'loading' | 'results' | 'roadbook'
  roadbookIndex: null,
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
  const url = `${OSRM_BASE}/route/v1/${profile}/${coords}?alternatives=3&overview=full&geometries=geojson&steps=true&annotations=true`;
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

function renderResults(routes, tags, { tollsLoading = false, tollsFailed = false } = {}) {
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

    const tollValue = tollsLoading
      ? `<span class="loading-pill">Calcul…</span>`
      : tollsFailed
      ? `<span class="muted">indispo.</span>`
      : `${fmtMoney(m.tollCost)} · ${m.tolledKm.toFixed(0)} km`;
    const totalValue = tollsLoading
      ? `<span class="loading-pill">${fmtMoney(m.fuelCost)} +…</span>`
      : fmtMoney(m.totalCost);

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
        <div class="stat"><span class="label">Péages</span><span class="value">${tollValue}</span></div>
        <div class="stat"><span class="label">Coût total</span><span class="value">${totalValue}</span></div>
        <div class="stat"><span class="label">Vitesse moy.</span><span class="value">${m.avgKmh.toFixed(0)} km/h</span></div>
      </div>
      ${breakdownHtml}
      <button class="roadbook-link" data-index="${i}">Voir la feuille de route →</button>
    `;
    card.addEventListener("click", (ev) => {
      if (ev.target instanceof HTMLElement && ev.target.classList.contains("roadbook-link")) return;
      selectRoute(i);
    });
    card.querySelector(".roadbook-link").addEventListener("click", (ev) => {
      ev.stopPropagation();
      openRoadbook(i);
    });
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
  renderTollPins(index);
}

function clearTollPins() {
  state.boothMarkers.forEach((m) => state.map.removeLayer(m));
  state.boothMarkers = [];
}

function renderTollPins(routeIndex) {
  clearTollPins();
  if (routeIndex == null) return;
  const analysis = state.analyses?.[routeIndex];
  const booths = analysis?.booths || [];
  booths.forEach((b) => {
    const icon = L.divIcon({
      className: "toll-marker",
      html: `<div class="toll-pin">€</div>`,
      iconSize: [26, 26],
      iconAnchor: [13, 13],
    });
    const marker = L.marker([b.lat, b.lon], {
      icon,
      title: b.name || (b.operator ? `Péage ${b.operator}` : "Péage"),
    }).addTo(state.map);
    if (b.name) {
      marker.bindPopup(
        `<div style="font-family:inherit"><b>${b.name}</b><br><span style="color:#94a3b8;font-size:12px">${b.operator ? "Concessionnaire " + b.operator : "Péage"}</span></div>`
      );
    }
    state.boothMarkers.push(marker);
  });
}

/* ---------------- View state machine ---------------- */

const VIEWS = ["form", "loading", "results", "roadbook"];

function showView(name) {
  state.view = name;
  for (const v of VIEWS) {
    const el = document.getElementById(`view-${v}`);
    if (el) el.hidden = v !== name;
  }
  const back = document.getElementById("peek-back");
  if (back) back.hidden = name === "form";

  const sheet = document.getElementById("sheet");
  if (sheet && isMobileLayout()) {
    if (name === "loading" || name === "roadbook") setSnap(sheet, "full");
    else if (name === "results") setSnap(sheet, "mid");
    else if (name === "form") setSnap(sheet, "mid");
  }
  updatePeekSummary();
}

function goBack() {
  if (state.view === "roadbook") {
    state.roadbookIndex = null;
    showView("results");
  } else if (state.view === "results" || state.view === "loading") {
    clearTollPins();
    showView("form");
  }
}

function setLoaderText(title, sub) {
  const t = document.getElementById("loader-text");
  const s = document.getElementById("loader-sub");
  if (t && title) t.textContent = title;
  if (s && sub != null) s.textContent = sub;
}

/* ---------------- Roadbook ---------------- */

const MANEUVER_ICONS = {
  depart: "🚗",
  arrive: "🏁",
  "turn:left": "⬅️",
  "turn:right": "➡️",
  "turn:slight left": "↖️",
  "turn:slight right": "↗️",
  "turn:sharp left": "⤴️",
  "turn:sharp right": "⤵️",
  "turn:straight": "⬆️",
  "turn:uturn": "↩️",
  roundabout: "🔄",
  rotary: "🔄",
  "exit roundabout": "🔄",
  "exit rotary": "🔄",
  "on ramp": "↗️",
  "off ramp": "↘️",
  fork: "⑂",
  merge: "🔀",
  continue: "⬆️",
  "new name": "⬆️",
  notification: "ℹ️",
  "use lane": "↔️",
};

function maneuverIcon(step) {
  const m = step.maneuver;
  if (!m) return "➡️";
  if (m.type === "turn" && m.modifier) return MANEUVER_ICONS[`turn:${m.modifier}`] || "➡️";
  return MANEUVER_ICONS[m.type] || "➡️";
}

function maneuverLabel(step) {
  const m = step.maneuver;
  if (!m) return "Continuer";
  switch (m.type) {
    case "depart": return "Départ";
    case "arrive": return "Arrivée";
    case "turn":
      switch (m.modifier) {
        case "left": return "Tourner à gauche";
        case "right": return "Tourner à droite";
        case "slight left": return "Légère gauche";
        case "slight right": return "Légère droite";
        case "sharp left": return "Virage serré à gauche";
        case "sharp right": return "Virage serré à droite";
        case "straight": return "Continuer tout droit";
        case "uturn": return "Faire demi-tour";
      }
      return "Tourner";
    case "roundabout":
    case "rotary":
      return m.exit ? `Au rond-point, prendre la sortie ${m.exit}` : "Au rond-point";
    case "exit roundabout":
    case "exit rotary": return "Sortir du rond-point";
    case "merge": return "S'insérer";
    case "on ramp": return "Prendre la bretelle d'entrée";
    case "off ramp": return "Prendre la bretelle de sortie";
    case "fork": return "Garder " + (m.modifier || "la bonne voie");
    case "continue": return "Continuer";
    case "new name": return "Continuer";
    case "notification": return "Information";
  }
  return "Continuer";
}

function shieldFor(ref) {
  if (!ref) return "";
  const refs = String(ref).split(/[;,]/).map((r) => r.trim()).filter(Boolean);
  return refs
    .map((r) => {
      const upper = r.toUpperCase().replace(/\s+/g, "");
      let cls = "shield--departementale";
      if (/^A\d/.test(upper)) cls = "shield--motorway";
      else if (/^N\d/.test(upper)) cls = "shield--ramp";
      return `<span class="shield ${cls}">${r}</span>`;
    })
    .join(" ");
}

function buildRoadbookItems(route, booths) {
  const items = [];
  // Aplatit les steps OSRM (toutes les legs, tous les steps)
  const steps = [];
  let cumulativeKm = 0;
  for (const leg of route.legs || []) {
    for (const step of leg.steps || []) {
      const distanceKm = (step.distance || 0) / 1000;
      const startKm = cumulativeKm;
      cumulativeKm += distanceKm;
      steps.push({
        kind: "step",
        atKm: startKm,
        endKm: cumulativeKm,
        step,
      });
    }
  }
  // Booths
  for (const b of booths || []) {
    items.push({ kind: "toll", atKm: b.distanceFromStartKm || 0, booth: b });
  }
  for (const s of steps) items.push(s);
  items.sort((a, b) => a.atKm - b.atKm);
  return items;
}

function renderRoadbook(routeIndex) {
  const route = state.routes[routeIndex];
  const analysis = state.analyses?.[routeIndex];
  const m = route.metrics;
  const booths = analysis?.booths || [];
  const items = buildRoadbookItems(route, booths);
  const fromLabel = (state.points.from?.label || "Départ").split(",")[0];
  const toLabel = (state.points.to?.label || "Arrivée").split(",")[0];

  const itemsHtml = items.map((it) => {
    if (it.kind === "toll") {
      const b = it.booth;
      const opLabel = window.BR_Tolls?.OPERATOR_LABELS?.[b.operator] || b.operator || "Péage";
      return `
        <li class="step step--toll">
          <div class="step-icon">€</div>
          <div class="step-body">
            <div class="step-title">Péage ${b.name ? "— " + escapeHtml(b.name) : ""}</div>
            <div class="step-meta"><span>${escapeHtml(opLabel)}</span><span>au km ${it.atKm.toFixed(0)}</span></div>
          </div>
        </li>`;
    }
    const s = it.step;
    const m = s.maneuver || {};
    const isStart = m.type === "depart";
    const isEnd = m.type === "arrive";
    const cls = isStart ? "step--depart" : isEnd ? "step--arrive" : "";
    const dist = (s.distance || 0) / 1000;
    const dur = (s.duration || 0) / 60;
    const name = s.name || "";
    const ref = s.ref || "";
    const dest = s.destinations || "";
    const verb = maneuverLabel(s);
    const titleParts = [escapeHtml(verb)];
    if (ref) titleParts.push(shieldFor(ref));
    else if (name) titleParts.push(escapeHtml(name));
    const meta = [];
    if (dest) meta.push(`vers ${escapeHtml(dest.split(",")[0])}`);
    if (!isStart && !isEnd) {
      if (dist >= 0.1) meta.push(`${dist >= 10 ? dist.toFixed(0) : dist.toFixed(1)} km`);
      if (dur >= 1) meta.push(`${dur.toFixed(0)} min`);
    }
    return `
      <li class="step ${cls}">
        <div class="step-icon">${maneuverIcon(s)}</div>
        <div class="step-body">
          <div class="step-title">${titleParts.join(" ")}</div>
          ${meta.length ? `<div class="step-meta">${meta.map((x) => `<span>${x}</span>`).join("")}</div>` : ""}
        </div>
      </li>`;
  }).join("");

  const html = `
    <div class="roadbook-summary">
      <div class="title">${escapeHtml(fromLabel)} → ${escapeHtml(toLabel)}</div>
      <div class="meta">
        <span><b>${fmtDuration(m.durationH)}</b></span>
        <span><b>${fmtKm(m.distanceKm)}</b></span>
        <span>Carburant <b>${fmtMoney(m.fuelCost)}</b></span>
        <span>Péages <b>${fmtMoney(m.tollCost)}</b></span>
        <span>Total <b>${fmtMoney(m.totalCost)}</b></span>
      </div>
    </div>
    <ol class="roadbook-steps">${itemsHtml}</ol>
  `;
  document.getElementById("roadbook").innerHTML = html;
}

function openRoadbook(routeIndex) {
  state.roadbookIndex = routeIndex;
  selectRoute(routeIndex);
  renderRoadbook(routeIndex);
  showView("roadbook");
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
  setStatus("");
  showView("loading");
  setLoaderText("Recherche d'itinéraires…", "On compare les routes possibles");

  try {
    const vehicle = readVehicle();
    const profile = vehicle.type === "bike" ? "bike" : vehicle.type === "foot" ? "foot" : "driving";
    const [from, to] = await Promise.all([ensurePoint("from"), ensurePoint("to")]);

    const rawRoutes = await fetchRoutes(from, to, profile);

    // 1ère passe : on rend tout de suite avec carburant + distance, sans péages.
    const initialAnalyses = rawRoutes.map(() => null);
    let routes = rawRoutes.map((r) => ({ ...r, metrics: computeMetrics(r, vehicle, null) }));
    state.routes = routes;
    state.analyses = initialAnalyses;

    const tollsWillLoad = vehicle.type === "car" && !!window.BR_Tolls;
    let tags = rankRoutes(routes);
    drawRoutes(routes, tags);
    renderResults(routes, tags, { tollsLoading: tollsWillLoad });
    const cheapIdx = tags.indexOf("cheap");
    selectRoute(cheapIdx >= 0 ? cheapIdx : 0);
    showView("results");

    if (!tollsWillLoad) {
      setStatus(`${routes.length} itinéraire${routes.length > 1 ? "s" : ""} comparé${routes.length > 1 ? "s" : ""}.`);
      return;
    }

    setStatus("Analyse des péages en cours…");

    // 2e passe : on enrichit avec les péages quand Overpass + l'analyse sont prêts.
    try {
      const analyses = await window.BR_Tolls.analyzeRoutes(rawRoutes);
      routes = rawRoutes.map((r, i) => ({ ...r, metrics: computeMetrics(r, vehicle, analyses[i]) }));
      state.routes = routes;
      state.analyses = analyses;
      tags = rankRoutes(routes);

      drawRoutes(routes, tags);
      renderResults(routes, tags, { tollsLoading: false });
      const idx = state.activeIndex != null ? state.activeIndex : (tags.indexOf("cheap") >= 0 ? tags.indexOf("cheap") : 0);
      selectRoute(idx);
      updatePeekSummary();
      setStatus(`${routes.length} itinéraire${routes.length > 1 ? "s" : ""} comparé${routes.length > 1 ? "s" : ""} (péages inclus).`);
    } catch (e) {
      console.warn("Analyse des péages indisponible :", e);
      renderResults(routes, tags, { tollsLoading: false, tollsFailed: true });
      setStatus("Péages indisponibles (Overpass injoignable).", true);
    }
  } catch (e) {
    console.error(e);
    setStatus(e.message || "Erreur inattendue", true);
    showView("form");
  } finally {
    btn.disabled = false;
  }
}

/* ---------------- Bottom sheet (Waze-style) ---------------- */

const SNAP_ORDER = ["peek", "mid", "full"];

function isMobileLayout() {
  return window.matchMedia("(max-width: 899px)").matches;
}

function getCurrentTranslateY(el) {
  const m = new DOMMatrixReadOnly(getComputedStyle(el).transform);
  return m.m42;
}

function snapPositionsPx(sheet) {
  const styles = getComputedStyle(document.documentElement);
  const peek = parseFloat(styles.getPropertyValue("--peek-h")) || 132;
  const sheetH = sheet.getBoundingClientRect().height;
  const vh = window.innerHeight;
  return {
    full: 0,
    mid: Math.max(0, sheetH - vh * 0.56),
    peek: Math.max(0, sheetH - peek),
  };
}

function setSnap(sheet, name, { animate = true } = {}) {
  if (!animate) sheet.classList.add("dragging");
  sheet.dataset.snap = name;
  sheet.style.transform = "";
  if (!animate) {
    requestAnimationFrame(() => sheet.classList.remove("dragging"));
  }
  if (state.map) {
    setTimeout(() => state.map.invalidateSize(), 320);
  }
  updatePeekSummary();
}

function nearestSnap(currentPx, snaps) {
  let best = "mid";
  let bestDist = Infinity;
  for (const name of SNAP_ORDER) {
    const d = Math.abs(currentPx - snaps[name]);
    if (d < bestDist) { bestDist = d; best = name; }
  }
  return best;
}

function initBottomSheet() {
  const sheet = document.getElementById("sheet");
  const handle = document.getElementById("sheet-handle");
  const peek = document.getElementById("sheet-peek");

  let dragging = false;
  let pointerId = null;
  let startY = 0;
  let startTranslate = 0;
  let dragMoved = false;

  function onPointerDown(e) {
    if (!isMobileLayout()) return;
    if (e.pointerType === "mouse" && e.button !== 0) return;
    dragging = true;
    pointerId = e.pointerId;
    startY = e.clientY;
    startTranslate = getCurrentTranslateY(sheet);
    dragMoved = false;
    sheet.classList.add("dragging");
    e.currentTarget.setPointerCapture(e.pointerId);
  }

  function onPointerMove(e) {
    if (!dragging || e.pointerId !== pointerId) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 4) dragMoved = true;
    const snaps = snapPositionsPx(sheet);
    const next = Math.max(snaps.full, Math.min(snaps.peek, startTranslate + dy));
    sheet.style.transform = `translateY(${next}px)`;
  }

  function onPointerUp(e) {
    if (!dragging || e.pointerId !== pointerId) return;
    dragging = false;
    pointerId = null;
    sheet.classList.remove("dragging");
    const snaps = snapPositionsPx(sheet);
    const currentPx = getCurrentTranslateY(sheet);
    const target = nearestSnap(currentPx, snaps);
    sheet.style.transform = "";
    sheet.dataset.snap = target;
    if (state.map) setTimeout(() => state.map.invalidateSize(), 320);
    updatePeekSummary();
  }

  for (const el of [handle, peek]) {
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerUp);
  }

  // Tap (no drag) on peek header → cycle to next state
  peek.addEventListener("click", () => {
    if (!isMobileLayout()) return;
    if (dragMoved) { dragMoved = false; return; }
    const cur = sheet.dataset.snap || "mid";
    const next = cur === "peek" ? "mid" : cur === "mid" ? "full" : "peek";
    setSnap(sheet, next);
  });

  // When focusing an input, expand to full so the keyboard doesn't hide it
  document.querySelectorAll(".sheet input, .sheet select").forEach((el) => {
    el.addEventListener("focus", () => {
      if (!isMobileLayout()) return;
      if (sheet.dataset.snap !== "full") setSnap(sheet, "full");
    });
  });

  // Recompute on resize
  window.addEventListener("resize", () => {
    sheet.style.transform = "";
    if (state.map) state.map.invalidateSize();
  });
}

function updatePeekSummary() {
  const title = document.getElementById("peek-title");
  const sub = document.getElementById("peek-sub");
  const icon = document.getElementById("peek-icon");
  if (!title || !sub) return;

  if (state.view === "loading") {
    title.textContent = "Calcul en cours…";
    sub.textContent = "Recherche des meilleurs itinéraires";
    if (icon) icon.textContent = "⏱️";
    return;
  }

  if (state.view === "form" || !state.routes.length) {
    title.textContent = "Où va-t-on ?";
    sub.textContent = "Compare le plus rapide, l'éco et le moins cher";
    if (icon) icon.textContent = "🗺️";
    return;
  }

  const fromLabel = (state.points.from?.label || "Départ").split(",")[0];
  const toLabel = (state.points.to?.label || "Arrivée").split(",")[0];
  title.textContent = `${fromLabel} → ${toLabel}`;

  if (state.view === "roadbook" && state.roadbookIndex != null) {
    const m = state.routes[state.roadbookIndex].metrics;
    sub.textContent = `Feuille de route · ${fmtDuration(m.durationH)} · ${fmtMoney(m.totalCost)}`;
    if (icon) icon.textContent = "🧭";
    return;
  }

  const cheapest = state.routes.reduce((a, b) => a.metrics.totalCost <= b.metrics.totalCost ? a : b);
  sub.textContent = `${fmtDuration(cheapest.metrics.durationH)} · ${fmtKm(cheapest.metrics.distanceKm)} · ${fmtMoney(cheapest.metrics.totalCost)}`;
  if (icon) icon.textContent = "🗺️";
}

/* ---------------- Boot ---------------- */

function boot() {
  initMap();
  initBottomSheet();
  attachAutocomplete("from", "from-suggestions", "from");
  attachAutocomplete("to", "to-suggestions", "to");
  document.getElementById("search").addEventListener("click", runSearch);

  const backBtn = document.getElementById("peek-back");
  if (backBtn) {
    ["pointerdown", "click"].forEach((evt) =>
      backBtn.addEventListener(evt, (e) => {
        e.stopPropagation();
        if (evt === "click") goBack();
      })
    );
  }

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
      updatePeekSummary();
    });
  });
}

document.addEventListener("DOMContentLoaded", boot);
