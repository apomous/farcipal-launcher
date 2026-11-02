(async () => {
  const $ = (id) => document.getElementById(id);
  const L = window.launcher, C = window.Companion;
  const pad = (n, l = 2) => String(n).padStart(l, "0");

  const play = $("play"), playText = $("playText"), q = $("q"), ver = $("ver"), acct = $("acct"), acctText = $("acctText");
  const progress = $("progress"), statusText = $("statusText"), statusDot = $("statusDot"), timerEl = $("timer");
  const pillDot = $("pillDot"), pillText = $("pillText");
  const logEl = $("log"), cardsEl = $("cards"), hint = $("hint");
  const ram = $("ram"), ramOut = $("ramOut"), snap = $("snap"), join = $("join");
  const avatar = $("avatar"), pname = $("pname"), psub = $("psub"), nickWrap = $("nickWrap");
  const loader = $("loader"), loaderVer = $("loaderVer"), loaderVerWrap = $("loaderVerWrap");
  const companionToggle = $("companionToggle");
  C.init({ play, progress, shake: $("shake"), targets: ".panel, .card, .play, .tab, .brand"});

  // ---------- часы ----------
  const tick = () => { const d = new Date(); $("clock").textContent = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
  tick(); setInterval(tick, 1000);

  // ---------- таймер ----------
  let t0 = 0, raf = 0;
  const fmt = (ms) => `${pad(Math.floor(ms / 60000))}:${pad(Math.floor(ms / 1000) % 60)}.${pad(Math.floor(ms % 1000), 3)}`;
  const runTimer = () => { timerEl.textContent = fmt(performance.now() - t0); raf = requestAnimationFrame(runTimer); };
  const startTimer = () => { cancelAnimationFrame(raf); t0 = performance.now(); runTimer(); };
  const stopTimer = () => cancelAnimationFrame(raf);

  // ---------- журнал ----------
  const stamp = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`; };
  function log(msg, cls) {
    const p = document.createElement("p");
    const t = document.createElement("time"); t.textContent = stamp();
    p.appendChild(t); p.appendChild(document.createTextNode(msg));
    if (cls) p.className = cls;
    logEl.appendChild(p);
    while (logEl.children.length > 80) logEl.removeChild(logEl.firstChild);
    logEl.scrollTop = logEl.scrollHeight;
  }
  const showHint = (text, info) => { hint.textContent = text || ""; hint.className = "hint" + (info ? " info" : ""); };

  // ---------- состояние интерфейса ----------
  const UI = {
    idle:    { dot: "idle",     pill: "готов",     status: "готов",     btn: "ЗАПУСТИТЬ" },
    loading: { dot: "scanning", pill: "загрузка",  status: "загрузка",  btn: "ОСТАНОВИТЬ" },
    running: { dot: "found",    pill: "в игре",    status: "в игре",    btn: "В ИГРЕ" },
    error:   { dot: "error",    pill: "сбой",      status: "ошибка",    btn: "ЗАПУСТИТЬ" }
  };
  let uiState = "idle";
  function setUi(s) {
    uiState = s;
    const u = UI[s];
    pillDot.dataset.s = statusDot.dataset.s = u.dot;
    pillText.textContent = u.pill; statusText.textContent = u.status;
    playText.textContent = u.btn; play.dataset.s = s;
    play.disabled = false; // <--- ИСПРАВЛЕНО: теперь кнопка всегда кликабельна
    play.setAttribute("aria-busy", s === "loading" ? "true" : "false");
    
    [ver, snap, loader, loaderVer].forEach((el) => { el.disabled = s === "loading" || s === "running"; });
    acct.disabled = s === "loading" || s === "running";
    
    // Глаз реагирует на наведение только когда мы в меню или ошибке
    C.setHoverable(s === "idle" || s === "error"); 
  }
  setUi("idle");

  // ---------- настройки ----------
  const settings = await L.settings.get();
  ram.value = settings.memory; ramOut.textContent = `${settings.memory} ГБ`;
  snap.checked = settings.snapshots; join.checked = settings.joinServer;
    // Восстанавливаем состояние FARCOP
  const isCompanionEnabled = settings.companion !== false; // По умолчанию true
  companionToggle.checked = isCompanionEnabled;
  C.setVisible(isCompanionEnabled);
  q.value = settings.demoName || "";
  loader.value = settings.loaderType || "vanilla";
  let wantLoaderVer = settings.loaderVersion || "";
  const save = () => L.settings.set({
    memory: Number(ram.value), version: ver.value, snapshots: snap.checked,
    joinServer: join.checked, demoName: q.value.trim(), loaderType: loader.value, loaderVersion: loaderVer.value,
    companion: companionToggle.checked
  });
  ram.addEventListener("input", () => { ramOut.textContent = `${ram.value} ГБ`; });
  ram.addEventListener("change", save);
  join.addEventListener("change", save);
  ver.addEventListener("change", () => { save(); fillLoaderVersions(); });
  loader.addEventListener("change", () => { save(); refreshLoader(); });
  loaderVer.addEventListener("change", () => { wantLoaderVer = loaderVer.value; save(); });
  snap.addEventListener("change", () => { save(); fillVersions(); });
  q.addEventListener("blur", save);
  q.addEventListener("input", renderProfile);
  q.addEventListener("keydown", (e) => { if (e.key === "Enter") play.click(); });
    companionToggle.addEventListener("change", () => {
    save();
    C.setVisible(companionToggle.checked);
  });

  

  // ---------- конфиг и карточки ----------
  const cfg = await L.config();
  function card(color, title, sub, pct, tags) {
    const c = document.createElement("article");
    c.className = "card"; c.style.setProperty("--c", color);
    const h = document.createElement("h3"); h.textContent = title; c.appendChild(h);
    const u = document.createElement("div"); u.className = "url"; u.textContent = sub; c.appendChild(u);
    if (pct) { const p = document.createElement("div"); p.className = "pct"; p.textContent = pct; c.appendChild(p); }
    if (tags && tags.length) {
      const m = document.createElement("div"); m.className = "meta";
      tags.forEach((t) => { const s = document.createElement("span"); s.className = "tag"; s.textContent = t; m.appendChild(s); });
      c.appendChild(m);
    }
    return c;
  }
  if (cfg.server.host) {
    cardsEl.appendChild(card("#3dcf6f", cfg.server.name, `${cfg.server.host}:${cfg.server.port}`, "сервер", ["заход одной галочкой слева"]));
  } else {
    cardsEl.appendChild(card("#e8b45a", "Сервер не настроен", "впиши host в config.js, и появится автозаход", "", []));
    $("joinWrap").hidden = true;
  }
  cfg.news.forEach((n) => cardsEl.appendChild(card("#6d7288", n.title, n.text, "", n.tag ? [n.tag] : [])));
  cardsEl.appendChild(card("#6d7288", "Папка игры", cfg.gameDir, "", []));

  // ---------- версии ----------
  let manifest = null, supported = null;   // supported: версии игры, которые умеет загрузчик (null = Vanilla)
function fillVersions() {
  if (!manifest) return;
  const keep = ver.value || settings.version;
  ver.textContent = "";
  manifest.versions
    .filter((v) => supported ? supported.has(v.id) : (v.type === "release" || (snap.checked && v.type === "snapshot")))
    .forEach((v) => { const o = document.createElement("option"); o.value = v.id; o.textContent = v.id; ver.appendChild(o); });
  const has = (id) => [...ver.options].some((o) => o.value === id);
  ver.value = has(keep) ? keep : has(manifest.latest.release) ? manifest.latest.release : (ver.options[0] ? ver.options[0].value : "");
  }
  try {
    log("загружаю список версий");
    manifest = await L.versions();
    fillVersions();
    log(`версий: ${manifest.versions.length}, последний релиз ${manifest.latest.release}`, "ok");
  } catch (e) {
    log("список версий недоступен: " + e.message, "err");
    showHint("Нет связи с серверами Mojang. Проверь интернет и перезапусти лаунчер.");
  }
  const gamesCache = {};
let loaderReq = 0;                       // защита от устаревших ответов при быстром переключении
const addOpt = (sel, value, text) => { const o = document.createElement("option"); o.value = value; o.textContent = text; sel.appendChild(o); };

async function fillLoaderVersions() {
  const type = loader.value;
  loaderVerWrap.hidden = type === "vanilla";
  if (type === "vanilla" || !ver.value) return;
  const my = ++loaderReq, mc = ver.value;
  loaderVer.textContent = ""; addOpt(loaderVer, "", "загрузка…"); loaderVer.disabled = true;
  try {
    const { items, recommended } = await L.loaderVersions(type, mc);
    if (my !== loaderReq) return;
    loaderVer.textContent = "";
    if (!items.length) { addOpt(loaderVer, "", `нет версий для ${mc}`); return; }
    items.forEach((it) => addOpt(loaderVer, it.id, it.label));
    loaderVer.value = items.some((i) => i.id === wantLoaderVer) ? wantLoaderVer : (recommended || items[0].id);
    wantLoaderVer = loaderVer.value;
    loaderVer.disabled = uiState === "loading" || uiState === "running";
    save();
  } catch (e) {
    if (my !== loaderReq) return;
    loaderVer.textContent = ""; addOpt(loaderVer, "", "недоступно");
    log("версии загрузчика недоступны: " + e.message, "err");
  }
}
async function refreshLoader() {
  const type = loader.value;
  snap.closest("label").hidden = type !== "vanilla";
  if (type === "vanilla") { supported = null; loaderVerWrap.hidden = true; fillVersions(); return; }
  const my = ++loaderReq;
  try {
    if (!gamesCache[type]) gamesCache[type] = new Set(await L.loaderGames(type));
    if (my !== loaderReq) return;
    supported = gamesCache[type]; fillVersions();
  } catch (e) {
    log("список версий для загрузчика недоступен: " + e.message, "err");
    showHint("Не удалось получить версии " + (type === "forge" ? "Forge" : "Fabric") + ". Проверь интернет.");
    return;
  }
  await fillLoaderVersions();
}
await refreshLoader();

  // ---------- аккаунт и профиль ----------
  let account = null;
  function renderProfile() {
    if (account) {
      pname.textContent = account.name; psub.textContent = account.demo ? "аккаунт без игры · демо" : "Microsoft";
      avatar.textContent = account.name.charAt(0).toUpperCase();
    } else {
      const n = q.value.trim();
      pname.textContent = n || "Гость"; psub.textContent = "демо-режим";
      avatar.textContent = n ? n.charAt(0).toUpperCase() : "?";
    }
  }
  function renderAccount() {
    nickWrap.hidden = !!account;
    acctText.textContent = account ? "Выйти из аккаунта" : "Войти через Microsoft";
    renderProfile();
    if (!account) showHint("Без входа игра запускается в демо-режиме Mojang: введи ник.", true);
    else showHint(account.demo ? "На аккаунте нет купленной игры: запустится демо-режим." : "", true);
  }
  account = await L.session();
  if (account) log(`сессия Microsoft восстановлена: ${account.name}`, "ok");
  renderAccount();

  acct.addEventListener("click", async () => {
    acct.disabled = true;
    try {
      if (account) { await L.logout(); account = null; log("вышел из аккаунта"); }
      else { log("открываю вход Microsoft"); account = await L.login(); log(`вошёл как ${account.name}`, "ok"); }
    } catch (e) {
      log("вход не удался: " + (e && e.message ? e.message : e), "err");
      showHint("Не получилось войти. Попробуй ещё раз.");
    } finally { acct.disabled = false; renderAccount(); }
  });

  // ---------- запуск: удар, потом загрузка ----------
  let starting = false;
  play.addEventListener("click", async () => {
        if (uiState === "running" || uiState === "loading") { 
      await L.stop(); 
      setUi("idle");
      C.phase("idle");
      starting = false;
      return;
    } 
        if (starting) return;
    if (loader.value !== "vanilla" && !loaderVer.value) { showHint("Выбери версию загрузчика"); return; }
    starting = true;
    save(); showHint("");
    await C.slam();                       // глаз врезается в кнопку, дальше только загрузка
    const res = await L.play({
      version: ver.value, memory: Number(ram.value), joinServer: join.checked,
      mode: account ? "microsoft" : "demo", name: q.value,loaderType: loader.value, loaderVersion: loaderVer.value
    });
    starting = false;
    if (res.cancelled) { setUi("idle"); C.phase("idle"); progress.className = "progress"; stopTimer(); return; }
    if (!res.ok) {
      showHint(res.error); log(res.error, "err");
      setUi("error"); C.phase("error"); progress.className = "progress"; stopTimer();
      setTimeout(() => { if (uiState === "error") setUi("idle"); }, 2600);
    }
  });

  L.on("game:state", ({ state, code }) => {
    if (state === "loading") {
      setUi("loading"); C.phase("loading");
      progress.className = "progress on"; startTimer(); log(`запускаю ${ver.value}`);
    } else if (state === "running") {
      setUi("running"); C.phase("running");
      progress.className = "progress done"; stopTimer(); log("игра запущена", "ok");
    } else if (state === "stopped") {
      setUi("idle"); C.phase("idle"); progress.className = "progress"; stopTimer(); log("игра закрыта");
    } else if (state === "error") {
      setUi("error"); C.phase("error"); progress.className = "progress"; stopTimer();
      log(`игра завершилась с кодом ${code}`, "err");
      showHint(`Игра закрылась с ошибкой (код ${code}). Подробности в журнале.`);
      setTimeout(() => { if (uiState === "error") setUi("idle"); }, 2600);
    }
  });

  let lastProg = 0;
  L.on("game:progress", (p) => {
    const now = performance.now(); 
    const txt = p.total > 1 ? `${p.type}: ${p.task}/${p.total} МБ` : p.type;
    statusText.textContent = txt;
    if (now - lastProg > 700 || (p.total > 1 && p.task === p.total)) { log(txt); lastProg = now; }
  });
  L.on("game:log", ({ text, game }) => {
    if (text && (game || /error|fail|ошиб/i.test(text))) log(text.slice(0, 160), /error|fail/i.test(text) ? "err" : "");
  });
  // --- ЛОГИКА ВКЛАДОК ---
  const tabs = document.querySelectorAll(".tab");
  const tabIndicator = document.getElementById("tabIndicator");

  function moveIndicator(activeTab) {
    if (!activeTab || !tabIndicator) return;
    tabIndicator.style.width = `${activeTab.offsetWidth}px`;
    tabIndicator.style.transform = `translateX(${activeTab.offsetLeft}px)`;
  }
  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      // Переключаем активный класс у кнопок
      tabs.forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      moveIndicator(tab);

      // Меняем режим у body (это включит нужные CSS-стили)
      const target = tab.dataset.target;
      document.body.dataset.mode = target;
      if (uiState === "idle" || uiState === "error") C.phase("idle");   // будим глаз, но не сбрасываем загрузку
    });
  });

  // Инициализация при старте (чтобы плашка сразу встала под "ИГРАТЬ")
  setTimeout(() => {
    moveIndicator(document.querySelector('.tab.active'));
  }, 100);
    // Устанавливаем режим "play" по умолчанию при старте
  document.body.dataset.mode = "play";
  
  // Кнопки управления окном
  $("wmin").addEventListener("click", () => L.win("min"));
  $("wclose").addEventListener("click", () => L.win("close"));

})();
