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
  const discordToggle = $("discordToggle");
  const conc = $("conc"), concOut = $("concOut");
  C.init({ play, progress, shake: $("shake"), targets: ".panel, .card, .play, .tab, .brand, .scard"});
  
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
  running: { dot: "found",    pill: "закрыть игру",    status: "закрыть игру",    btn: "ЗАКРЫТЬ ИГРУ" },
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
  conc.value = (settings.concurrency === 0) ? 17 : (settings.concurrency || 4);
  concOut.textContent = (conc.value == 17) ? "∞" : conc.value;
    // Восстанавливаем состояние FARCOP
  const isCompanionEnabled = settings.companion !== false; // По умолчанию true
  companionToggle.checked = isCompanionEnabled;
  C.setVisible(isCompanionEnabled);
  discordToggle.checked = settings.discord !== false;
  q.value = settings.demoName || "";
  loader.value = settings.loaderType || "vanilla";
  let wantLoaderVer = settings.loaderVersion || "";
  const save = () => L.settings.set({
    memory: Number(ram.value), version: ver.value, snapshots: snap.checked,
    joinServer: join.checked, demoName: q.value.trim(), loaderType: loader.value, loaderVersion: loaderVer.value,
    companion: companionToggle.checked, discord: discordToggle.checked,
    concurrency: Number(conc.value) == 17 ? 0 : Number(conc.value)
  });
  ram.addEventListener("input", () => { ramOut.textContent = `${ram.value} ГБ`; });
  ram.addEventListener("change", save);
    conc.addEventListener("input", () => { 
    concOut.textContent = (conc.value == 17) ? "∞" : conc.value; 
  });
  conc.addEventListener("change", save);
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
    discordToggle.addEventListener("change", () => L.settings.set({ discord: discordToggle.checked }));

  

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
    cardsEl.appendChild(card("#e8b45a", "открытая бета","при ошибках отправляйте логи", "farci", []));
    $("joinWrap").hidden = true;
  }
    // Загружаем новости: сначала пробуем с сайта, если нет — берем из cfg.news
  let newsItems = cfg.news;
  try {
    newsItems = await L.news.get();
  } catch (e) {
    log("Не удалось загрузить новости, использую локальные", "err");
  }

  newsItems.forEach((n) => {
    // Выбираем цвет карточки
    const color = n.color === "green" ? "#3dcf6f" : n.color === "amber" ? "#e8b45a" : "#6d7288";
    cardsEl.appendChild(card(color, n.title, n.text, "", n.tag ? [n.tag] : []));
  });

  // ---------- версии ----------
  let manifest = null, supported = null;   // supported: версии игры, которые умеет загрузчик (null = Vanilla)
function fillVersions() {
  if (!manifest) return;
  const currentVal = ver.value;
  const keep = (currentVal && currentVal !== "загрузка…") ? currentVal : settings.version;
  ver.textContent = "";
  manifest.versions
    .filter((v) => supported ? supported.has(v.id) : (v.type === "release" || (snap.checked && v.type === "snapshot")))
    .forEach((v) => { 
      const o = document.createElement("option"); 
      o.value = v.id; 
      o.textContent = v.id; 
      ver.appendChild(o); 
    });
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
      mode: account ? "microsoft" : "demo", name: q.value,loaderType: loader.value, loaderVersion: loaderVer.value,
      concurrency: Number(conc.value)
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
      setUi("running"); C.setVisible(false);
      progress.className = "progress done"; stopTimer(); log("игра запущена", "ok");
    } else if (state === "stopped") {
      setUi("idle"); C.phase("idle"); progress.className = "progress"; stopTimer(); log("игра закрыта");
      if (companionToggle.checked) C.setVisible(true);
    } else if (state === "error") {
      setUi("error"); C.phase("error"); progress.className = "progress"; stopTimer();
      log(`игра завершилась с кодом ${code}`, "err");
      showHint(`Игра закрылась с ошибкой (код ${code}). Подробности в журнале.`);
      if (companionToggle.checked) C.setVisible(true);
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
    if (!text) return;
const bad = /error|fail|exception|сбой|ошибк|не удалось|нет на диске: [1-9]/i.test(text);
if (bad || !game) log(text.slice(0, 200), bad ? "err" : "");
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
      if (target === "network") {
        // Указываем ВСЕ элементы, за которые глаз должен цепляться на этой вкладке
        C.setTargets(".tab, .net-box, .net-guide-card, .guide, .play-btn-small, .net-btn-outline, .sc-btn, .room-code-box");
        C.setActionBtn($("btnCreateRoom"));
      } else if (target === "play") {
        C.setTargets(".panel, .card, .play, .tab, .brand, .scard");
        C.setActionBtn($("play"));
      } else {
        C.setTargets(".panel, .card, .play, .tab, .brand, .scard");
        C.setActionBtn(null);
      }
      
      if (uiState === "idle" || uiState === "error") C.phase("idle");
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
  // Сон при потере фокуса
  window.addEventListener('blur', () => {
    // Скрываем глаз, если он включен и игра не запущена (чтобы не было конфликтов)
    if (companionToggle.checked && uiState !== 'running') {
      C.setVisible(false);
    }
  });

  // Пробуждение при возврате в окно
  window.addEventListener('focus', () => {
    if (companionToggle.checked && uiState !== 'running') {
      C.setVisible(true);
    }
  });
  // --- ЛОГИКА ВКЛАДКИ СЕТЬ ---
  const netStart = $("netStart"), netHost = $("netHost"), netGuest = $("netGuest");
  const btnCreateRoom = $("btnCreateRoom"), btnJoinRoom = $("btnJoinRoom");
  const joinCodeInput = $("joinCodeInput");
  const hostRoomCode = $("hostRoomCode"), tunnelPlayersList = $("tunnelPlayersList");
  const guestStatus = $("guestStatus"), guestLoader = $("guestLoader"), guestSuccess = $("guestSuccess"), guestAddress = $("guestAddress");


    
  // Создание комнаты (Хост)
  btnCreateRoom.addEventListener("click", async () => {
    const playerName = account ? account.name : (q.value.trim() || "Host");
    await C.slam(); 

    const btnText = document.getElementById("btnCreateText"); 
    btnText.textContent = "ПОИСК ИГРЫ...";
    btnCreateRoom.disabled = true;

    const res = await L.tunnelHost(playerName);
    
    btnText.textContent = "СОЗДАТЬ КОМНАТУ";
    btnCreateRoom.disabled = false;

    if (res.ok) {
      netStart.classList.add("hidden");
      btnCreateRoom.style.display = "none";
      netHost.classList.remove("hidden");
      hostRoomCode.textContent = res.roomCode;      
      C.setTargets(".tab, .room-code-box, .players-list li");
      C.phase("running");
    } else {
      alert("Ошибка: " + res.error);
    }
  });

  // Копирование кода
  hostRoomCode.addEventListener("click", () => {
    navigator.clipboard.writeText(hostRoomCode.textContent);
    const old = hostRoomCode.textContent;
    hostRoomCode.textContent = "СКОПИРОВАНО!";
    setTimeout(() => hostRoomCode.textContent = old, 1500);
  });

  // Подключение (Гость)
  btnJoinRoom.addEventListener("click", async () => {
    const code = joinCodeInput.value.trim();
    if (code.length < 10){
      joinCodeInput.style.borderColor = "var(--red)";
      setTimeout(() => joinCodeInput.style.borderColor = "", 2000);
      return;
    } 

    const playerName = account ? account.name : (q.value.trim() || "Guest");

    netStart.classList.add("hidden");
    netGuest.classList.remove("hidden");
    guestStatus.textContent = "Ищем хоста...";
    guestSuccess.classList.add("hidden");
    guestLoader.classList.remove("hidden");

    const res = await L.tunnelJoin(code, playerName);

    if (res.ok) {
      guestStatus.classList.add("hidden");
      guestLoader.classList.add("hidden");
      guestSuccess.classList.remove("hidden");
      guestAddress.textContent = res.address;
      C.setTargets(".tab, .room-code-box");
      C.slam().then(() => C.phase("running")); // Глаз бьет по адресу
    } else {
      guestStatus.textContent = "Ошибка: " + res.error;
      guestStatus.classList.add("text-yellow");
      guestLoader.classList.add("hidden");
      setTimeout(() => {
        netGuest.classList.add("hidden");
        netStart.classList.remove("hidden");
      }, 3000);
    }
  });

  // Закрытие сессии (Хост или Гость)
    // Функция для сброса интерфейса (мгновенная)
    const resetTunnelUI = () => {
    netHost.classList.add("hidden");
    netGuest.classList.add("hidden");
    netStart.classList.remove("hidden");
    tunnelPlayersList.innerHTML = "";
    joinCodeInput.value = "";
    
    // Ищем span внутри кнопки и меняем текст ТАМ
    document.getElementById("btnCreateText").textContent = "СОЗДАТЬ КОМНАТУ";
    btnCreateRoom.style.display = "";
    btnCreateRoom.disabled = false;
    C.phase("idle");
    C.setTargets(".panel, .card, .play, .tab, .brand, .scard");
  };

  // Вызов закрытия (сначала меняем UI, потом убиваем процесс в фоне)
  const stopTunnel = async () => {
    resetTunnelUI(); // <--- Сразу показываем, что комната закрыта
    try {
      await L.tunnelClose(); // Ждем, пока процесс умрет
    } catch (e) {
      log("Ошибка при отключении: " + e.message, "err");
    }
  };

  // Привязываем кнопки
  $("btnStopHost").addEventListener("click", stopTunnel);
  $("btnStopGuest").addEventListener("click", stopTunnel);

    // Слушаем событие из main.js (сбрасываем UI)
  L.on("tunnel:closed", () => {
    resetTunnelUI(); 
  });
  



  // События из main.js
  L.on("tunnel:player-join", (name) => {
    const li = document.createElement("li");
    li.textContent = name;
    li.id = "player-" + name;
    tunnelPlayersList.appendChild(li);
  });

  L.on("tunnel:player-leave", (name) => {
    const li = document.getElementById("player-" + name);
    if (li) li.remove();
  });

  
  // --- ЭКСПОРТ/ИМПОРТ СБОРКИ ---
  const btnExport = $("btnExportModpack"), btnImport = $("btnImportModpack");

  if (btnExport) {
    btnExport.addEventListener("click", async () => {
      try {
        const code = await L.exportModpack(ver.value, loader.value);
        await navigator.clipboard.writeText(code);
        btnExport.textContent = "СКОПИРОВАНО!";
        setTimeout(() => btnExport.textContent = "СКОПИРОВАТЬ СБОРКУ", 2000);
      } catch (e) {
        alert("Ошибка экспорта: " + e.message);
      }
    });
  }

  if (btnImport) {
    btnImport.addEventListener("click", async () => {
      const code = prompt("Вставьте код сборки от хоста:");
      if (!code) return;
      
      btnImport.textContent = "ЗАГРУЗКА...";
      btnImport.disabled = true;
      log("Начинаю скачивание сборки хоста...", "info");

      const res = await L.importModpack(ver.value, loader.value, code.trim());

      btnImport.textContent = "ЗАГРУЗИТЬ СБОРКУ ХОСТА";
      btnImport.disabled = false;

      if (res.ok) {
        log("Сборка успешно установлена!", "ok");
        alert("Сборка успешно скачана! Можете запускать игру.");
      } else {
        log("Ошибка импорта: " + res.error, "err");
        alert("Ошибка: " + res.error);
      }
    });
  }
})();
