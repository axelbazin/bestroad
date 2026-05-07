/* BestRoad — simulateur d'itinéraire
 * Carte: Mapbox GL JS + style Mapbox Standard (3D buildings, sky, light preset)
 * Géocodage: Nominatim (OSM)
 * Routage: OSRM public demo (alternatives=true)
 */

const OSRM_BASE = "https://router.project-osrm.org";
const NOMINATIM_BASE = "https://nominatim.openstreetmap.org";
const MAP_STYLE = "mapbox://styles/mapbox/standard";

const ROUTE_SRC = "br-routes";
const ROUTE_HALO_LAYER = "br-routes-halo";
const ROUTE_LINE_LAYER = "br-routes-line";

function ensureMapboxToken() {
  let token = localStorage.getItem("mapbox_token") || "";
  if (!token || !token.startsWith("pk.")) {
    const entered = window.prompt(
      "Colle ton token public Mapbox (commence par pk.…)\n\nMapbox offre 50 000 chargements/mois gratuits.\nSans carte bancaire enregistrée, tu ne pourras jamais être facturé.\nTu peux générer un token sur mapbox.com → Account → Tokens.",
      ""
    );
    if (entered && entered.trim().startsWith("pk.")) {
      token = entered.trim();
      localStorage.setItem("mapbox_token", token);
    }
  }
  if (!token) {
    document.body.insertAdjacentHTML(
      "afterbegin",
      `<div style="position:fixed;top:0;left:0;right:0;background:#fbbf24;color:#1a1300;padding:10px 14px;font-family:inherit;font-size:13px;z-index:9999;text-align:center;">
         Token Mapbox manquant. Recharge la page et colle ton token public (pk.…)
       </div>`
    );
    throw new Error("Mapbox token requis");
  }
  mapboxgl.accessToken = token;
}

function isMapboxStandard() {
  return MAP_STYLE.includes("/standard");
}

const ROUTE_STYLES = {
  fast:  { color: "#3b82f6", label: "Le plus rapide",        emoji: "⚡" },
  eco:   { color: "#22c55e", label: "Le moins gourmand",     emoji: "🌿" },
  cheap: { color: "#a855f7", label: "Le moins cher",         emoji: "💶" },
  alt:   { color: "#64748b", label: "Itinéraire alternatif", emoji: "•"  },
};

const state = {
  map: null,
  styleLoaded: false,
  routes: [],
  analyses: [],
  boothMarkers: [],
  markers: { from: null, to: null },
  points: { from: null, to: null },
  activeIndex: null,
  view: "form",
  roadbookIndex: null,
  geo: { watchId: null, marker: null, lastPos: null, follow: false, autoPitch: true },
};

/* ---------------- Map ---------------- */

function initMap() {
  state.map = new mapboxgl.Map({
    container: "map",
    style: MAP_STYLE,
    center: [2.5, 46.6],
    zoom: 5,
    pitch: 0,
    bearing: 0,
    attributionControl: false,
    cooperativeGestures: false,
  });

  state.map.addControl(new mapboxgl.AttributionControl({ compact: true }), "top-right");
  state.map.addControl(
    new mapboxgl.NavigationControl({ visualizePitch: true, showCompass: true }),
    "top-right"
  );

  state.map.on("style.load", () => {
    state.styleLoaded = true;
    if (isMapboxStandard()) {
      // Mapbox Standard a son propre système de buildings 3D + sky.
      // On configure juste le preset lumineux pour un rendu plus chaleureux.
      try {
        state.map.setConfigProperty("basemap", "lightPreset", "day");
        state.map.setConfigProperty("basemap", "show3dObjects", true);
      } catch (_) {}
    } else {
      add3DBuildings();
    }
    setupAutoPitch();
    if (state.pendingRoutes) {
      drawRoutes(state.pendingRoutes.routes, state.pendingRoutes.tags);
      state.pendingRoutes = null;
    }
  });

  state.map.on("error", (e) => {
    console.warn("[map]", e.error || e);
  });
}

function add3DBuildings() {
  const m = state.map;
  // OFM Liberty source = "openmaptiles". Si absent, on tente "maptiler_planet".
  const styleSources = m.getStyle().sources || {};
  let sourceName = null;
  for (const [name, src] of Object.entries(styleSources)) {
    if (src.type === "vector" && (name === "openmaptiles" || /openmaptiles|planet|tiles/i.test(name))) {
      sourceName = name;
      break;
    }
  }
  if (!sourceName) return;

  const layers = m.getStyle().layers || [];
  // Insère les bâtiments 3D juste avant le premier layer de symboles (labels)
  // pour ne pas masquer les noms de villes.
  const beforeLayer = layers.find((l) => l.type === "symbol");

  if (m.getLayer("br-3d-buildings")) m.removeLayer("br-3d-buildings");

  m.addLayer(
    {
      id: "br-3d-buildings",
      source: sourceName,
      "source-layer": "building",
      type: "fill-extrusion",
      minzoom: 13,
      paint: {
        "fill-extrusion-color": [
          "interpolate", ["linear"], ["zoom"],
          13, "#3a4769",
          16, "#5a6a95",
          18, "#7886b0",
        ],
        "fill-extrusion-height": [
          "interpolate", ["linear"], ["zoom"],
          13, 0,
          15, ["coalesce", ["get", "render_height"], ["get", "height"], 5],
        ],
        "fill-extrusion-base": ["coalesce", ["get", "render_min_height"], 0],
        "fill-extrusion-opacity": 0.85,
      },
    },
    beforeLayer ? beforeLayer.id : undefined
  );
}

function targetPitchForZoom(z) {
  // 0° en dessous de zoom 12, montée progressive jusqu'à 55° à zoom 17+
  if (z <= 12) return 0;
  if (z >= 17) return 55;
  return ((z - 12) / 5) * 55;
}

function setupAutoPitch() {
  state.map.on("pitchstart", (e) => {
    if (e.originalEvent) state.geo.autoPitch = false;
  });
  state.map.on("zoomend", () => {
    if (!state.geo.autoPitch) return;
    const target = targetPitchForZoom(state.map.getZoom());
    if (Math.abs(state.map.getPitch() - target) > 1) {
      state.map.easeTo({ pitch: target, duration: 350 });
    }
  });
}

function clearLayers() {
  if (!state.map || !state.styleLoaded) return;
  for (const id of [ROUTE_LINE_LAYER, ROUTE_HALO_LAYER]) {
    if (state.map.getLayer(id)) state.map.removeLayer(id);
  }
  if (state.map.getSource(ROUTE_SRC)) state.map.removeSource(ROUTE_SRC);
}

function fitToRoutes(routes) {
  let minLon = 180, maxLon = -180, minLat = 90, maxLat = -90;
  for (const r of routes) {
    for (const [lon, lat] of r.geometry.coordinates) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  if (minLon > maxLon) return;
  state.map.fitBounds([[minLon, minLat], [maxLon, maxLat]], {
    padding: { top: 60, bottom: Math.round(window.innerHeight * 0.5), left: 40, right: 40 },
    duration: 700,
    pitch: 0,
  });
  state.geo.autoPitch = true;
}

function drawRoutes(routes, tags) {
  if (!state.map) return;
  if (!state.styleLoaded) {
    state.pendingRoutes = { routes, tags };
    return;
  }
  clearLayers();

  const features = routes.map((r, i) => ({
    type: "Feature",
    id: i,
    properties: {
      idx: i,
      tag: tags[i],
      color: ROUTE_STYLES[tags[i]].color,
    },
    geometry: r.geometry,
  }));

  state.map.addSource(ROUTE_SRC, {
    type: "geojson",
    data: { type: "FeatureCollection", features },
  });

  state.map.addLayer({
    id: ROUTE_HALO_LAYER,
    source: ROUTE_SRC,
    type: "line",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": "#0b1226",
      "line-width": [
        "case", ["boolean", ["feature-state", "active"], false], 13, 9,
      ],
      "line-opacity": 0.45,
    },
  });

  state.map.addLayer({
    id: ROUTE_LINE_LAYER,
    source: ROUTE_SRC,
    type: "line",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: {
      "line-color": ["get", "color"],
      "line-width": [
        "case", ["boolean", ["feature-state", "active"], false], 7, 5,
      ],
      "line-opacity": [
        "case", ["boolean", ["feature-state", "active"], false], 1.0, 0.55,
      ],
    },
  });

  // Click sur une route → la sélectionne
  state.map.on("click", ROUTE_LINE_LAYER, (e) => {
    const f = e.features?.[0];
    if (f && typeof f.id === "number") selectRoute(f.id);
  });
  state.map.on("mouseenter", ROUTE_LINE_LAYER, () => state.map.getCanvas().style.cursor = "pointer");
  state.map.on("mouseleave", ROUTE_LINE_LAYER, () => state.map.getCanvas().style.cursor = "");

  fitToRoutes(routes);
}

function setMarker(kind, lat, lon, label) {
  if (state.markers[kind]) {
    state.markers[kind].setLngLat([lon, lat]);
    return;
  }
  const el = document.createElement("div");
  el.className = `endpoint-marker endpoint-${kind}`;
  el.textContent = kind === "from" ? "A" : "B";
  el.title = label || "";
  state.markers[kind] = new mapboxgl.Marker({ element: el, anchor: "center" })
    .setLngLat([lon, lat])
    .addTo(state.map);
}

function selectRoute(index) {
  state.activeIndex = index;
  if (state.routes.length && state.styleLoaded && state.map.getSource(ROUTE_SRC)) {
    state.routes.forEach((_, i) => {
      state.map.setFeatureState(
        { source: ROUTE_SRC, id: i },
        { active: i === index }
      );
    });
  }
  document.querySelectorAll(".route-card").forEach((el) => {
    el.classList.toggle("active", parseInt(el.dataset.index, 10) === index);
  });
  renderTollPins(index);
}

function clearTollPins() {
  state.boothMarkers.forEach((m) => m.remove());
  state.boothMarkers = [];
}

function renderTollPins(routeIndex) {
  clearTollPins();
  if (routeIndex == null) return;
  const booths = state.analyses?.[routeIndex]?.booths || [];
  for (const b of booths) {
    const el = document.createElement("div");
    el.className = "toll-pin-wrap";
    el.innerHTML = `<div class="toll-pin">€</div>`;
    const marker = new mapboxgl.Marker({ element: el, anchor: "bottom" })
      .setLngLat([b.lon, b.lat]);
    if (b.name || b.operator) {
      const opLabel = window.BR_Tolls?.OPERATOR_LABELS?.[b.operator] || b.operator || "Péage";
      marker.setPopup(
        new mapboxgl.Popup({ closeButton: false, offset: 18 }).setHTML(
          `<div style="font-family:inherit;color:#0f172a"><b>${escapeHtml(b.name || "Péage")}</b><br><span style="color:#64748b;font-size:12px">${escapeHtml(opLabel)}</span></div>`
        )
      );
    }
    marker.addTo(state.map);
    state.boothMarkers.push(marker);
  }
}

/* ---------------- Geolocation ---------------- */

function geolocateOnce() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error("Géolocalisation non supportée"));
    navigator.geolocation.getCurrentPosition(
      resolve,
      (err) => reject(new Error(geoErrorMessage(err))),
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  });
}

function geoErrorMessage(err) {
  if (!err) return "Erreur de géolocalisation";
  if (err.code === 1) return "Localisation refusée. Active-la dans les réglages.";
  if (err.code === 2) return "Position indisponible.";
  if (err.code === 3) return "La géolocalisation a expiré.";
  return err.message || "Erreur de géolocalisation";
}

async function fillFromMyLocation() {
  const btn = document.getElementById("locate-input");
  if (btn) btn.classList.add("loading");
  try {
    const pos = await geolocateOnce();
    const { latitude, longitude } = pos.coords;
    let label = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
    try {
      const url = `${NOMINATIM_BASE}/reverse?format=json&lat=${latitude}&lon=${longitude}`;
      const res = await fetch(url, { headers: { "Accept-Language": "fr" } });
      if (res.ok) {
        const data = await res.json();
        if (data.display_name) label = data.display_name;
      }
    } catch (_) {}
    state.points.from = { lat: latitude, lon: longitude, label };
    document.getElementById("from").value = label;
    setMarker("from", latitude, longitude, label);
    state.map.flyTo({ center: [longitude, latitude], zoom: 13, pitch: targetPitchForZoom(13), duration: 900 });
    state.geo.autoPitch = true;
    setStatus("");
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    if (btn) btn.classList.remove("loading");
  }
}

function ensureUserMarker(lat, lon, heading) {
  if (!state.geo.marker) {
    const wrap = document.createElement("div");
    wrap.className = "user-location";
    wrap.innerHTML = `
      <div class="user-accuracy"></div>
      <div class="user-dot"></div>
    `;
    state.geo.marker = new mapboxgl.Marker({ element: wrap, anchor: "center" })
      .setLngLat([lon, lat])
      .addTo(state.map);
  } else {
    state.geo.marker.setLngLat([lon, lat]);
  }
  if (typeof heading === "number" && !Number.isNaN(heading)) {
    const dot = state.geo.marker.getElement().querySelector(".user-dot");
    if (dot) dot.style.setProperty("--heading", `${heading}deg`);
    state.geo.marker.getElement().classList.add("has-heading");
  } else {
    state.geo.marker.getElement().classList.remove("has-heading");
  }
}

function startWatchPosition() {
  if (!navigator.geolocation || state.geo.watchId != null) return;
  state.geo.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      state.geo.lastPos = pos;
      const { latitude, longitude, heading } = pos.coords;
      ensureUserMarker(latitude, longitude, heading);
      if (state.geo.follow) {
        state.map.easeTo({ center: [longitude, latitude], duration: 600 });
      }
    },
    (err) => {
      console.warn("[geo]", err);
      setStatus(geoErrorMessage(err), true);
      stopFollow();
    },
    { enableHighAccuracy: true, maximumAge: 3000, timeout: 15000 }
  );
}

function stopFollow() {
  state.geo.follow = false;
  document.getElementById("locate-btn")?.classList.remove("active");
}

async function toggleFollow() {
  const btn = document.getElementById("locate-btn");
  if (!btn) return;

  if (state.geo.follow) {
    stopFollow();
    return;
  }

  btn.classList.add("loading");
  try {
    if (!state.geo.lastPos) {
      const pos = await geolocateOnce();
      state.geo.lastPos = pos;
      const { latitude, longitude, heading } = pos.coords;
      ensureUserMarker(latitude, longitude, heading);
    }
    state.geo.follow = true;
    btn.classList.add("active");
    startWatchPosition();
    const { latitude, longitude } = state.geo.lastPos.coords;
    state.map.flyTo({ center: [longitude, latitude], zoom: 15, pitch: targetPitchForZoom(15), duration: 900 });
    state.geo.autoPitch = true;
  } catch (e) {
    setStatus(e.message, true);
  } finally {
    btn.classList.remove("loading");
  }
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
    setTimeout(() => state.map.resize(), 320);
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
    if (state.map) setTimeout(() => state.map.resize(), 320);
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
    if (state.map) state.map.resize();
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
  try {
    ensureMapboxToken();
  } catch (e) {
    console.error(e);
    return;
  }
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

  const locateInput = document.getElementById("locate-input");
  if (locateInput) {
    locateInput.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      fillFromMyLocation();
    });
  }

  const locateBtn = document.getElementById("locate-btn");
  if (locateBtn) {
    locateBtn.addEventListener("click", () => toggleFollow());
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
