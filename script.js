// RUN ANYWAY — MVP
// - Open-Meteo geocoding (country=CO) + forecast
// - Run score + outfit rules + simple canvas chart
// - Feedback + accuracy history in localStorage
// - Run Mode with timer + Wake Lock (if supported)

const el = (id) => document.getElementById(id);

const state = {
  place: null,        // {name, admin1, lat, lon}
  forecast: null,     // parsed data
  selectedTimeMode: "now",
  wakeLock: null,
  runTimer: null,
  runSeconds: 0
};

const GEO_URL = (q) =>
  `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(q)}&count=10&language=es&format=json&country=CO`;

const WX_URL = (lat, lon) => (
  "https://api.open-meteo.com/v1/forecast" +
  `?latitude=${lat}&longitude=${lon}` +
  "&timezone=America/Bogota" +
  "&hourly=temperature_2m,apparent_temperature,precipitation,precipitation_probability,wind_speed_10m,relative_humidity_2m,pressure_msl,weather_code" +
  "&current=temperature_2m,apparent_temperature,precipitation,precipitation_probability,wind_speed_10m,relative_humidity_2m,pressure_msl,weather_code"
);

// --- Utils ---
function clamp(x, a, b){ return Math.max(a, Math.min(b, x)); }
function fmt(n, d=0){ return Number(n).toFixed(d); }
function nowISO(){ return new Date().toISOString(); }
function niceTime(iso){
  const d = new Date(iso);
  const hh = d.getHours().toString().padStart(2,"0");
  const mm = d.getMinutes().toString().padStart(2,"0");
  return `${hh}:${mm}`;
}
function pickIconFromWeatherCode(code){
  // Minimal set (Open-Meteo weather codes)
  // https://open-meteo.com/en/docs
  if (code === 0) return "☀️";
  if ([1,2].includes(code)) return "🌤️";
  if (code === 3) return "☁️";
  if ([45,48].includes(code)) return "🌫️";
  if ([51,53,55,56,57].includes(code)) return "🌦️";
  if ([61,63,65,66,67].includes(code)) return "🌧️";
  if ([71,73,75,77].includes(code)) return "❄️";
  if ([80,81,82].includes(code)) return "🌧️";
  if ([95,96,99].includes(code)) return "⛈️";
  return "🌡️";
}

// --- Geocoding UI ---
let debounceTimer = null;

function renderSuggestions(items){
  const box = el("suggestions");
  box.innerHTML = "";
  if (!items.length){
    box.classList.add("hidden");
    return;
  }
  items.forEach(p => {
    const btn = document.createElement("button");
    btn.innerHTML = `<div><b>${p.name}</b> <span class="meta">(${p.admin1 || ""})</span></div>
                     <div class="meta">${fmt(p.lat,3)}, ${fmt(p.lon,3)}</div>`;
    btn.onclick = () => {
      state.place = p;
      el("cityInput").value = `${p.name}${p.admin1 ? ", " + p.admin1 : ""}`;
      box.classList.add("hidden");
      refresh();
    };
    box.appendChild(btn);
  });
  box.classList.remove("hidden");
}

async function searchCitiesCO(q){
  if (!q || q.trim().length < 2) return [];
  const res = await fetch(GEO_URL(q.trim()));
  const data = await res.json();
  return (data.results || []).map(r => ({
    name: r.name,
    admin1: r.admin1 || "",
    lat: r.latitude,
    lon: r.longitude
  }));
}

el("cityInput").addEventListener("input", () => {
  clearTimeout(debounceTimer);
  const q = el("cityInput").value;
  debounceTimer = setTimeout(async () => {
    try{
      const items = await searchCitiesCO(q);
      renderSuggestions(items);
    }catch(e){
      renderSuggestions([]);
    }
  }, 180);
});

// close suggestions on outside click
document.addEventListener("click", (e) => {
  const s = el("suggestions");
  const inp = el("cityInput");
  if (!s.contains(e.target) && e.target !== inp) s.classList.add("hidden");
});

// --- Forecast fetch & parse ---
async function fetchForecast(lat, lon){
  const res = await fetch(WX_URL(lat, lon));
  if (!res.ok) throw new Error("Forecast fetch failed");
  return await res.json();
}

function resolveTargetIndex(hourlyTimes){
  const mode = state.selectedTimeMode;
  const now = new Date();
  let target = new Date(now);

  if (mode === "plus1") target.setHours(now.getHours()+1);
  if (mode === "plus2") target.setHours(now.getHours()+2);
  if (mode === "6am") { target.setHours(6,0,0,0); if (target < now) target.setDate(target.getDate()+1); }
  if (mode === "6pm") { target.setHours(18,0,0,0); if (target < now) target.setDate(target.getDate()+1); }

  // find nearest hourly time
  let bestIdx = 0;
  let bestDiff = Infinity;
  for (let i=0;i<hourlyTimes.length;i++){
    const t = new Date(hourlyTimes[i]);
    const diff = Math.abs(t - target);
    if (diff < bestDiff){ bestDiff = diff; bestIdx = i; }
  }
  return bestIdx;
}

function computeRunScore(tFeels, pProb, pMm, wind){
  // Ideal around 18C. Always "go run", score just changes guidance.
  let score = 100;
  score -= Math.abs(tFeels - 18) * 2;
  score -= (pProb || 0) * 0.25;
  score -= clamp((pMm || 0) * 20, 0, 25);
  score -= clamp(Math.max(0, (wind || 0) - 10) * 1.0, 0, 25);
  return clamp(Math.round(score), 0, 100);
}

function statusFromScore(score){
  if (score >= 80) return { label:"Listo. Dale.", color:"var(--accent)" };
  if (score >= 50) return { label:"Dale, con capa.", color:"var(--warn)" };
  return { label:"Dale. Hoy te haces fuerte.", color:"var(--danger)" };
}

function outfitRules({tFeels, pProb, pMm, wind, code}){
  const items = [];

  // Base / top
  if (tFeels >= 24){
    items.push({icon:"👕", title:"Camiseta técnica + shorts", desc:"Hidratación y ritmo suave al inicio."});
  }else if (tFeels >= 18){
    items.push({icon:"👕", title:"Camiseta técnica", desc:"Shorts o tights ligeros."});
  }else if (tFeels >= 12){
    items.push({icon:"🧥", title:"Manga larga ligera", desc:"O camiseta + windbreaker fino."});
  }else if (tFeels >= 7){
    items.push({icon:"🧥", title:"Capa base + chaqueta ligera", desc:"Tights recomendados."});
  }else{
    items.push({icon:"🧤", title:"Capa térmica + guantes/buff", desc:"Mantén el core caliente, arranca suave."});
  }

  // Rain
  if ((pProb >= 40) || (pMm >= 0.2) || [61,63,65,80,81,82,95,96,99].includes(code)){
    items.push({icon:"🌧️", title:"Impermeable liviano + visera", desc:"Grips en suela, evita charcos."});
    if (pMm >= 1.5 || [95,96,99].includes(code)){
      items.push({icon:"✨", title:"Reflectivo", desc:"Visibilidad y seguridad primero."});
    }
  }

  // Wind
  if (wind >= 20) items.push({icon:"💨", title:"Windbreaker", desc:"Corta el viento sin sobrecalentar."});
  if (wind >= 35) items.push({icon:"🧣", title:"Buff", desc:"Protege cuello y respira mejor con ráfagas."});

  // Always: go run
  items.push({icon:"✅", title:"Regla RUN ANYWAY", desc:"Sales sí o sí. El clima solo decide la capa."});

  return items;
}

function sessionSuggestion({score, wind, pProb, pMm, tFeels}){
  // Simple: adapt duration by harsher conditions
  let min = 25, max = 35, goal = "Constancia, no velocidad.";
  if (score < 50 || wind >= 35 || pMm >= 1.5 || pProb >= 70) { min = 20; max = 30; goal = "Fácil y controlado. Técnica y mente."; }
  if (tFeels >= 28) { min = 20; max = 30; goal = "Fácil. Hidratación y sombra."; }
  return { session:`${min}–${max} min (easy)`, goal };
}

function pickBestWindow(hourly){
  // next 12 hours choose best hour by penalties
  const n = Math.min(12, hourly.time.length);
  let best = { idx: 0, score: -Infinity };
  for (let i=0;i<n;i++){
    const tFeels = hourly.apparent_temperature[i];
    const pProb = hourly.precipitation_probability[i] ?? 0;
    const pMm = hourly.precipitation[i] ?? 0;
    const wind = hourly.wind_speed_10m[i] ?? 0;
    const s = computeRunScore(tFeels, pProb, pMm, wind);
    if (s > best.score) best = { idx:i, score:s };
  }
  const t = hourly.time[best.idx];
  return { time: niceTime(t), score: best.score };
}

// --- Render ---
function setGauge(score){
  el("scoreValue").textContent = score;
  const arc = el("gaugeArc");
  // circumference ~ 2*pi*50 = 314
  const C = 314;
  const offset = C - (C * (score/100));
  arc.style.strokeDashoffset = `${offset}`;
  const st = statusFromScore(score);
  arc.style.stroke = st.color;
  el("pillStatus").textContent = st.label;
  el("pillStatus").style.background = "rgba(255,255,255,.08)";
  el("pillStatus").style.borderColor = "rgba(255,255,255,.12)";
}

function setNowChips(now){
  const box = el("nowChips");
  box.innerHTML = "";
  const chips = [
    `🌡️ ${fmt(now.t,1)}°C (sens ${fmt(now.feels,1)}°)`,
    `🌧️ ${fmt(now.pProb,0)}% · ${fmt(now.pMm,1)} mm`,
    `💨 ${fmt(now.wind,0)} km/h`,
    `💧 ${fmt(now.hum,0)}%`,
    `🧭 ${fmt(now.press,0)} mbar`
  ];
  chips.forEach(t => {
    const d = document.createElement("div");
    d.className = "chip";
    d.textContent = t;
    box.appendChild(d);
  });
}

function setOutfit(items){
  const box = el("outfitList");
  box.innerHTML = "";
  items.forEach(it => {
    const row = document.createElement("div");
    row.className = "item";
    row.innerHTML = `
      <div class="icon">${it.icon}</div>
      <div class="txt">
        <b>${it.title}</b>
        <div class="muted">${it.desc}</div>
      </div>
    `;
    box.appendChild(row);
  });
}

function setCta(score, now){
  el("ctaTitle").textContent = "Sal a correr.";
  // dynamic persuasion line
  const code = now.code;
  let msg = "Hoy sumas una sesión más. Constancia > perfección.";
  if ([61,63,65,80,81,82].includes(code)) msg = "Lluvia ligera = mente fuerte. Visera y listo.";
  if ([95,96,99].includes(code)) msg = "Tormenta cerca: sal con cuidado y visibilidad. Igual sales.";
  if (now.wind >= 30) msg = "Viento = técnica. Hoy trabajas postura y cadencia.";
  if (now.feels <= 10) msg = "Frío = ventaja. Entras en calor en 8 minutos.";
  if (now.feels >= 28) msg = "Calor: baja el ritmo, hidrátate. Igual sales.";
  el("ctaLine").textContent = msg;
}

function setSummaryLine(now){
  const icon = pickIconFromWeatherCode(now.code);
  el("summaryLine").textContent = `${icon} ${fmt(now.feels,1)}°C · lluvia ${fmt(now.pProb,0)}% · viento ${fmt(now.wind,0)} km/h`;
}

function setPlan(plan, bestWindow){
  el("sessionLine").textContent = plan.session;
  el("goalLine").textContent = plan.goal;
  el("windowLine").textContent = `Ventana ideal: ${bestWindow.time} (score ${bestWindow.score})`;
}

function setOutfitNote(now){
  let note = "Tip: calienta 5–7 min suave y termina con 3 min caminando.";
  if (now.pProb >= 40) note = "Tip lluvia: visera + impermeable liviano. Elige ruta con buen drenaje.";
  if (now.wind >= 25) note = "Tip viento: ida contra viento suave, vuelve a favor. Mantén cadencia.";
  el("outfitNote").textContent = note;
}

// --- Simple Canvas Chart (12h) ---
function drawChart(hourly){
  const canvas = el("chart");
  const ctx = canvas.getContext("2d");
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0,0,W,H);

  const n = Math.min(12, hourly.time.length);
  const times = hourly.time.slice(0,n);
  const temp = hourly.temperature_2m.slice(0,n);
  const rain = hourly.precipitation.slice(0,n);
  const prob = (hourly.precipitation_probability || []).slice(0,n);

  // ranges
  const tMin = Math.min(...temp), tMax = Math.max(...temp);
  const rMax = Math.max(0.5, ...rain);
  const pMax = 100;

  // paddings
  const padL=52, padR=16, padT=18, padB=42;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  // grid
  ctx.strokeStyle = "rgba(255,255,255,.08)";
  ctx.lineWidth = 1;
  for (let i=0;i<=4;i++){
    const y = padT + (innerH * i/4);
    ctx.beginPath(); ctx.moveTo(padL,y); ctx.lineTo(W-padR,y); ctx.stroke();
  }

  // x scale
  const x = (i) => padL + innerW * (i/(n-1));

  // temp scale
  const yT = (v) => padT + innerH * (1 - (v - tMin)/(tMax - tMin || 1));

  // rain scale (bars bottom portion)
  const yR0 = padT + innerH; // baseline
  const yR = (v) => yR0 - (innerH * 0.35) * (v / rMax); // use lower 35% for rain bars

  // bars (rain)
  for (let i=0;i<n;i++){
    const bw = Math.max(6, innerW/(n*1.8));
    const bx = x(i) - bw/2;
    const by = yR(rain[i]);
    ctx.fillStyle = "rgba(106,166,255,.35)";
    ctx.fillRect(bx, by, bw, yR0 - by);
  }

  // temp line
  ctx.strokeStyle = "rgba(124,240,198,.9)";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  for (let i=0;i<n;i++){
    const px = x(i), py = yT(temp[i]);
    if (i===0) ctx.moveTo(px,py); else ctx.lineTo(px,py);
  }
  ctx.stroke();

  // precip probability (dotted)
  if (prob && prob.length === n){
    const yP = (v) => padT + innerH * (1 - (v/pMax));
    ctx.strokeStyle = "rgba(255,209,102,.9)";
    ctx.setLineDash([6,6]);
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i=0;i<n;i++){
      const px = x(i), py = yP(prob[i]);
      if (i===0) ctx.moveTo(px,py); else ctx.lineTo(px,py);
    }
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // labels
  ctx.fillStyle = "rgba(233,238,252,.75)";
  ctx.font = "12px ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
  // y labels temp
  ctx.fillText(`${fmt(tMax,1)}°C`, 10, padT+10);
  ctx.fillText(`${fmt(tMin,1)}°C`, 10, padT+innerH);

  // x labels
  ctx.font = "12px ui-sans-serif, system-ui";
  for (let i=0;i<n;i++){
    if (i % 2 === 0){
      const txt = niceTime(times[i]);
      ctx.fillStyle = "rgba(233,238,252,.65)";
      ctx.fillText(txt, x(i)-14, H-16);
    }
  }

  // interactive hover
  canvas.onmousemove = (ev) => {
    const rect = canvas.getBoundingClientRect();
    const mx = (ev.clientX - rect.left) * (W/rect.width);
    const my = (ev.clientY - rect.top) * (H/rect.height);

    // find closest index by x
    let bestIdx = 0, bestDist = Infinity;
    for (let i=0;i<n;i++){
      const d = Math.abs(mx - x(i));
      if (d < bestDist){ bestDist = d; bestIdx = i; }
    }
    if (bestDist > 40){ el("tooltip").classList.add("hidden"); return; }

    const tt = el("tooltip");
    tt.classList.remove("hidden");
    tt.style.left = `${mx}px`;
    tt.style.top = `${my}px`;

    const icon = pickIconFromWeatherCode(hourly.weather_code[bestIdx]);
    tt.innerHTML = `
      <div><b>${icon} ${niceTime(times[bestIdx])}</b></div>
      <div class="meta">Temp: ${fmt(temp[bestIdx],1)}°C</div>
      <div class="meta">Lluvia: ${fmt(rain[bestIdx],1)} mm</div>
      <div class="meta">Prob: ${prob?.length===n ? fmt(prob[bestIdx],0) : "—"}%</div>
      <div class="meta">Viento: ${fmt(hourly.wind_speed_10m[bestIdx],0)} km/h</div>
    `;
  };
  canvas.onmouseleave = () => el("tooltip").classList.add("hidden");
}

// --- Feedback & history ---
const LS_KEY = "runanyway_history_v1";

function loadHistory(){
  try{ return JSON.parse(localStorage.getItem(LS_KEY) || "[]"); }
  catch{ return []; }
}
function saveHistory(items){
  localStorage.setItem(LS_KEY, JSON.stringify(items));
}

function addHistoryEntry(entry){
  const items = loadHistory();
  items.unshift(entry);
  saveHistory(items.slice(0, 50));
  renderHistory();
}

function avgAccuracyLast10(){
  const items = loadHistory().slice(0,10);
  if (!items.length) return null;
  const s = items.reduce((a,b) => a + (b.accuracy ?? 0), 0);
  return Math.round(s / items.length);
}

function renderHistory(){
  const items = loadHistory().slice(0, 9);
  const box = el("history");
  box.innerHTML = "";

  const avg = avgAccuracyLast10();
  el("accuracyKpi").textContent = `Precisión promedio (últimas 10): ${avg === null ? "—" : avg + "/100"}`;

  if (!items.length){
    box.innerHTML = `<div class="muted">Aún no hay registros. Haz una corrida y deja feedback.</div>`;
    return;
  }

  items.forEach(it => {
    const d = new Date(it.ts);
    const dt = `${d.toLocaleDateString()} ${d.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"})}`;
    const div = document.createElement("div");
    div.className = "hitem";
    div.innerHTML = `
      <div class="top">
        <div class="city">${it.city}</div>
        <div class="dt">${dt}</div>
      </div>
      <div class="row">Run Score: <b>${it.runScore}</b> · Precisión: <b>${it.accuracy ?? "—"}</b></div>
      <div class="row">Clima: ${it.nowSummary}</div>
    `;
    box.appendChild(div);
  });
}

// --- Run Mode (timer + wake lock) ---
function fmtTime(sec){
  const m = Math.floor(sec/60).toString().padStart(2,"0");
  const s = (sec%60).toString().padStart(2,"0");
  return `${m}:${s}`;
}

async function enableWakeLock(){
  try{
    if (!("wakeLock" in navigator)) return false;
    state.wakeLock = await navigator.wakeLock.request("screen");
    return true;
  }catch{
    return false;
  }
}
async function disableWakeLock(){
  try{ await state.wakeLock?.release?.(); }catch{}
  state.wakeLock = null;
}

function startRunMode(){
  el("runMode").classList.remove("hidden");
  el("rmCity").textContent = state.place ? `${state.place.name}, ${state.place.admin1}` : "—";

  state.runSeconds = 0;
  el("rmTime").textContent = "00:00";

  state.runTimer = setInterval(() => {
    state.runSeconds++;
    el("rmTime").textContent = fmtTime(state.runSeconds);
  }, 1000);

  // set current summary
  const now = state.forecast?.now;
  if (now){
    el("rmNow").textContent = `${fmt(now.feels,1)}°C · ${fmt(now.pProb,0)}% · ${fmt(now.wind,0)} km/h`;
  }
  el("rmMsg").textContent = "Sal a correr. Ajusta capas y disfruta.";
}

function stopRunMode(){
  clearInterval(state.runTimer);
  state.runTimer = null;
  el("runMode").classList.add("hidden");
  disableWakeLock();
}

// --- Modal handlers ---
function openModal(){ el("modal").classList.remove("hidden"); }
function closeModal(){ el("modal").classList.add("hidden"); }

el("btnFeedback").onclick = openModal;
el("btnClose").onclick = closeModal;
el("modal").addEventListener("click", (e) => { if (e.target === el("modal")) closeModal(); });

el("fbScore").addEventListener("input", () => {
  el("fbScoreVal").textContent = el("fbScore").value;
});

el("btnSaveFb").onclick = () => {
  const now = state.forecast?.now;
  if (!now || !state.place){
    closeModal(); return;
  }
  const accuracy = Number(el("fbScore").value);

  addHistoryEntry({
    ts: nowISO(),
    city: `${state.place.name}, ${state.place.admin1}`,
    runScore: state.forecast.runScore,
    accuracy,
    fb: {
      temp: el("fbTemp").value,
      rain: el("fbRain").value,
      wind: el("fbWind").value
    },
    nowSummary: `${fmt(now.feels,1)}°C · lluvia ${fmt(now.pProb,0)}% · viento ${fmt(now.wind,0)} km/h`
  });

  closeModal();
};

// --- Buttons ---
el("timeSelect").addEventListener("change", () => {
  state.selectedTimeMode = el("timeSelect").value;
  if (state.place) refresh();
});
el("btnRefresh").onclick = () => refresh();

el("btnRunMode").onclick = () => startRunMode();
el("btnExitRun").onclick = () => stopRunMode();
el("btnStopRun").onclick = () => { stopRunMode(); openModal(); };

el("btnToggleLock").onclick = async () => {
  if (state.wakeLock){
    await disableWakeLock();
    el("btnToggleLock").textContent = "Mantener pantalla encendida";
  }else{
    const ok = await enableWakeLock();
    el("btnToggleLock").textContent = ok ? "Pantalla fija: ON" : "No disponible en este navegador";
  }
};

// --- Main refresh ---
async function refresh(){
  if (!state.place){
    // default Bogota
    state.place = { name:"Bogotá", admin1:"Distrito Capital", lat:4.7110, lon:-74.0721 };
    el("cityInput").value = "Bogotá, Distrito Capital";
  }

  el("ctaLine").textContent = "Cargando pronóstico…";

  const raw = await fetchForecast(state.place.lat, state.place.lon);

  // Resolve chosen hour index
  const idx = resolveTargetIndex(raw.hourly.time);

  const now = {
    t: raw.current.temperature_2m,
    feels: raw.current.apparent_temperature,
    pMm: raw.current.precipitation ?? 0,
    pProb: raw.current.precipitation_probability ?? 0,
    wind: raw.current.wind_speed_10m ?? 0,
    hum: raw.current.relative_humidity_2m ?? 0,
    press: raw.current.pressure_msl ?? 0,
    code: raw.current.weather_code ?? 0,
  };

  // Also compute "selected hour" (for outfit and score)
  const selected = {
    time: raw.hourly.time[idx],
    t: raw.hourly.temperature_2m[idx],
    feels: raw.hourly.apparent_temperature[idx],
    pMm: raw.hourly.precipitation[idx] ?? 0,
    pProb: raw.hourly.precipitation_probability?.[idx] ?? 0,
    wind: raw.hourly.wind_speed_10m[idx] ?? 0,
    code: raw.hourly.weather_code[idx] ?? 0,
  };

  const runScore = computeRunScore(selected.feels, selected.pProb, selected.pMm, selected.wind);
  const bestWindow = pickBestWindow(raw.hourly);
  const plan = sessionSuggestion({score:runScore, wind:selected.wind, pProb:selected.pProb, pMm:selected.pMm, tFeels:selected.feels});
  const outfit = outfitRules({tFeels:selected.feels, pProb:selected.pProb, pMm:selected.pMm, wind:selected.wind, code:selected.code});

  state.forecast = { raw, now, selected, runScore };

  setGauge(runScore);
  setNowChips(now);
  setCta(runScore, selected);
  setSummaryLine(selected);
  setOutfit(outfit);
  setOutfitNote(selected);
  setPlan(plan, bestWindow);

  drawChart(raw.hourly);
}

// init
renderHistory();
refresh().catch(err => {
  console.error(err);
  el("ctaLine").textContent = "Error cargando clima. Reintenta.";
});