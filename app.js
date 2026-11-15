/* ORBITAL GUARDIAN — aplicación estática, sin claves ni proceso de compilación.
 * Servir esta carpeta por HTTP; file:// no permite descargar el CSV con fetch.
 * FFWI publicado + VPD físico + evidencia FIRMS: índice compuesto experimental.
 * No predice un perímetro de fuego ni sustituye decisiones de autoridades.
 */
'use strict';

const CONFIG = Object.freeze({
  csv: './incendios_nasa.csv',
  assets: 'https://unpkg.com/three-globe@2.41.12/example/img/',
  weather: 'https://api.open-meteo.com/v1/forecast',
  geocoding: 'https://geocoding-api.open-meteo.com/v1/search',
  maxFires: 2500,
  nearbyKm: 150,
  // En producción, inyectar un proxy con límite agregado y proveedor sustituible.
  reverse: window.ORBITAL_REVERSE_ENDPOINT || 'https://nominatim.openstreetmap.org/reverse',
  countries: 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/v5.1.2/geojson/ne_110m_admin_0_countries.geojson',
  cacheMs: 10 * 60 * 1000,
  home: { lat: 0, lng: 0, name: 'Esperando selección desde NASA FIRMS' }
});

const state = {
  globe: null, globeReady: false, fires: [], topFires: [], csvReady: false,
  csvLoading: false, csvError: '', csvVersion: 0, csvRange: '', metric: 'brightness',
  selected: { ...CONFIG.home }, weather: null, proximity: null, forecast: [],
  weatherLoading: false, weatherError: '', weatherRequest: 0, weatherAbort: null,
  searchRequest: 0, searchAbort: null, cache: new Map(), observations: new Map(),
  history: [], charts: {}, opacity: .85, pulse: 1, pulseTimer: null,
  reduceMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  latestFetch: null, toastTimer: null, resizeObserver: null,
  view: 'explorar', science: null, stats: null, countries: null,
  rankedFrp: [], patrolTimer: null, patrolIndex: 0, reverseTimer: null,
  reverseCache: new Map(), reverseQueue: Promise.resolve(), reverseLast: 0,
  place: null, datasetHash: null, continentVersion: 0, initialFocus: false,
  layers: { base: false, satellite: true, terrain: true, temperature: false, fires: true, rain: false }
};

const $ = id => document.getElementById(id);
const clamp = (value, min = 0, max = 1) => Math.min(max, Math.max(min, value));
const number = value => value === null || value === undefined || String(value).trim() === '' ? NaN : Number(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const escapeHTML = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const locationKey = loc => `${loc.lat.toFixed(4)},${loc.lng.toFixed(4)}`;
const validCoordinates = (lat, lng) => finite(lat) && finite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
const formatNumber = (value, digits = 1) => finite(value) ? value.toLocaleString('es', { maximumFractionDigits: digits, minimumFractionDigits: digits }) : '—';
const coordinates = loc => `${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}`;
const hourUTC = timestamp => new Date(timestamp).toLocaleTimeString('es', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hour12: false });
const dateUTC = timestamp => finite(timestamp) ? `${new Date(timestamp).toISOString().slice(0, 10)} ${hourUTC(timestamp)} UTC` : 'Fecha no disponible';

function notify(message, type = 'info') {
  clearTimeout(state.toastTimer);
  $('toast').textContent = message;
  $('toast').dataset.type = type;
  $('toast').hidden = false;
  state.toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6500);
}

function updateClock() {
  const now = new Date();
  $('utc-clock').textContent = `${now.toISOString().slice(11, 19)} UTC`;
  $('utc-clock').dateTime = now.toISOString();
  if (state.latestFetch) {
    const minutes = Math.max(0, Math.floor((Date.now() - state.latestFetch) / 60000));
    $('data-status').innerHTML = `<i class="status-dot"></i> CLIMA CONSULTADO ${minutes ? `HACE ${minutes} MIN` : 'AHORA'} · CSV LOCAL`;
  }
}

function updateSystemStatus() {
  const online = navigator.onLine && state.csvReady && !state.csvError && !!state.weather && state.globeReady;
  $('system-status').classList.toggle('degraded', !online);
  $('system-text').textContent = online ? 'SISTEMA EN LÍNEA' : !navigator.onLine ? 'SIN CONEXIÓN' : state.csvLoading || state.weatherLoading ? 'SINCRONIZANDO DATOS' : 'SERVICIO PARCIAL';
  if (!state.latestFetch) $('data-status').textContent = online ? 'FUENTES CONECTADAS' : 'ESPERANDO FUENTES · SIN DATOS SIMULADOS';
}

// Distancia de gran círculo; funciona también al cruzar el antimeridiano.
function distanciaKm(lat1, lng1, lat2, lng2) {
  const radians = Math.PI / 180;
  const dLat = (lat2 - lat1) * radians;
  const dLng = (lng2 - lng1) * radians;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * radians) * Math.cos(lat2 * radians) * Math.sin(dLng / 2) ** 2;
  return 6371.0088 * 2 * Math.atan2(Math.sqrt(clamp(a)), Math.sqrt(1 - clamp(a)));
}

function analizarCercania(lat, lng, fires) {
  let nearestKm = Infinity;
  let nearby = 0;
  let frpSum = 0;
  let frpCount = 0;
  let latest = -Infinity;
  for (const fire of fires) {
    const km = distanciaKm(lat, lng, fire.lat, fire.lng);
    nearestKm = Math.min(nearestKm, km);
    if (km <= CONFIG.nearbyKm) {
      nearby++;
      if (finite(fire.frp)) { frpSum += fire.frp; frpCount++; }
      if (finite(fire.timestamp)) latest = Math.max(latest, fire.timestamp);
    }
  }
  return { nearestKm, nearby, frpSum: nearby && !frpCount ? null : frpSum, frpCount, missingFrp: nearby - frpCount, latest: finite(latest) ? latest : null, total: fires.length };
}

/** Tetens sobre agua líquida; dominio operativo explícito −40…60 °C.
 * Coeficiente 0.61078 solicitado (FAO-56 utiliza 0.6108 redondeado).
 * El índice compuesto mantiene separados los cálculos físicos y las ponderaciones.
 */
// Fosberg/Simard: temperatura en °F y viento en mph, NO en unidades métricas.
// Goodrick (2002), ecuaciones 1–3: https://www.srs.fs.usda.gov/pubs/ja/ja_goodrick001.pdf
function calcularFFWI(T, RH, wind) {
  if (![T, RH, wind].every(finite) || T < -40 || T > 60 || RH < 0 || RH > 100 || wind < 0) return null;
  const fahrenheit = T * 9 / 5 + 32;
  const mph = wind / 1.609344;
  const moisture = RH < 10
    ? .03229 + .281073 * RH - .000578 * RH * fahrenheit
    : RH <= 50
      ? 2.22749 + .160107 * RH - .01478 * fahrenheit
      : 21.0606 + .005565 * RH ** 2 - .00035 * RH * fahrenheit - .483199 * RH;
  const ratio = clamp(moisture, 0, 30) / 30;
  const damping = clamp(1 - 2 * ratio + 1.5 * ratio ** 2 - .5 * ratio ** 3);
  const raw = damping * Math.sqrt(1 + mph ** 2) / .3002;
  return { value: clamp(raw, 0, 100), raw, moisture: clamp(moisture, 0, 30), damping, fahrenheit, mph };
}

// Ponderaciones de diseño explícitas; NO calibración ni probabilidad de ignición.
const RISK_MODEL = Object.freeze({ name: 'OG-FFWI-VPD-FIRMS v1', ffwiWeight: .65, vpdWeight: .20, firmsWeight: .15, vpdScaleKpa: 5, frpScaleMw: 1000, distanceScaleKm: 50 });

function calcularRiesgoCientifico(T, RH, wind, direction, proximity) {
  const valid = [T, RH].every(finite) && T >= -40 && T <= 60 && RH >= 0 && RH <= 100;
  const svp = valid ? .61078 * Math.exp(17.27 * T / (T + 237.3)) : null;
  const vpd = valid ? svp * (1 - RH / 100) : null;
  const windValid = finite(wind) && wind >= 0;
  const directionValid = finite(direction) && direction >= 0 && direction <= 360;
  const ffwi = calcularFFWI(T, RH, wind);
  const result = { svp, vpd, ffwi: ffwi?.value ?? null, ffwiRaw: ffwi?.raw ?? null, moisture: ffwi?.moisture ?? null, frp: proximity?.frpSum ?? null, nearestKm: finite(proximity?.nearestKm) ? proximity.nearestKm : null, nearby: proximity?.nearby ?? null, wind: windValid ? wind : null, direction: directionValid ? direction : null, downwind: directionValid ? (direction + 180) % 360 : null, index: null, contributions: null, reason: 'Esperando clima y evidencia FIRMS completos.', modelName: RISK_MODEL.name };
  if (!ffwi || !finite(vpd)) { result.reason = 'Clima incompleto o fuera del dominio −40…60 °C.'; return result; }
  if (!proximity || !Number.isInteger(proximity.nearby) || proximity.nearby < 0 || !finite(result.frp) || result.frp < 0 || proximity.missingFrp > 0 || (proximity.nearby > 0 && (!finite(result.nearestKm) || result.nearestKm < 0))) return result;
  const evidence = proximity.nearby === 0 ? 0 : Math.exp(-result.nearestKm / RISK_MODEL.distanceScaleKm) * clamp(Math.log1p(result.frp) / Math.log1p(RISK_MODEL.frpScaleMw));
  result.contributions = { ffwi: RISK_MODEL.ffwiWeight * ffwi.value, vpd: RISK_MODEL.vpdWeight * 100 * clamp(vpd / RISK_MODEL.vpdScaleKpa), firms: RISK_MODEL.firmsWeight * 100 * evidence };
  result.index = clamp(Object.values(result.contributions).reduce((sum, value) => sum + value, 0), 0, 100);
  result.reason = 'Índice compuesto experimental 0–100; no es probabilidad de ignición ni alerta oficial.';
  return result;
}

function riskLevel(risk) {
  if (!finite(risk)) return { key: 'unknown', label: 'SIN DATOS', color: '#8893a3' };
  if (risk > 70) return { key: 'high', label: 'RIESGO ALTO', color: '#ff4355' };
  if (risk >= 40) return { key: 'moderate', label: 'RIESGO MODERADO', color: '#f6c942' };
  return { key: 'low', label: 'RIESGO BAJO', color: '#16d478' };
}

function parseAcquisition(row) {
  const date = String(row.acq_date || '').trim();
  const time = String(row.acq_time ?? '').trim().padStart(4, '0');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{4}$/.test(time) || Number(time.slice(0, 2)) > 23 || Number(time.slice(2)) > 59) return NaN;
  const timestamp = Date.parse(`${date}T${time.slice(0, 2)}:${time.slice(2)}:00Z`);
  return finite(timestamp) && new Date(timestamp).toISOString().slice(0, 10) === date ? timestamp : NaN;
}

function normalizeFires(rows) {
  const valid = [];
  const seen = new Set();
  let skipped = 0;
  for (const row of rows) {
    const lat = number(row.latitude);
    const lng = number(row.longitude);
    const brightness = number(row.brightness ?? row.bright_ti4);
    const frp = number(row.frp);
    if (!validCoordinates(lat, lng) || (!finite(brightness) && !finite(frp))) { skipped++; continue; }
    const timestamp = parseAcquisition(row);
    const key = `${lat}|${lng}|${row.acq_date}|${row.acq_time}|${row.satellite}|${row.instrument || ''}`;
    if (seen.has(key)) { skipped++; continue; }
    seen.add(key);
    valid.push({ id: valid.length, lat, lng, brightness: brightness > 0 ? brightness : NaN, frp: frp >= 0 ? frp : NaN, timestamp, acqDate: String(row.acq_date || ''), acqTime: String(row.acq_time ?? '').padStart(4, '0'), satellite: String(row.satellite || 'Sin dato'), confidence: String(row.confidence ?? 'Sin dato'), type: 'fire' });
  }
  // Una misma magnitud para todas las filas: nunca mezclar kelvin y megavatios.
  const metric = valid.some(fire => finite(fire.frp)) ? 'frp' : 'brightness';
  valid.sort((a, b) => (finite(b[metric]) ? b[metric] : -Infinity) - (finite(a[metric]) ? a[metric] : -Infinity) || (b.timestamp || 0) - (a.timestamp || 0));
  const max = valid.length ? valid[0][metric] : 1;
  const min = valid.reduce((value, fire) => finite(fire[metric]) ? Math.min(value, fire[metric]) : value, max);
  for (const fire of valid) fire.strength = finite(fire[metric]) ? clamp((fire[metric] - min) / Math.max(1, max - min)) : 0;
  return { fires: valid, metric, skipped };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 20000) {
  const controller = new AbortController();
  const relay = () => controller.abort();
  if (options.signal?.aborted) controller.abort();
  else options.signal?.addEventListener('abort', relay, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}${response.status === 429 ? ' · límite de consultas; espera un minuto' : ''}`);
    // Consumir el cuerpo antes de quitar el timeout también protege descargas lentas.
    return await response.text();
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', relay);
  }
}

async function loadFires() {
  if (state.csvLoading) return;
  state.csvLoading = true;
  state.csvError = '';
  $('csv-status').textContent = 'CSV: leyendo detecciones…';
  updateSystemStatus();
  try {
    if (!window.Papa) throw new Error('PapaParse no está disponible. Comprueba el CDN.');
    if (location.protocol === 'file:') throw new Error('Abre la carpeta con Live Server o un servidor HTTP; file:// bloquea la lectura del CSV.');
    const text = await fetchWithTimeout(CONFIG.csv, { cache: 'no-store' }, 45000);
    const parsed = await new Promise((resolve, reject) => {
      // transformHeader contiene una función no clonable hacia un Web Worker.
      Papa.parse(text, { header: true, skipEmptyLines: 'greedy', worker: false, transformHeader: header => header.replace(/^\uFEFF/, '').trim().toLowerCase(), complete: resolve, error: reject });
    });
    if (!parsed.meta.fields?.includes('latitude') || !parsed.meta.fields?.includes('longitude')) throw new Error('El CSV no contiene las columnas latitude y longitude.');
    if (parsed.errors.some(error => error.code === 'MissingQuotes')) throw new Error('CSV malformado: hay comillas sin cerrar.');
    const normalized = normalizeFires(parsed.data);
    if (!normalized.fires.length) throw new Error('El archivo no contiene detecciones con coordenadas e intensidad válidas.');
    state.fires = normalized.fires;
    state.rankedFrp = state.fires.filter(fire => finite(fire.frp)).sort((a, b) => b.frp - a.frp || (b.timestamp || 0) - (a.timestamp || 0));
    state.metric = normalized.metric;
    state.topFires = state.fires.slice(0, CONFIG.maxFires);
    state.csvReady = true;
    state.csvVersion++;
    state.observations.clear();
    const dates = state.fires.map(fire => fire.timestamp).filter(finite);
    const start = dates.reduce((a, b) => Math.min(a, b), Infinity);
    const end = dates.reduce((a, b) => Math.max(a, b), -Infinity);
    state.csvRange = dates.length ? `${new Date(start).toISOString().slice(0, 10)} → ${new Date(end).toISOString().slice(0, 10)}` : 'Sin fechas válidas';
    state.stats = datasetStatistics(state.fires, parsed.data.length, normalized.skipped);
    state.datasetHash = null;
    if (window.crypto?.subtle) crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)).then(hash => {
      state.datasetHash = [...new Uint8Array(hash)].map(byte => byte.toString(16).padStart(2, '0')).join('');
      renderDataset();
    }).catch(() => {});
    $('csv-status').textContent = `CSV: ${state.fires.length.toLocaleString('es')} focos · ${state.csvRange} UTC${normalized.skipped ? ` · ${normalized.skipped} filas omitidas` : ''}`;
    $('fire-count').textContent = state.topFires.length.toLocaleString('es');
    $('nav-alert-count').textContent = state.topFires.length.toLocaleString('es');
    renderAlerts($('alert-list'), 3);
    state.proximity = analizarCercania(state.selected.lat, state.selected.lng, state.fires);
    if (state.weather) renderAnalysis();
    renderGlobeData();
    renderDataset();
    renderCrisis();
    renderHistoryView();
    classifyContinents();
    if (!state.initialFocus && state.rankedFrp.length) {
      state.initialFocus = true;
      selectLocation(fireLocation(state.rankedFrp[0]));
    }
    if (parsed.errors.length) notify(`CSV cargado con ${parsed.errors.length} advertencias de formato; revisa las columnas del archivo.`);
    if (dates.length && Date.now() - end > 72 * 3600000) notify('El CSV tiene más de 72 horas. Las detecciones no implican incendios todavía activos.');
  } catch (error) {
    console.error('NASA FIRMS:', error);
    state.csvError = error.message;
    $('csv-status').textContent = `CSV: ${error.message}`;
    if (!state.csvReady) {
      $('alert-list').textContent = 'No se pudieron cargar detecciones reales.';
      renderAnalysis();
      $('crisis-summary').textContent = `Datos no disponibles: ${error.message}`;
      $('dataset-stats').textContent = 'No hay estadísticas sin CSV válido.';
    }
    notify(`NASA FIRMS: ${error.message}`, 'error');
  } finally { state.csvLoading = false; updateSystemStatus(); }
}

function fireTooltip(fire) {
  return `<div class="globe-tooltip"><strong>Anomalía térmica · NASA FIRMS</strong><small>${coordinates(fire)}</small><small>Brillo: ${formatNumber(fire.brightness)} K · FRP: ${formatNumber(fire.frp)} MW</small><small>${dateUTC(fire.timestamp)}</small><small>Satélite: ${escapeHTML(fire.satellite)} · confianza: ${escapeHTML(fire.confidence)}</small><small>Clic para analizar las condiciones actuales</small></div>`;
}

function fireLocation(fire) {
  return { lat: fire.lat, lng: fire.lng, name: `Foco FIRMS · ${fire.lat.toFixed(2)}°, ${fire.lng.toFixed(2)}°`, fireId: fire.id };
}

function renderAlerts(container, limit) {
  container.replaceChildren();
  if (!state.csvReady) { container.textContent = state.csvError || 'Esperando NASA FIRMS…'; return; }
  for (const fire of state.topFires.slice(0, limit)) {
    const button = document.createElement('button');
    button.className = 'alert-item';
    button.innerHTML = `<svg class="icon filled"><use href="#i-fire"/></svg><span><strong>Anomalía térmica detectada</strong><small>${coordinates(fire)} · ${state.metric === 'brightness' ? `${formatNumber(fire.brightness)} K` : `${formatNumber(fire.frp)} MW`}</small></span><time>${finite(fire.timestamp) ? `${new Date(fire.timestamp).toISOString().slice(5, 10)}<br>${hourUTC(fire.timestamp)} UTC` : 'Sin fecha'}</time>`;
    button.setAttribute('aria-label', `Analizar foco en ${coordinates(fire)}, ${dateUTC(fire.timestamp)}`);
    button.addEventListener('click', () => { $('detail-dialog').close(); selectLocation(fireLocation(fire)); });
    container.append(button);
  }
}

function initializeGlobe() {
  try {
    if (!window.Globe) throw new Error('No se pudo cargar Globe.gl desde el CDN.');
    const host = $('globe');
    state.globe = new Globe(host, { animateIn: !state.reduceMotion, waitForGlobeReady: false })
      .width(host.clientWidth).height(host.clientHeight)
      .backgroundColor('#010409')
      .backgroundImageUrl(`${CONFIG.assets}night-sky.png`)
      .globeImageUrl(`${CONFIG.assets}earth-blue-marble.jpg`)
      .bumpImageUrl(`${CONFIG.assets}earth-topology.png`)
      .showAtmosphere(true).atmosphereColor('#38bdf8').atmosphereAltitude(.19)
      .pointLat('lat').pointLng('lng').pointAltitude(point => point.type === 'fire' ? .007 : .016)
      .pointRadius(pointRadius).pointColor(pointColor).pointResolution(7)
      .pointsMerge(false).pointsTransitionDuration(state.reduceMotion ? 0 : 850)
      .pointLabel(point => point.type === 'fire' ? fireTooltip(point) : `<div class="globe-tooltip">${escapeHTML(point.name)}<small>${coordinates(point)}</small></div>`)
      .onPointClick(point => selectLocation(point.type === 'fire' ? fireLocation(point) : point))
      .onGlobeClick(({ lat, lng }) => selectLocation({ lat, lng, name: 'Ubicación seleccionada' }))
      .ringLat('lat').ringLng('lng').ringAltitude(.009).ringResolution(24)
      .ringMaxRadius(.65).ringPropagationSpeed(.7).ringRepeatPeriod(1500)
      .ringColor(() => progress => `rgba(255,76,32,${(1 - progress) * state.opacity * .7})`)
      .labelLat('lat').labelLng('lng').labelText('text').labelSize(.65)
      .labelDotRadius(.22).labelAltitude(.026).labelColor('color')
      .labelResolution(2).labelIncludeDot(true)
      .onLabelClick(label => selectLocation({ lat: label.lat, lng: label.lng, name: label.name }));
    state.globe.renderer().setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    state.globe.globeMaterial().bumpScale = .025;
    const controls = state.globe.controls();
    controls.enableDamping = true;
    controls.dampingFactor = .08;
    controls.minDistance = 115;
    controls.maxDistance = 650;
    controls.autoRotateSpeed = .35;
    controls.enablePan = false;
    state.globe.pointOfView({ lat: 3, lng: -70, altitude: 1.75 }, 0);
    state.resizeObserver = new ResizeObserver(() => {
      if (host.clientWidth > 0 && host.clientHeight > 0) {
        state.globe.width(host.clientWidth).height(host.clientHeight);
        state.globe.globeOffset([host.clientWidth > 760 ? -65 : -25, 12]);
      }
    });
    state.resizeObserver.observe(host);
    state.globe.renderer().domElement.addEventListener('webglcontextlost', event => {
      event.preventDefault(); state.globeReady = false;
      showGlobeError('Se perdió el contexto WebGL. Recarga la página para recuperar el globo. La búsqueda y el análisis siguen disponibles.');
      updateSystemStatus();
    });
    // Comprobación explícita: Globe.gl no expone un manejador de error de textura.
    const image = new Image();
    const timer = setTimeout(() => {
      if (!state.globeReady) showGlobeError('La textura está tardando en cargar. Comprueba el acceso a unpkg.com; la búsqueda sigue disponible.');
    }, 25000);
    image.onload = () => { clearTimeout(timer); state.globeReady = true; $('globe-loading').hidden = true; $('globe-error').hidden = true; updateSystemStatus(); };
    image.onerror = () => { clearTimeout(timer); showGlobeError('No se pudo descargar la textura NASA. Comprueba la conexión con el CDN.'); updateSystemStatus(); };
    image.src = `${CONFIG.assets}earth-blue-marble.jpg`;
    renderGlobeData();
    state.pulseTimer = setInterval(() => {
      if (!document.hidden && !state.reduceMotion && state.layers.fires && state.globeReady) {
        state.pulse = state.pulse === 1 ? 1.4 : 1;
        state.globe.pointRadius(point => pointRadius(point));
      }
    }, 1100);
  } catch (error) { console.error(error); showGlobeError(`${error.message} Se requiere un navegador con WebGL. Puedes seguir buscando y consultando el clima.`); }
}

function showGlobeError(message) {
  $('globe-loading').hidden = true;
  $('globe-error').textContent = message;
  $('globe-error').hidden = false;
}

function pointRadius(point) {
  if (point.type === 'fire') return (.075 + point.strength * .14) * state.pulse;
  if (point.type === 'temperature') return .38;
  if (point.type === 'rain') return .2 + clamp(point.precipitation / 10) * .7;
  return .24;
}

function pointColor(point) {
  if (point.type === 'fire') return `rgba(255,${Math.round(45 + (1 - point.strength) * 70)},24,${state.opacity})`;
  if (point.type === 'temperature') return `hsla(${220 - clamp((point.temperature + 10) / 55) * 220},95%,58%,${state.opacity})`;
  if (point.type === 'rain') return `rgba(52,163,255,${state.opacity})`;
  return '#34b6ff';
}

function renderGlobeData() {
  if (!state.globe) return;
  const points = state.layers.fires && state.opacity > 0 ? [...state.topFires] : [];
  const labels = [{ ...state.selected, text: state.selected.name, color: '#92d5ff' }];
  for (const item of state.observations.values()) {
    const weather = item.weather.current;
    const parts = [];
    if (state.layers.temperature && state.opacity > 0) {
      points.push({ ...item.location, type: 'temperature', temperature: weather.temperature_2m });
      parts.push(`${formatNumber(weather.temperature_2m)} °C`);
    }
    if (state.layers.rain && finite(weather.precipitation) && state.opacity > 0) {
      points.push({ ...item.location, type: 'rain', precipitation: weather.precipitation });
      parts.push(`${formatNumber(weather.precipitation)} mm`);
    }
    if (parts.length) labels.push({ ...item.location, text: parts.join(' · '), color: `rgba(230,240,255,${state.opacity})` });
  }
  points.push({ ...state.selected, type: 'selection' });
  state.globe.pointsData(points).labelsData(labels)
    .ringsData(state.layers.fires && !state.reduceMotion && state.opacity > 0 ? state.topFires.slice(0, 60) : []);
}

function setLayer(name, enabled) {
  state.layers[name] = enabled;
  if (state.globe) {
    if (name === 'base') state.globe.showGraticules(enabled);
    if (name === 'satellite') state.globe.globeImageUrl(`${CONFIG.assets}${enabled ? 'earth-blue-marble.jpg' : 'earth-dark.jpg'}`);
    if (name === 'terrain') { state.globe.bumpImageUrl(enabled ? `${CONFIG.assets}earth-topology.png` : null); state.globe.globeMaterial().bumpScale = enabled ? .025 : 0; }
    renderGlobeData();
  }
  if ((name === 'temperature' || name === 'rain') && enabled) notify('Capa de datos puntuales: solo muestra ubicaciones consultadas; no es un mapa meteorológico global.');
}

function initializeCharts() {
  if (!window.Chart) { notify('Chart.js no está disponible; las métricas numéricas siguen funcionando.', 'error'); return; }
  Chart.defaults.font.family = "'JetBrains Mono', monospace";
  Chart.defaults.color = '#8999ac';
  Chart.defaults.borderColor = '#1c2835';
  const common = { responsive: true, maintainAspectRatio: false, animation: state.reduceMotion ? false : { duration: 450 }, interaction: { mode: 'index', intersect: false }, plugins: { legend: { display: false }, tooltip: { backgroundColor: '#08101bea', borderColor: '#2c4055', borderWidth: 1, padding: 11, titleColor: '#e3edf8', bodyColor: '#c5d3e3' } } };
  state.charts.prediction = new Chart($('prediction-chart'), {
    type: 'line', data: { labels: [], datasets: [{ label: 'Índice compuesto (0–100)', data: [], borderColor: '#38bdf8', backgroundColor: '#1372c322', borderWidth: 1.8, fill: true, tension: .3, pointRadius: 2, pointHoverRadius: 5, spanGaps: false }] },
    options: { ...common, scales: { x: { grid: { display: false }, border: { display: false }, ticks: { color: '#8298af', font: { size: 9 }, maxTicksLimit: 4 } }, y: { display: false, min: 0, max: 100 } }, plugins: { ...common.plugins, tooltip: { ...common.plugins.tooltip, callbacks: { label: context => `${formatNumber(context.parsed.y)} / 100 · no es probabilidad` } } } }
  });
  state.charts.conditions = new Chart($('conditions-chart'), {
    type: 'line', data: { labels: [], datasets: [
      { label: 'Temperatura', data: [], borderColor: '#ff4355', yAxisID: 'temperature', unit: '°C' },
      { label: 'Humedad', data: [], borderColor: '#289eff', yAxisID: 'percentage', unit: '%' },
      { label: 'Índice compuesto', data: [], borderColor: '#f6c942', yAxisID: 'percentage', unit: '/ 100' }
    ].map(dataset => ({ ...dataset, borderWidth: 1.8, tension: .3, pointRadius: 0, pointHoverRadius: 4, spanGaps: false })) },
    options: { ...common, scales: {
      x: { grid: { display: false }, ticks: { font: { size: 9 }, maxTicksLimit: 4, maxRotation: 0 } },
      percentage: { position: 'left', min: 0, max: 100, title: { display: true, text: 'RH % · Índice / 100', font: { size: 8 } }, ticks: { stepSize: 50, font: { size: 9 } }, grid: { color: '#17232e' } },
      temperature: { position: 'right', suggestedMin: 0, suggestedMax: 45, ticks: { font: { size: 9 }, maxTicksLimit: 4, callback: value => `${value}°` }, grid: { drawOnChartArea: false } }
    }, plugins: { ...common.plugins, tooltip: { ...common.plugins.tooltip, callbacks: { title: items => `${items[0]?.label || ''} UTC`, label: context => `${context.dataset.label}: ${formatNumber(context.parsed.y)} ${context.dataset.unit}` } } } }
  });
}

function weatherAtHour(weather, targetMs) {
  const hourly = weather.hourly;
  if (!hourly?.time?.length) return null;
  const target = targetMs / 1000;
  let right = hourly.time.findIndex(time => time >= target);
  if (right < 0) return null;
  const left = hourly.time[right] === target ? right : right - 1;
  if (left < 0) return null;
  const gap = hourly.time[right] - hourly.time[left];
  const fraction = gap ? (target - hourly.time[left]) / gap : 0;
  const result = {};
  for (const key of ['temperature_2m', 'relative_humidity_2m', 'wind_speed_10m']) {
    const a = hourly[key]?.[left];
    const b = hourly[key]?.[right];
    if (!finite(a) || !finite(b)) return null;
    result[key] = a + (b - a) * fraction;
  }
  return result;
}

function buildForecast(weather, proximity) {
  const current = weather.current;
  const make = conditions => {
    const science = calcularRiesgoCientifico(conditions.temperature_2m, conditions.relative_humidity_2m, conditions.wind_speed_10m, conditions.wind_direction_10m, proximity);
    return { time: conditions.time * 1000, temperature: conditions.temperature_2m ?? null, humidity: conditions.relative_humidity_2m ?? null, wind: conditions.wind_speed_10m ?? null, direction: conditions.wind_direction_10m ?? null, risk: science.index, vpd: science.vpd, science };
  };
  const future = (weather.hourly?.time || []).map((time, index) => ({ time, index })).filter(item => item.time > current.time).slice(0, 6);
  return [make(current), ...future.map(({ time, index }) => make({ time, temperature_2m: weather.hourly.temperature_2m?.[index], relative_humidity_2m: weather.hourly.relative_humidity_2m?.[index], wind_speed_10m: weather.hourly.wind_speed_10m?.[index], wind_direction_10m: weather.hourly.wind_direction_10m?.[index] }))];
}

function updateCharts(forecast) {
  if (state.charts.prediction) {
    state.charts.prediction.data.labels = forecast.map((item, index) => index === 0 ? 'Ahora' : hourUTC(item.time));
    state.charts.prediction.data.datasets[0].label = 'Índice compuesto (0–100)';
    state.charts.prediction.data.datasets[0].data = forecast.map(item => item.risk);
    state.charts.prediction.options.scales.y.max = 100;
    state.charts.prediction.options.plugins.tooltip.callbacks.label = context => `${formatNumber(context.parsed.y)} / 100 · no es probabilidad`;
    state.charts.prediction.update();
  }
  if (state.charts.conditions) {
    state.charts.conditions.data.labels = forecast.map(item => hourUTC(item.time));
    ['temperature', 'humidity', 'risk'].forEach((key, index) => { state.charts.conditions.data.datasets[index].data = forecast.map(item => item[key]); });
    state.charts.conditions.update();
  }
}

function resetLocationData() {
  state.science = null;
  state.forecast = [];
  state.place = null;
  $('physical-vpd').textContent = '— kPa';
  $('physical-ffwi').textContent = '— / 100';
  $('physical-frp').textContent = '— MW';
  $('physical-wind').textContent = '—';
  $('place-info').textContent = 'Municipio: consultando cartografía…';
  $('wind-legend').hidden = true;
  if (state.globe) state.globe.pathsData([]);
  ['temperature', 'humidity', 'wind'].forEach(id => { $(id).textContent = '—'; });
  $('risk-alert').dataset.level = 'unknown';
  $('risk-eyebrow').textContent = 'ANÁLISIS DE RIESGO';
  $('risk-title').textContent = 'Consultando condiciones';
  $('risk-description').textContent = 'Esperando datos de esta ubicación';
  $('prediction-text').textContent = 'Esperando pronóstico horario…';
  $('nearby-info').textContent = 'Calculando distancia a las detecciones del CSV…';
  updateCharts([]);
  renderAssistantContext();
  renderForecastTable();
  updateGlobalRisk();
}

async function selectLocation(locationData, { refresh = false, fly = true, patrol = false } = {}) {
  const lat = number(locationData.lat);
  const lng = number(locationData.lng);
  if (!validCoordinates(lat, lng)) { notify('Coordenadas inválidas: latitud −90…90 y longitud −180…180.', 'error'); return; }
  if (!patrol) stopPatrol();
  const request = ++state.weatherRequest;
  state.weatherAbort?.abort();
  state.weatherAbort = new AbortController();
  state.selected = { lat, lng, name: String(locationData.name || 'Ubicación seleccionada').slice(0, 160), fireId: locationData.fireId ?? null };
  state.weather = null;
  state.weatherError = '';
  state.weatherLoading = true;
  state.proximity = state.csvReady ? analizarCercania(lat, lng, state.fires) : null;
  $('location-name').textContent = state.selected.name;
  $('location-coords').textContent = coordinates(state.selected);
  $('map-coordinates').textContent = `${lat.toFixed(4)}°, ${lng.toFixed(4)}°`;
  $('search-results').hidden = true;
  resetLocationData();
  if (!patrol) scheduleReverse(state.selected, request);
  else {
    const place = state.reverseCache.get(locationKey(state.selected));
    if (place) { state.place = place; state.selected.name = place.name; $('location-name').textContent = place.name; $('place-info').textContent = `${place.name} · ${formatNumber(place.distance)} km al objeto cartográfico (caché).`; }
    else $('place-info').textContent = 'Patrullaje: coordenadas reales. Geocodificación disponible al seleccionar manualmente.';
  }
  $('weather-status').textContent = 'Consultando Open-Meteo…';
  $('refresh-weather').disabled = true;
  if (state.globe && fly) {
    state.globe.controls().autoRotate = false;
    $('rotate-globe').setAttribute('aria-pressed', 'false');
    state.globe.pointOfView({ lat, lng, altitude: 1.35 }, state.reduceMotion ? 0 : 1800);
  }
  renderGlobeData();
  updateSystemStatus();
  try {
    const key = locationKey(state.selected);
    const cached = state.cache.get(key);
    let weather;
    let fetchedAt;
    if (!refresh && cached && Date.now() - cached.fetchedAt < CONFIG.cacheMs) {
      weather = cached.data; fetchedAt = cached.fetchedAt;
    } else {
      const params = new URLSearchParams({ latitude: String(lat), longitude: String(lng), current: 'temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,precipitation', hourly: 'temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m', forecast_days: '1', forecast_hours: '14', past_hours: '1', timezone: 'GMT', timeformat: 'unixtime', temperature_unit: 'celsius', wind_speed_unit: 'kmh', precipitation_unit: 'mm', cell_selection: 'nearest' });
      weather = JSON.parse(await fetchWithTimeout(`${CONFIG.weather}?${params}`, { signal: state.weatherAbort.signal }));
      if (weather.error) throw new Error(weather.reason || 'La API no devolvió datos.');
      const current = weather.current;
      if (!current || ![current.time, current.temperature_2m, current.relative_humidity_2m, current.wind_speed_10m].every(finite) || current.relative_humidity_2m < 0 || current.relative_humidity_2m > 100 || current.wind_speed_10m < 0) throw new Error('Condiciones meteorológicas incompletas en esta ubicación.');
      fetchedAt = Date.now();
      state.cache.set(key, { data: weather, fetchedAt });
      if (state.cache.size > 60) state.cache.delete(state.cache.keys().next().value);
    }
    if (request !== state.weatherRequest) return;
    state.weather = weather;
    state.latestFetch = fetchedAt;
    $('temperature').textContent = `${formatNumber(weather.current.temperature_2m)}°C`;
    $('humidity').textContent = `${formatNumber(weather.current.relative_humidity_2m, 0)}%`;
    $('wind').textContent = `${formatNumber(weather.current.wind_speed_10m, 0)} km/h`;
    $('weather-status').textContent = `Modelo Open-Meteo · ${dateUTC(weather.current.time * 1000)}`;
    renderAnalysis();
    state.history.unshift({ ...state.selected, time: Date.now(), weatherTime: weather.current.time * 1000, science: { ...state.science }, csvRange: state.csvRange, rows: state.stats?.rawCount, model: RISK_MODEL.name });
    state.history = state.history.slice(0, 100);
    renderHistoryView();
    renderGlobeData();
    updateClock();
  } catch (error) {
    if (request !== state.weatherRequest) return;
    console.error('Open-Meteo:', error);
    state.weatherError = error.name === 'AbortError' ? 'Tiempo de espera agotado. Inténtalo de nuevo.' : error.message;
    $('weather-status').textContent = `Sin clima disponible: ${state.weatherError}`;
    $('risk-title').textContent = 'Datos no disponibles';
    $('risk-description').textContent = 'No se puede calcular el índice sin clima real.';
    $('prediction-text').textContent = 'Sin pronóstico disponible para esta ubicación.';
    $('nearby-info').textContent = state.proximity ? `${state.proximity.nearby} detecciones a menos de ${CONFIG.nearbyKm} km.` : 'NASA FIRMS todavía no está disponible.';
    renderAssistantContext();
    if (!patrol) notify(`Open-Meteo: ${state.weatherError}`, 'error');
  } finally {
    if (request === state.weatherRequest) { state.weatherLoading = false; $('refresh-weather').disabled = false; updateSystemStatus(); }
  }
}

function renderAnalysis() {
  if (!state.weather) return;
  state.forecast = buildForecast(state.weather, state.proximity);
  state.science = state.forecast[0].science;
  const risk = state.forecast[0].risk;
  const level = riskLevel(risk);
  $('risk-alert').dataset.level = level.key;
  $('risk-eyebrow').textContent = 'ÍNDICE COMPUESTO · FFWI + VPD + FIRMS';
  $('risk-title').textContent = finite(risk) ? `${level.label} · ${formatNumber(risk)} / 100` : 'Esperando datos completos';
  $('risk-description').textContent = state.science.reason;
  $('physical-vpd').textContent = `${formatNumber(state.science.vpd, 2)} kPa`;
  $('physical-ffwi').textContent = `${formatNumber(state.science.ffwi)} / 100`;
  $('physical-frp').textContent = `${formatNumber(state.science.frp, 2)} MW`;
  $('physical-wind').textContent = `${formatNumber(state.science.wind)} km/h · ${formatNumber(state.science.direction, 0)}°`;
  const future = state.forecast[6];
  if (finite(risk) && finite(future?.risk)) {
    const delta = future.risk - risk;
    $('prediction-text').textContent = `Índice: ${formatNumber(risk)} → ${formatNumber(future.risk)} / 100. ${Math.abs(delta) < .05 ? 'Se mantiene estable' : `${delta > 0 ? 'Aumenta' : 'Disminuye'} ${formatNumber(Math.abs(delta))} puntos`} a las ${hourUTC(future.time)} UTC. FIRMS fijo; no predice el frente del fuego.`;
  } else $('prediction-text').textContent = 'No hay seis registros horarios completos. No se inventan valores.';
  if (state.proximity) $('nearby-info').textContent = `${state.proximity.nearby} detecciones a ≤150 km · más cercana: ${formatNumber(state.proximity.nearestKm)} km. ${state.proximity.missingFrp} sin FRP. Σ del archivo, no potencia simultánea. CSV: ${state.csvRange}.`;
  updateCharts(state.forecast);
  const key = locationKey(state.selected);
  state.observations.delete(key);
  state.observations.set(key, { location: { ...state.selected }, weather: state.weather, risk, fetchedAt: state.latestFetch, csvVersion: state.csvVersion });
  if (state.observations.size > 40) state.observations.delete(state.observations.keys().next().value);
  updateGlobalRisk();
  renderForecastTable();
  renderWindVectors();
  renderAssistantContext();
  updateSimulator();
}

function updateGlobalRisk() {
  const risk = state.science?.index ?? null;
  const level = riskLevel(risk);
  $('global-risk').textContent = finite(risk) ? formatNumber(risk, 1) : '—';
  $('global-risk').style.color = level.color;
  $('global-risk-label').textContent = finite(risk) ? level.label : 'ESPERANDO DATOS';
  $('global-risk-label').style.color = level.color;
  $('global-scope').textContent = 'Índice local 0–100: FFWI 65% + VPD 20% + evidencia FIRMS 15%. No es probabilidad de ignición.';
  document.querySelector('.gauge-panel').dataset.level = level.key;
  const marker = $('gauge-marker');
  marker.setAttribute('visibility', finite(risk) ? 'visible' : 'hidden');
  if (finite(risk)) {
    const angle = Math.PI * (1 - risk / 100);
    marker.setAttribute('cx', String(120 + 90 * Math.cos(angle)));
    marker.setAttribute('cy', String(120 - 90 * Math.sin(angle)));
  }
}

async function searchLocation(event) {
  event.preventDefault();
  const query = $('search-input').value.trim();
  const request = ++state.searchRequest;
  state.searchAbort?.abort();
  state.searchAbort = new AbortController();
  $('search-submit').disabled = false;
  if (!query) { $('search-results').hidden = true; return; }
  const match = query.match(/^\s*(-?\d+(?:\.\d+)?)\s*[,;]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (match) { selectLocation({ lat: Number(match[1]), lng: Number(match[2]), name: 'Coordenadas consultadas' }); return; }
  if (query.length < 2) { notify('Escribe al menos dos caracteres o coordenadas como −3.4653, −62.2159.'); return; }
  $('search-results').hidden = false;
  $('search-results').innerHTML = '<p>Buscando ubicaciones…</p>';
  $('search-submit').disabled = true;
  try {
    const params = new URLSearchParams({ name: query, count: '6', language: 'es', format: 'json' });
    const data = JSON.parse(await fetchWithTimeout(`${CONFIG.geocoding}?${params}`, { signal: state.searchAbort.signal }));
    if (request !== state.searchRequest) return;
    if (data.error) throw new Error(data.reason || 'Error de geocodificación.');
    $('search-results').replaceChildren();
    const results = (data.results || []).filter(item => validCoordinates(item.latitude, item.longitude));
    if (!results.length) { $('search-results').innerHTML = '<p>No se encontraron coincidencias. Prueba una ciudad o latitud, longitud.</p>'; return; }
    for (const result of results) {
      const button = document.createElement('button');
      button.type = 'button';
      const name = [result.name, result.country].filter(Boolean).join(', ');
      button.innerHTML = `${escapeHTML(name)}<small>${escapeHTML(result.admin1 || '')} · ${result.latitude.toFixed(4)}, ${result.longitude.toFixed(4)}</small>`;
      button.addEventListener('click', () => { $('search-input').value = name; selectLocation({ lat: result.latitude, lng: result.longitude, name }); });
      $('search-results').append(button);
    }
  } catch (error) {
    if (request !== state.searchRequest) return;
    $('search-results').innerHTML = `<p>${escapeHTML(error.name === 'AbortError' ? 'La búsqueda agotó el tiempo de espera.' : error.message)}</p>`;
  } finally { if (request === state.searchRequest) $('search-submit').disabled = false; }
}

function openDialog(title, content = '') {
  $('dialog-title').textContent = title;
  $('dialog-content').innerHTML = content;
  if (!$('detail-dialog').open) $('detail-dialog').showModal();
}

function showMethodology() {
  openDialog('Metodología científica y límites', methodologyHTML());
}

function showAllAlerts() {
  openDialog('NASA FIRMS · detecciones de mayor intensidad', `<p>${state.topFires.length.toLocaleString('es')} puntos visibles de ${state.fires.length.toLocaleString('es')} detecciones válidas. Fechas de adquisición: ${escapeHTML(state.csvRange || 'pendientes')}. Lista de los 100 focos más intensos; no constituye un flujo de alertas en vivo.</p><div class="dialog-alerts" id="dialog-alert-list"></div>`);
  renderAlerts($('dialog-alert-list'), 100);
}

function showHistory() {
  openDialog('Historial de consultas · esta sesión');
  if (!state.history.length) { $('dialog-content').innerHTML = '<p>Aún no hay consultas meteorológicas completadas.</p>'; return; }
  for (const entry of state.history) {
    const button = document.createElement('button');
    button.className = 'history-item';
    button.innerHTML = `${escapeHTML(entry.name)}<small>${coordinates(entry)} · consultado ${dateUTC(entry.time)}</small>`;
    button.addEventListener('click', () => { $('detail-dialog').close(); selectLocation(entry); });
    $('dialog-content').append(button);
  }
}

function showSettings() {
  openDialog('Configuración del centro de control', `<p>Sin cuentas ni claves API. Las consultas y el historial permanecen únicamente en la memoria de esta pestaña.</p><label class="settings-row"><span>Reducir movimiento y desactivar pulsos</span><input id="reduce-motion" class="switch" type="checkbox" ${state.reduceMotion ? 'checked' : ''}></label><p class="micro">Las detecciones no se descargan de NASA automáticamente. Sustituye incendios_nasa.csv por tu archivo actualizado y pulsa recargar.</p><div class="dialog-actions"><button id="reload-csv" class="action-button">Recargar CSV local</button><button id="clear-history" class="action-button">Vaciar historial y muestra global</button></div>`);
  $('reduce-motion').addEventListener('change', event => {
    state.reduceMotion = event.target.checked;
    state.pulse = 1;
    if (state.globe) {
      state.globe.pointsTransitionDuration(state.reduceMotion ? 0 : 850);
      state.globe.controls().autoRotate = false;
      $('rotate-globe').setAttribute('aria-pressed', 'false');
    }
    renderGlobeData();
  });
  $('reload-csv').addEventListener('click', () => { $('detail-dialog').close(); loadFires(); });
  $('clear-history').addEventListener('click', () => { state.history = []; state.observations.clear(); state.cache.clear(); renderHistoryView(); updateGlobalRisk(); renderGlobeData(); notify('Historial, caché y muestra de ubicaciones eliminados.'); });
}

function bindEvents() {
  $('search-form').addEventListener('submit', searchLocation);
  $('search-input').addEventListener('input', () => { state.searchRequest++; state.searchAbort?.abort(); $('search-submit').disabled = false; $('search-results').hidden = true; });
  $('search-input').addEventListener('keydown', event => { if (event.key === 'Escape') $('search-results').hidden = true; if (event.key === 'ArrowDown') { const first = $('search-results').querySelector('button'); if (first && !$('search-results').hidden) { event.preventDefault(); first.focus(); } } });
  document.addEventListener('click', event => { if (!event.target.closest('.search-panel')) $('search-results').hidden = true; });
  $('refresh-weather').addEventListener('click', () => selectLocation(state.selected, { refresh: true, fly: false }));
  for (const name of Object.keys(state.layers)) $('layer-' + name).addEventListener('change', event => setLayer(name, event.target.checked));
  $('layer-opacity').addEventListener('input', event => {
    const opacity = Number(event.target.value);
    state.opacity = opacity / 100;
    $('opacity-value').value = `${opacity}%`;
    event.target.style.background = `linear-gradient(to right,var(--green) ${opacity}%,#26303e ${opacity}%)`;
    if (state.globe) state.globe.pointColor(point => pointColor(point));
    renderGlobeData();
  });
  $('layers-toggle').addEventListener('click', () => {
    const expanded = $('layers-toggle').getAttribute('aria-expanded') === 'true';
    $('layers-toggle').setAttribute('aria-expanded', String(!expanded));
    $('layers-content').hidden = expanded;
  });
  $('home-view').addEventListener('click', () => { if (state.rankedFrp.length) selectLocation(fireLocation(state.rankedFrp[0])); });
  $('rotate-globe').addEventListener('click', () => {
    if (!state.globe) return;
    if (state.reduceMotion) { notify('La rotación está desactivada por la preferencia de movimiento reducido.'); return; }
    const enabled = !state.globe.controls().autoRotate;
    state.globe.controls().autoRotate = enabled;
    $('rotate-globe').setAttribute('aria-pressed', String(enabled));
  });
  $('locate-me').addEventListener('click', () => {
    if (!navigator.geolocation) { notify('La geolocalización no está disponible en este navegador.', 'error'); return; }
    notify('Esperando permiso de ubicación del navegador…');
    navigator.geolocation.getCurrentPosition(position => selectLocation({ lat: position.coords.latitude, lng: position.coords.longitude, name: 'Mi ubicación' }), error => {
      if (error.code === 3) { $('toast').hidden = true; return; }
      notify('Ubicación no disponible. Puedes buscar coordenadas o seleccionar un foco.');
    }, { timeout: 15000, maximumAge: 60000 });
  });
  $('fullscreen').addEventListener('click', async () => {
    try { if (document.fullscreenElement) await document.exitFullscreen(); else if ($('globe-scene').requestFullscreen) await $('globe-scene').requestFullscreen(); else notify('Pantalla completa no disponible en este navegador.'); }
    catch { notify('El navegador no permitió activar pantalla completa.', 'error'); }
  });
  for (const [id, factor] of [['zoom-in', .8], ['zoom-out', 1.25]]) $(id).addEventListener('click', () => {
    if (!state.globe) return;
    const view = state.globe.pointOfView();
    state.globe.pointOfView({ ...view, altitude: clamp(view.altitude * factor, .18, 5) }, state.reduceMotion ? 0 : 350);
  });
  $('all-alerts').addEventListener('click', () => navigate('alertas'));
  $('method-button').addEventListener('click', showMethodology);
  $('about-button').addEventListener('click', () => openDialog('ORBITAL GUARDIAN · NASA Space Apps', '<p>Sistema Global Inteligente de Riesgos. Prototipo de exploración geoespacial con NASA FIRMS, NASA Visible Earth y Open-Meteo.</p><p>Desarrollado para un futuro más seguro. Este proyecto no está afiliado ni certificado por NASA. Las estimaciones son experimentales y no sustituyen información oficial de emergencias.</p>'));
  $('close-dialog').addEventListener('click', () => $('detail-dialog').close());
  $('detail-dialog').addEventListener('click', event => { const bounds = event.currentTarget.getBoundingClientRect(); if (event.target === event.currentTarget && (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)) event.currentTarget.close(); });
  document.querySelectorAll('[data-view]').forEach(button => button.addEventListener('click', () => navigate(button.dataset.view)));
  window.addEventListener('online', updateSystemStatus);
  window.addEventListener('offline', () => { updateSystemStatus(); notify('Sin conexión. Los datos ya cargados siguen disponibles; no se actualizarán.', 'error'); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) stopPatrol(); if (state.globe) { if (document.hidden || state.view !== 'explorar') state.globe.pauseAnimation(); else state.globe.resumeAnimation(); } });
}

// Navegación por rutas hash: cinco páginas lógicas, una sola instancia WebGL.
function navigate(view, push = true) {
  if (!['explorar', 'analisis', 'alertas', 'historial', 'asistente'].includes(view)) view = 'explorar';
  const changed = state.view !== view;
  state.view = view;
  for (const page of document.querySelectorAll('.app-view')) page.hidden = page.id !== `view-${view}`;
  const activePage = $(`view-${view}`);
  activePage.getAnimations?.().forEach(animation => animation.cancel());
  if (changed && !state.reduceMotion && activePage.animate) activePage.animate([
    { opacity: 0, transform: 'translateY(10px)' },
    { opacity: 1, transform: 'translateY(0)' }
  ], { duration: 360, easing: 'cubic-bezier(.22,1,.36,1)' });
  for (const button of document.querySelectorAll('[data-view]')) {
    button.classList.toggle('active', button.dataset.view === view);
    if (button.dataset.view === view) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  }
  if (push && location.hash !== `#${view}`) history.pushState(null, '', `#${view}`);
  if (view !== 'explorar') stopPatrol();
  if (state.globe) {
    if (view === 'explorar') { state.globe.resumeAnimation(); requestAnimationFrame(() => state.globe.width($('globe').clientWidth).height($('globe').clientHeight)); }
    else state.globe.pauseAnimation();
  }
  if (view === 'analisis') { state.charts.continents?.resize(); updateSimulator(); }
  if (view === 'historial') renderHistoryView();
  if (view === 'asistente') renderAssistantContext();
  document.title = `${view.charAt(0).toUpperCase() + view.slice(1)} · ORBITAL GUARDIAN`;
  if (push) document.querySelector(`#view-${view} h1`)?.focus({ preventScroll: true });
}

function stopPatrol() {
  clearInterval(state.patrolTimer);
  state.patrolTimer = null;
  $('patrol-button').setAttribute('aria-pressed', 'false');
  $('patrol-button').textContent = '◎ Patrullaje Orbital';
}

function togglePatrol() {
  if (state.patrolTimer) { stopPatrol(); return; }
  if (!state.rankedFrp.length) { notify('Patrullaje pendiente: no hay detecciones con FRP válido.'); return; }
  if (state.reduceMotion) { notify('Desactiva «reducir movimiento» en configuración para iniciar el patrullaje.'); return; }
  state.patrolIndex = 0;
  const visit = () => {
    const top = state.rankedFrp.slice(0, 5);
    const index = state.patrolIndex++ % top.length;
    $('patrol-button').textContent = `■ Detener patrullaje · ${index + 1}/${top.length}`;
    selectLocation(fireLocation(top[index]), { patrol: true });
  };
  $('patrol-button').setAttribute('aria-pressed', 'true');
  visit();
  state.patrolTimer = setInterval(visit, 6000);
}

// Nominatim público: consultas individuales, caché y cola serial ≤1 solicitud/s.
// No se geocodifica el CSV en bloque ni se usa para autocompletado.
function scheduleReverse(loc, request) {
  clearTimeout(state.reverseTimer);
  state.reverseTimer = setTimeout(() => {
    state.reverseQueue = state.reverseQueue.catch(() => {}).then(async () => {
      if (request !== state.weatherRequest) return;
      const key = locationKey(loc);
      try {
        let place = state.reverseCache.get(key);
        if (!place) {
          await new Promise(resolve => setTimeout(resolve, Math.max(0, 1100 - (Date.now() - state.reverseLast))));
          if (request !== state.weatherRequest) return;
          state.reverseLast = Date.now();
          const query = new URLSearchParams({ lat: String(loc.lat), lon: String(loc.lng), format: 'jsonv2', zoom: '12', addressdetails: '1', 'accept-language': 'es' });
          const data = JSON.parse(await fetchWithTimeout(`${CONFIG.reverse}?${query}`, {}, 12000));
          if (data.error) throw new Error(data.error);
          const address = data.address || {};
          const municipality = address.city || address.town || address.village || address.municipality || address.county || data.name;
          const name = [municipality, address.country].filter(Boolean).join(', ');
          if (!name) throw new Error('Sin municipio cartografiado');
          const point = { lat: number(data.lat), lng: number(data.lon) };
          place = { name, distance: validCoordinates(point.lat, point.lng) ? distanciaKm(loc.lat, loc.lng, point.lat, point.lng) : null, display: data.display_name || name };
          state.reverseCache.set(key, place);
          if (state.reverseCache.size > 200) state.reverseCache.delete(state.reverseCache.keys().next().value);
        }
        if (request !== state.weatherRequest) return;
        state.place = place;
        state.selected.name = place.name;
        $('location-name').textContent = place.name;
        $('place-info').textContent = `${place.name} · ${formatNumber(place.distance)} km al punto cartográfico devuelto. No garantiza el asentamiento más cercano.`;
        renderGlobeData();
        renderWindVectors();
        renderAssistantContext();
      } catch {
        if (request === state.weatherRequest) $('place-info').textContent = 'Municipio no disponible. Se conservan las coordenadas; no se infiere un nombre.';
      }
    });
  }, 400);
}

function destination(lat, lng, bearing, km) {
  const rad = Math.PI / 180;
  const phi = lat * rad, lambda = lng * rad, theta = bearing * rad, delta = km / 6371.0088;
  const nextPhi = Math.asin(clamp(Math.sin(phi) * Math.cos(delta) + Math.cos(phi) * Math.sin(delta) * Math.cos(theta), -1, 1));
  const nextLambda = lambda + Math.atan2(Math.sin(theta) * Math.sin(delta) * Math.cos(phi), Math.cos(delta) - Math.sin(phi) * Math.sin(nextPhi));
  return { lat: nextPhi / rad, lng: ((nextLambda / rad + 540) % 360) - 180 };
}

function renderWindVectors() {
  if (!state.globe) return;
  const science = state.science;
  if (!science || !finite(science.wind) || !finite(science.downwind) || science.wind === 0) {
    state.globe.pathsData([]); $('wind-legend').hidden = true; return;
  }
  const start = state.selected;
  const paths = [6, 12].map(hours => ({ hours, color: hours === 6 ? '#49d7ff' : '#f8c65a', points: Array.from({ length: 41 }, (_, index) => ({ ...destination(start.lat, start.lng, science.downwind, science.wind * hours * index / 40), altitude: .013 + .02 * Math.sin(Math.PI * index / 40) })) }));
  // Flechas, no conos: la dispersión angular y la velocidad del fuego son desconocidas.
  for (const hours of [6, 12]) {
    const end = destination(start.lat, start.lng, science.downwind, science.wind * hours);
    for (const angle of [-150, 150]) paths.push({ hours, color: hours === 6 ? '#49d7ff' : '#f8c65a', points: [end, destination(end.lat, end.lng, science.downwind + angle, Math.min(25, science.wind * hours * .12))].map(point => ({ ...point, altitude: .014 })) });
  }
  state.globe.pathPoints('points').pathPointLat('lat').pathPointLng('lng').pathPointAlt('altitude').pathColor('color').pathStroke(.12).pathTransitionDuration(0).pathLabel(path => `<div class="globe-tooltip">${path.hours} h · ${formatNumber(science.wind * path.hours)} km<small>Advección hipotética a viento constante; NO avance del fuego.</small></div>`).pathsData(paths);
  $('wind-legend').hidden = false;
  $('wind-legend').textContent = `Hacia ${formatNumber(science.downwind, 0)}° · 6 h: ${formatNumber(science.wind * 6)} km / 12 h: ${formatNumber(science.wind * 12)} km · transporte hipotético, NO incendio`;
}

function datasetStatistics(fires, rawCount, skipped) {
  const brightness = fires.filter(fire => finite(fire.brightness));
  const frps = fires.filter(fire => finite(fire.frp));
  return { rawCount, validCount: fires.length, skipped, brightnessCount: brightness.length, meanBrightness: brightness.length ? brightness.reduce((sum, fire) => sum + fire.brightness, 0) / brightness.length : null, maxFrp: frps.length ? frps.reduce((max, fire) => Math.max(max, fire.frp), 0) : null, frpCount: frps.length, loaded: Date.now(), continents: null };
}

function renderDataset() {
  const stats = state.stats;
  if (!stats) return;
  $('dataset-stats').innerHTML = [
    ['Filas en archivo', stats.rawCount.toLocaleString('es'), `${stats.validCount.toLocaleString('es')} válidas · ${stats.skipped} omitidas/duplicadas`],
    ['Brillo promedio', `${formatNumber(stats.meanBrightness, 2)} K`, `N = ${stats.brightnessCount.toLocaleString('es')} valores válidos`],
    ['FRP máximo', `${formatNumber(stats.maxFrp, 2)} MW`, `N = ${stats.frpCount.toLocaleString('es')} valores válidos`],
    ['Ventana de captura', state.csvRange, 'UTC · no constituye actividad confirmada ahora']
  ].map(([label, value, note]) => `<article class="panel stat-card"><span>${label}</span><strong>${value}</strong><small>${note}</small></article>`).join('');
  $('dataset-provenance').innerHTML = `<p>${stats.rawCount.toLocaleString('es')} filas físicas de datos; ${stats.validCount.toLocaleString('es')} detecciones válidas tras validación y deduplicación exacta.</p><p>Capturas: ${escapeHTML(state.csvRange)} UTC.<br>Cargado: ${dateUTC(stats.loaded)}.</p><p>Brillo promedio: ${formatNumber(stats.meanBrightness, 2)} K; FRP máximo: ${formatNumber(stats.maxFrp, 2)} MW.</p><p>Conteo leído dinámicamente: no se fija en 13.682 ni en otro número.</p><p class="hash-value">SHA-256 del texto UTF-8 cargado:<br>${state.datasetHash || 'No disponible / calculando'}</p><p>Una fila no equivale a un incendio independiente. La suma de FRP de capturas diferentes no es potencia simultánea.</p>`;
}

function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if (((yi > lat) !== (yj > lat)) && lng < (xj - xi) * (lat - yi) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function pointInPolygon(lng, lat, rings) {
  return !!rings.length && pointInRing(lng, lat, rings[0]) && !rings.slice(1).some(ring => pointInRing(lng, lat, ring));
}

async function loadCountries() {
  try {
    const data = JSON.parse(await fetchWithTimeout(CONFIG.countries, {}, 30000));
    if (!Array.isArray(data.features)) throw new Error('GeoJSON inválido');
    state.countries = data.features.flatMap(feature => {
      const geometry = feature.geometry;
      const continent = feature.properties.CONTINENT || feature.properties.continent;
      const polygons = geometry?.type === 'Polygon' ? [geometry.coordinates] : geometry?.type === 'MultiPolygon' ? geometry.coordinates : [];
      return polygons.map(rings => {
        const coords = rings[0];
        return { rings, continent, minX: Math.min(...coords.map(p => p[0])), maxX: Math.max(...coords.map(p => p[0])), minY: Math.min(...coords.map(p => p[1])), maxY: Math.max(...coords.map(p => p[1])) };
      });
    });
    classifyContinents();
  } catch {
    $('continent-status').textContent = 'Cartografía no disponible: no se inventa la distribución continental.';
  }
}

async function classifyContinents() {
  if (!state.countries || !state.stats) return;
  const version = ++state.continentVersion;
  const fires = state.fires;
  const names = { Africa: 'África', Asia: 'Asia', Europe: 'Europa', 'North America': 'América del Norte', 'South America': 'América del Sur', Oceania: 'Oceanía', Antarctica: 'Antártida', 'Seven seas (open ocean)': 'Sin asignar / océano' };
  const counts = Object.fromEntries(['África', 'Asia', 'Europa', 'América del Norte', 'América del Sur', 'Oceanía', 'Antártida', 'Sin asignar / océano'].map(name => [name, 0]));
  $('continent-status').textContent = 'Clasificando coordenadas con polígonos Natural Earth 1:110m…';
  for (let i = 0; i < fires.length; i++) {
    if (version !== state.continentVersion) return;
    const fire = fires[i];
    const match = state.countries.find(poly => fire.lng >= poly.minX && fire.lng <= poly.maxX && fire.lat >= poly.minY && fire.lat <= poly.maxY && pointInPolygon(fire.lng, fire.lat, poly.rings));
    const name = names[match?.continent] || 'Sin asignar / océano';
    counts[name]++;
    if (i % 500 === 0) await new Promise(resolve => setTimeout(resolve, 0));
  }
  state.stats.continents = counts;
  $('continent-status').textContent = 'Natural Earth v5.1.2 · continente de la entidad cartográfica. Países transcontinentales y costas generalizadas requieren cautela.';
  $('continent-table').innerHTML = Object.entries(counts).map(([name, count]) => `<span>${name}: <strong>${count.toLocaleString('es')}</strong></span>`).join('');
  if (window.Chart) {
    state.charts.continents?.destroy();
    state.charts.continents = new Chart($('continent-chart'), { type: 'bar', data: { labels: Object.keys(counts), datasets: [{ label: 'Detecciones', data: Object.values(counts), backgroundColor: ['#18d48a', '#25a2f5', '#8990ff', '#efb74c', '#eb6f48', '#30c0c5', '#b0bdcf', '#516074'], borderRadius: 4 }] }, options: { responsive: true, maintainAspectRatio: false, indexAxis: 'y', plugins: { legend: { display: false } }, scales: { x: { beginAtZero: true, ticks: { precision: 0 } }, y: { grid: { display: false } } } } });
  }
}

function renderForecastTable() {
  const forecast = state.forecast.slice(1);
  if (!forecast.length) { $('forecast-table').textContent = 'Sin pronóstico para la selección actual.'; return; }
  $('forecast-table').innerHTML = `<table><caption>${escapeHTML(state.selected.name)} · datos horarios del modelo meteorológico · indice no probabilístico</caption><thead><tr><th>UTC</th><th>T °C</th><th>RH %</th><th>Viento km/h</th><th>Origen °</th><th>VPD kPa</th><th>FFWI / 100</th><th>Índice / 100</th></tr></thead><tbody>${forecast.map(item => `<tr><td>${dateUTC(item.time)}</td><td>${formatNumber(item.temperature)}</td><td>${formatNumber(item.humidity, 0)}</td><td>${formatNumber(item.wind)}</td><td>${formatNumber(item.direction, 0)}</td><td>${formatNumber(item.vpd, 3)}</td><td>${formatNumber(item.science.ffwi)}</td><td title="${escapeHTML(item.science.reason)}">${finite(item.risk) ? formatNumber(item.risk) : 'Datos incompletos'}</td></tr>`).join('')}</tbody></table>`;
}

function updateSimulator() {
  const values = {};
  for (const [key, unit] of [['temperature', '°C'], ['humidity', '%'], ['wind', 'km/h'], ['distance', 'km']]) {
    values[key] = Number($(`sim-${key}`).value);
    $(`sim-${key}-value`).value = `${values[key]} ${unit}`;
  }
  const proximity = state.proximity ? { ...state.proximity, nearestKm: values.distance } : null;
  const science = calcularRiesgoCientifico(values.temperature, values.humidity, values.wind, state.science?.direction, proximity);
  $('simulation-output').dataset.level = riskLevel(science.index).key;
  $('simulation-output').innerHTML = `<div><span>VPD calculado</span><strong>${formatNumber(science.vpd, 3)} <small>kPa</small></strong></div><div><span>Índice compuesto</span><strong style="color:${riskLevel(science.index).color}">${finite(science.index) ? `${formatNumber(science.index)} <small>/ 100</small>` : '<small>Esperando CSV / ubicación</small>'}</strong></div><p>FFWI: ${formatNumber(science.ffwi)} / 100 · Σ FRP fijo: ${formatNumber(science.frp, 2)} MW. ${escapeHTML(science.reason)} Cambiar distancia modifica solo la atenuación de evidencia; es sensibilidad, no una nueva ubicación.</p>`;
}

function renderCrisis() {
  $('crisis-summary').textContent = `Orden FRP descendente · ${state.csvRange} UTC · ${state.rankedFrp.length.toLocaleString('es')} registros con FRP válido. Captura satelital ≠ peligro confirmado para población.`;
  $('crisis-list').replaceChildren();
  state.rankedFrp.slice(0, 20).forEach((fire, index) => {
    const card = document.createElement('article'); card.className = 'panel crisis-card';
    card.innerHTML = `<div class="section-heading"><span class="eyebrow">DETECCIÓN ${String(index + 1).padStart(2, '0')}</span><span class="frp-badge">${formatNumber(fire.frp, 2)} MW</span></div><h2>${coordinates(fire)}</h2><dl><div><dt>Captura UTC</dt><dd>${dateUTC(fire.timestamp)}</dd></div><div><dt>Satélite</dt><dd>${escapeHTML(fire.satellite)}</dd></div><div><dt>Confianza (valor original)</dt><dd>${escapeHTML(fire.confidence)}</dd></div><div><dt>Brillo</dt><dd>${formatNumber(fire.brightness, 2)} K</dd></div></dl><div class="dialog-actions"><button class="action-button inspect-fire">Explorar ↗</button><button class="text-button report-fire">Generar reporte técnico / PDF</button></div>`;
    card.querySelector('.inspect-fire').addEventListener('click', () => { navigate('explorar'); selectLocation(fireLocation(fire)); });
    card.querySelector('.report-fire').addEventListener('click', () => showReport(fire));
    $('crisis-list').append(card);
  });
}

function showReport(fire) {
  const context = state.observations.get(locationKey(fire));
  const fresh = context && context.csvVersion === state.csvVersion && Date.now() - context.fetchedAt <= CONFIG.cacheMs;
  const science = fresh ? calcularRiesgoCientifico(context.weather.current.temperature_2m, context.weather.current.relative_humidity_2m, context.weather.current.wind_speed_10m, context.weather.current.wind_direction_10m, analizarCercania(fire.lat, fire.lng, state.fires)) : null;
  const body = `<article class="report-document"><p>ORBITAL GUARDIAN / REPORTE TÉCNICO DE OBSERVACIÓN</p><h1>Detección térmica NASA FIRMS</h1><p><strong>Documento de apoyo no oficial. Requiere verificación por personal competente.</strong></p><dl><dt>Generado UTC</dt><dd>${dateUTC(Date.now())}</dd><dt>Coordenadas</dt><dd>${coordinates(fire)}</dd><dt>Captura original</dt><dd>${escapeHTML(fire.acqDate)} ${escapeHTML(fire.acqTime)} UTC</dd><dt>Potencia radiativa</dt><dd>${formatNumber(fire.frp, 2)} MW</dd><dt>Brillo</dt><dd>${formatNumber(fire.brightness, 2)} K</dd><dt>Satélite / confianza original</dt><dd>${escapeHTML(fire.satellite)} / ${escapeHTML(fire.confidence)}</dd></dl><h2>Condiciones del lugar</h2>${science ? `<p>Modelo Open-Meteo: ${dateUTC(context.weather.current.time * 1000)}. T ${formatNumber(context.weather.current.temperature_2m)} °C; RH ${formatNumber(context.weather.current.relative_humidity_2m)}%; viento ${formatNumber(science.wind)} km/h desde ${formatNumber(science.direction, 0)}°. VPD ${formatNumber(science.vpd, 3)} kPa; Σ FRP a 150 km ${formatNumber(science.frp, 2)} MW.</p><p>Índice compuesto: ${finite(science.index) ? formatNumber(science.index) + ' / 100' : 'datos incompletos'}. FFWI: ${formatNumber(science.ffwi)} / 100. ${escapeHTML(science.reason)}</p>` : '<p>No se han consultado condiciones recientes para estas coordenadas. No se reutiliza el clima de otra ubicación.</p>'}<h2>Procedencia y límites</h2><p>Archivo: incendios_nasa.csv; ${state.stats?.rawCount ?? '—'} filas; capturas ${escapeHTML(state.csvRange)} UTC.</p><p class="hash-value">SHA-256: ${state.datasetHash || 'No disponible'}</p><p>FRP es potencia radiativa estimada en la captura, no energía acumulada ni velocidad de propagación. La anomalía no prueba un incendio forestal ni su actividad actual. No se establecen órdenes de evacuación, rutas seguras ni perímetros operativos.</p><p>Fuentes: NASA FIRMS; Open-Meteo (CC BY 4.0). Métodos: Tetens para VPD y Haversine sobre esfera de radio 6371.0088 km.</p><p>Responsable de revisión: ___________________ Fecha: ___________________</p></article>`;
  $('print-report').innerHTML = body;
  openDialog('Reporte técnico · no oficial', `${body}<div class="dialog-actions"><button id="print-button" class="action-button">Imprimir / Guardar como PDF</button></div>`);
  $('print-button').addEventListener('click', () => { $('detail-dialog').close(); window.print(); });
}

function renderHistoryView() {
  const host = $('session-history');
  host.replaceChildren();
  if (!state.history.length) { host.innerHTML = '<p class="empty-state">Aún no hay consultas completadas en esta sesión.</p>'; return; }
  for (const entry of state.history) {
    const button = document.createElement('button'); button.className = 'history-item';
    button.innerHTML = `<strong>${escapeHTML(entry.name)}</strong><small>${coordinates(entry)} · consulta ${dateUTC(entry.time)}</small><small>Clima ${dateUTC(entry.weatherTime)} · VPD ${formatNumber(entry.science?.vpd, 3)} kPa · Σ FRP ${formatNumber(entry.science?.frp, 2)} MW · ${entry.science?.nearby ?? '—'} detecciones a 150 km</small><small>Dataset: ${entry.rows ?? '—'} filas · ${escapeHTML(entry.csvRange)} · Modelo: ${escapeHTML(entry.model || 'no aportado')}</small>`;
    button.addEventListener('click', () => { navigate('explorar'); selectLocation(entry); });
    host.append(button);
  }
}

function methodologyHTML() {
  return `<h3>1. Presión de vapor y VPD</h3><p><code>SVP = 0.61078 · exp(17.27 · T / (T + 237.3))</code><br><code>VPD = SVP · (1 − RH / 100)</code></p><p>T en °C, RH en %, resultado en kPa. Aproximación de Tetens sobre agua líquida; dominio operativo declarado −40…60 °C (incertidumbre adicional bajo cero). FAO-56 usa 0.6108 redondeado. No es una probabilidad de incendio.</p>
    <h3>2. Distancia y FRP</h3><p>Haversine: <code>a = sin²(Δφ/2) + cos φ₁ cos φ₂ sin²(Δλ/2)</code>; <code>d = 2R atan2(√a, √(1−a))</code>, R = 6371.0088 km. Distancia de gran círculo sobre una esfera; no distancia elipsoidal exacta ni por terreno. Se recorren todas las detecciones válidas y se suman FRP no negativos a ≤150 km.</p><p>NASA FIRMS FRP se expresa en MW: potencia radiativa estimada por píxel de fuego. Σ FRP de este archivo puede sumar observaciones de distintas horas y repetidas pasadas, por lo que NO equivale a potencia simultánea. Se muestran las fechas originales, no se afirma actividad actual.</p>
    <h3>3. Fosberg Fire Weather Index (FFWI)</h3><p><code>TF = 1.8 T + 32; U = viento_kmh / 1.609344</code>. Con humedad relativa h en % y temperatura TF en °F, humedad de equilibrio m:</p><ul><li>h &lt; 10: <code>m = 0.03229 + 0.281073h − 0.000578hTF</code></li><li>10 ≤ h ≤ 50: <code>m = 2.22749 + 0.160107h − 0.01478TF</code></li><li>h &gt; 50: <code>m = 21.0606 + 0.005565h² − 0.00035hTF − 0.483199h</code></li></ul><p>Se limita m a [0,30] para evitar amortiguamiento no físico fuera del rango. <code>η = 1 − 2(m/30) + 1.5(m/30)² − 0.5(m/30)³</code>; <code>FFWI = η √(1 + U²) / 0.3002</code>. El FFWI bruto puede exceder 100: se conserva internamente y se satura a [0,100] para visualización/composición. Viento de entrada: Open-Meteo a 10 m; no se ajusta a nivel de llama. <a href="https://doi.org/10.1071/WF02005" target="_blank" rel="noopener noreferrer">Goodrick (2002), ecuaciones 1–3</a>.</p>
    <h3>4. Índice compuesto propio (no probabilidad)</h3><p><code>I = 0.65 FFWI + 20 clip(VPD/5) + 15 E</code>, <code>E = exp(−d/50) × clip(ln(1+ΣFRP)/ln(1001))</code>. d en km, ΣFRP en MW dentro de 150 km, clip limita a [0,1]. Si no hay detecciones en ese radio, E=0. No tener detecciones no equivale a falta de riesgo. La salida está entre 0 y 100, sin importación JSON.</p><p><strong>Ponderaciones, escalas (5 kPa, 50 km, 1000 MW) y umbrales de color son decisiones de diseño no calibradas.</strong> Verde &lt;40, amarillo 40–70, rojo &gt;70. VPD y FFWI comparten temperatura/humedad: no son evidencias independientes. El compuesto NO es el FFWI publicado ni una probabilidad de ignición. Los datos insuficientes permanecen sin estimación, nunca se convierten en cero. No modela lluvia acumulada, vegetación, combustible ni ignición humana. La antigüedad del CSV se muestra explícitamente; no se confirma actividad actual.</p>
    <h3>5. Viento y pronóstico</h3><p>Dirección meteorológica es el origen del viento. Rumbo de transporte = (dirección + 180) mod 360. Las flechas de 6/12 h usan distancia = velocidad actual × tiempo con rumbo constante. No modelan turbulencia, ascenso del humo, combustible, humedad del combustible, topografía ni avance del fuego; por tanto no se dibuja un cono de peligro ficticio.</p><p>La tabla usa los seis registros horarios futuros de Open-Meteo, incluyendo dirección del viento. No interpola ni rellena valores. La evidencia FIRMS se mantiene fija. Son salidas de modelos meteorológicos, no lecturas satelitales directas.</p>
    <h3>6. Geografía y trazabilidad</h3><p>Nominatim devuelve un objeto cartográfico próximo a las coordenadas; no garantiza el municipio poblado más cercano. La distancia es hasta el punto representativo devuelto. Natural Earth 1:110m asigna el continente de la entidad que contiene el punto; países transcontinentales, fronteras y costas generalizadas pueden afectar el conteo. Los puntos no contenidos quedan sin asignar.</p>
    <h3>Referencias verificables</h3><ul><li><a href="https://www.fao.org/4/x0490e/x0490e07.htm" target="_blank" rel="noopener noreferrer">FAO-56 · parámetros meteorológicos y presión de vapor</a></li><li><a href="https://www.earthdata.nasa.gov/data/tools/firms/faq" target="_blank" rel="noopener noreferrer">NASA FIRMS · preguntas frecuentes y límites</a></li><li><a href="https://open-meteo.com/en/docs" target="_blank" rel="noopener noreferrer">Open-Meteo · variables, unidades y pronóstico</a></li><li><a href="https://nominatim.org/release-docs/latest/api/Reverse/" target="_blank" rel="noopener noreferrer">Nominatim · geocodificación inversa</a></li><li><a href="https://www.naturalearthdata.com/about/terms-of-use/" target="_blank" rel="noopener noreferrer">Natural Earth · datos de dominio público</a></li></ul><p><strong>No usar como orden de evacuación, informe oficial ni sustituto de evaluación de campo.</strong></p>`;
}

function renderAssistantContext() {
  const science = state.science;
  const weather = state.weather?.current;
  $('assistant-context').innerHTML = `<h3>${escapeHTML(state.selected.name)}</h3><p class="mono">${coordinates(state.selected)}</p><dl class="context-metrics"><div><dt>Clima UTC</dt><dd>${weather ? dateUTC(weather.time * 1000) : 'No disponible'}</dd></div><div><dt>Temperatura / RH</dt><dd>${formatNumber(weather?.temperature_2m)} °C / ${formatNumber(weather?.relative_humidity_2m)}%</dd></div><div><dt>VPD</dt><dd>${formatNumber(science?.vpd, 3)} kPa</dd></div><div><dt>Viento desde</dt><dd>${formatNumber(science?.wind)} km/h · ${formatNumber(science?.direction, 0)}°</dd></div><div><dt>Σ FRP a 150 km</dt><dd>${formatNumber(state.proximity?.frpSum, 2)} MW</dd></div><div><dt>Detecciones cercanas</dt><dd>${state.proximity?.nearby ?? '—'}</dd></div><div><dt>Más próxima</dt><dd>${formatNumber(state.proximity?.nearestKm)} km</dd></div></dl><p class="micro muted">CSV: ${escapeHTML(state.csvRange || 'no disponible')}. ${state.stats?.rawCount ?? '—'} filas.</p>`;
}

function expertAnswer(query, snapshot) {
  const { science, weather, location: loc, proximity, forecast, csvRange, rows, place } = snapshot;
  const lines = [`CONTEXTO VERIFICABLE · ${loc.name}`, `Coordenadas: ${coordinates(loc)}. Dataset: ${rows ?? 'no disponible'} filas; capturas ${csvRange || 'no disponibles'} UTC.`];
  if (place) lines.push(`Objeto cartográfico: ${place.name}; ${formatNumber(place.distance)} km al punto representativo (no certifica el asentamiento más próximo).`);
  if (!weather || !science) {
    lines.push('No hay condiciones meteorológicas completas para esta selección. No puedo emitir un análisis físico ni una probabilidad. Selecciona un foco y espera la consulta a Open-Meteo.');
    if (proximity) lines.push(`El CSV sí indica ${proximity.nearby} detecciones en 150 km y Σ FRP ${formatNumber(proximity.frpSum, 2)} MW; su actividad actual no está confirmada.`);
    return lines.join('\n\n');
  }
  lines.push(`Open-Meteo ${dateUTC(weather.time * 1000)}: T = ${formatNumber(weather.temperature_2m)} °C, RH = ${formatNumber(weather.relative_humidity_2m)}%, viento = ${formatNumber(science.wind)} km/h desde ${formatNumber(science.direction, 0)}°.`);
  lines.push(`CÁLCULO FÍSICO\nSVP = 0.61078 × exp(17.27 × T / (T + 237.3)) = ${formatNumber(science.svp, 3)} kPa.\nVPD = SVP × (1 − RH/100) = ${formatNumber(science.vpd, 3)} kPa. Es déficit de presión de vapor, no un porcentaje de riesgo.`);
  lines.push(`EVIDENCIA FIRMS\n${proximity?.nearby ?? 'Sin dato'} detecciones a ≤150 km; distancia mínima ${formatNumber(proximity?.nearestKm)} km; Σ FRP = ${formatNumber(proximity?.frpSum, 2)} MW (${proximity?.missingFrp ?? 'Sin dato'} registros cercanos sin FRP). Suma de capturas del archivo, no potencia instantánea de un único incendio.`);
  const normalized = query.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  if (/evacua|segur|peligro|riesgo/.test(normalized)) lines.push('EVALUACIÓN DE EVACUACIÓN\nEstos datos no permiten ordenar ni descartar una evacuación. Faltan perímetro confirmado, población expuesta, rutas, combustible, topografía y observación local. Consulta las alertas oficiales de tu jurisdicción y, si existe peligro inmediato, los servicios locales de emergencia. Un VPD bajo o ausencia de detecciones no demuestra seguridad.');
  if (/viento|propaga|humo|direccion/.test(normalized)) {
    lines.push(finite(science.downwind) && finite(science.wind) ? `TRANSPORTE HIPOTÉTICO\nEl viento procede de ${formatNumber(science.direction, 0)}° y se dirige hacia ${formatNumber(science.downwind, 0)}°. A velocidad y rumbo constantes: d(6 h) = ${formatNumber(science.wind * 6)} km; d(12 h) = ${formatNumber(science.wind * 12)} km. Estas distancias no son avance del frente de fuego ni trayectoria validada del humo. No existe evidencia para fijar un ancho de cono.` : 'Dirección o velocidad del viento no disponible: no se extrapola el transporte.');
  }
  if (/comunicado|alerta|reporte/.test(normalized)) lines.push(`BORRADOR INFORMATIVO · NO OFICIAL\n«Se identificaron ${proximity?.nearby ?? 'Sin dato'} detecciones térmicas en el archivo NASA FIRMS a 150 km de ${coordinates(loc)}, correspondientes a ${csvRange} UTC. Deben verificarse en terreno y con fuentes oficiales antes de atribuir afectación a comunidades o emitir instrucciones. Este comunicado no confirma un incendio activo ni constituye una orden de evacuación».`);
  if (forecast.length) lines.push(`PRONÓSTICO HORARIO (MODELO, NO OBSERVACIÓN)\n${forecast.slice(1).map(item => `${dateUTC(item.time)} · VPD ${formatNumber(item.vpd, 3)} kPa · viento ${formatNumber(item.wind)} km/h desde ${formatNumber(item.direction, 0)}°`).join('\n')}`);
  lines.push(`ÍNDICE COMPUESTO · ${RISK_MODEL.name}\nFFWI: ${formatNumber(science.ffwi)} / 100. Índice: ${finite(science.index) ? `${formatNumber(science.index)} / 100` : 'datos incompletos'}. ${science.reason}\nPonderaciones de diseño: 65% FFWI + 20% VPD normalizado + 15% evidencia FIRMS. No son coeficientes calibrados ni convierten el índice en una probabilidad.`);
  if (!/evacua|segur|peligro|riesgo|viento|propaga|humo|direccion|comunicado|alerta|reporte|vpd|frp|temperatura|humedad|pronostico|metodo/.test(normalized)) lines.push('ALCANCE DEL MOTOR\nLa pregunta no coincide con una regla especializada. Se ofrece el resumen de evidencia, no una respuesta generativa inventada.');
  lines.push('TRAZABILIDAD\nMotor local de reglas v2; cálculos Tetens/Haversine. Fuentes: NASA FIRMS, Open-Meteo y, cuando responde, Nominatim/OpenStreetMap. Referencias y limitaciones en Historial → Metodología.');
  return lines.join('\n\n');
}

function sendChat(query) {
  if (!query.trim()) return;
  const snapshot = { location: { ...state.selected }, science: state.science ? { ...state.science } : null, weather: state.weather?.current ? { ...state.weather.current } : null, proximity: state.proximity ? { ...state.proximity } : null, forecast: state.forecast.map(item => ({ ...item })), csvRange: state.csvRange, rows: state.stats?.rawCount, place: state.place ? { ...state.place } : null };
  for (const [role, name, text] of [['user', 'OPERADOR', query], ['assistant', 'GUARDIAN · MOTOR EXPERTO LOCAL', expertAnswer(query, snapshot)]]) {
    const article = document.createElement('article'); article.className = `chat-message ${role}`;
    const title = document.createElement('strong'); title.textContent = name;
    const time = document.createElement('time'); time.textContent = dateUTC(Date.now());
    const content = document.createElement('p'); content.textContent = text;
    article.append(title, time, content); $('chat-messages').append(article);
  }
  while ($('chat-messages').children.length > 61) $('chat-messages').firstElementChild.remove();
  $('chat-messages').scrollTop = $('chat-messages').scrollHeight;
  $('chat-input').value = '';
}

function bindMissionEvents() {
  window.addEventListener('popstate', () => navigate(location.hash.slice(1), false));
  window.addEventListener('hashchange', () => navigate(location.hash.slice(1), false));
  $('patrol-button').addEventListener('click', togglePatrol);
  $('reload-dataset').addEventListener('click', () => { stopPatrol(); loadFires(); });
  for (const key of ['temperature', 'humidity', 'wind', 'distance']) $(`sim-${key}`).addEventListener('input', updateSimulator);
  $('sim-use-current').addEventListener('click', () => {
    if (!state.weather) { notify('No hay condiciones consultadas para copiar.'); return; }
    const weather = state.weather.current;
    for (const [key, value] of [['temperature', weather.temperature_2m], ['humidity', weather.relative_humidity_2m], ['wind', weather.wind_speed_10m], ['distance', state.proximity?.nearestKm]]) {
      if (finite(value)) $(`sim-${key}`).value = String(value);
    }
    updateSimulator();
  });
  $('history-clear').addEventListener('click', () => { state.history = []; renderHistoryView(); });
  $('chat-form').addEventListener('submit', event => { event.preventDefault(); sendChat($('chat-input').value.trim()); });
  document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => sendChat(button.dataset.prompt)));
  $('assistant-settings').addEventListener('click', () => {
    showSettings();
    const paragraph = document.createElement('p');
    paragraph.textContent = 'Asistente: motor experto local determinista. No se solicitan claves API ni se envían datos a un LLM. Una integración futura con proveedor externo requiere un backend para custodiar secretos; no se almacenan claves en el navegador.';
    $('dialog-content').prepend(paragraph);
  });
}

function boot() {
  bindEvents();
  bindMissionEvents();
  initializeCharts();
  initializeGlobe();
  updateClock();
  setInterval(updateClock, 1000);
  setInterval(updateGlobalRisk, 60000);
  // La primera ubicación siempre procede del CSV; no se solicita GPS al iniciar.
  loadFires();
  loadCountries();
  navigate(location.hash.slice(1) || 'explorar', false);
  updateSimulator();
  renderAssistantContext();
  $('methodology-sheet').innerHTML = methodologyHTML();
  document.querySelector('.gauge-panel h2').textContent = 'Índice de peligro · 0–100';
  $('prediction-chart').setAttribute('aria-label', 'Índice compuesto de peligro actual y seis registros horarios futuros, escala 0 a 100; no es probabilidad');
  document.querySelector('.chart-legend span:last-child').textContent = 'Índice compuesto / 100';
  $('location-name').textContent = 'Cargando foco de mayor FRP…';
  $('location-coords').textContent = 'Coordenadas pendientes';
  $('map-coordinates').textContent = 'Esperando CSV';
}

// Funciones puras accesibles para pruebas desde la consola, sin modificar estado.
window.OrbitalGuardian = Object.freeze({ calcularFFWI, calcularRiesgoCientifico, RISK_MODEL, distanciaKm, analizarCercania, normalizeFires, parseAcquisition, buildForecast, riskLevel, destination, datasetStatistics, pointInPolygon });
if (!window.ORBITAL_TEST_MODE) boot();