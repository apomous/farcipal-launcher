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

  // общее состояние — до всех листенеров, чтобы порядок загрузки не mattered
  let account = null;
  let starting = false;
  let manifest = null, supported = null;
  let wantLoaderVer = "";

  // 17 на ползунке = «безлимит» → 0 для main (game.js превратит 0 в 64 потока)
  const concVal = () => (Number(conc.value) === 17 ? 0 : Number(conc.value));

  // сессию восстанавливаем параллельно — это самый медленный запрос при старте
  const sessionPromise = L.session().catch(() => null);

  C.init({ play, progress, shake: $("shake"), targets: ".panel, .card, .play, .tab, .brand, .scard" });

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
    idle:    { dot: "idle",     pill: "готов",        status: "готов",        btn: "ЗАПУСТИТЬ" },
    loading: { dot: "scanning", pill: "загрузка",     status: "загрузка",     btn: "ОСТАНОВИТЬ" },
    running: { dot: "found",    pill: "закрыть игру", status: "закрыть игру", btn: "ЗАКРЫТЬ ИГРУ" },
    error:   { dot: "error",    pill: "сбой",         status: "ошибка",       btn: "ЗАПУСТИТЬ" }
  };
  let uiState = "idle";
  function setUi(s) {
    uiState = s;
    const u = UI[s];
    pillDot.dataset.s = statusDot.dataset.s = u.dot;
    pillText.textContent = u.pill; statusText.textContent = u.status;
    playText.textContent = u.btn; play.dataset.s = s;
    play.disabled = false;
    play.setAttribute("aria-busy", s === "loading" ? "true" : "false");
    const busy = s === "loading" || s === "running";
    [ver, snap, loader, loaderVer, acct, q].forEach((el) => { el.disabled = busy; });
    C.setHoverable(s === "idle" || s === "error");
  }
  setUi("idle");

  // ---------- настройки + конфиг (локальные, быстрые) ----------
  const [settings, cfg] = await Promise.all([L.settings.get(), L.config()]);

  // сетевые запросы стартуют сразу, потребим их ниже — кнопки уже будут живые
  const newsPromise = L.news.get().catch(() => null);
  const versionsPromise = L.versions();
  versionsPromise.catch(() => {}); // обработаем в try ниже, это просто от unhandledrejection

  ram.value = settings.memory; ramOut.textContent = `${settings.memory} ГБ`;
  snap.checked = settings.snapshots; join.checked = settings.joinServer;
  conc.value = (settings.concurrency === 0) ? 17 : (settings.concurrency || 4);
  concOut.textContent = (conc.value == 17) ? "∞" : conc.value;
  const isCompanionEnabled = settings.companion !== false;
  companionToggle.checked = isCompanionEnabled;
  C.setVisible(isCompanionEnabled);
  discordToggle.checked = settings.discord !== false;
  q.value = settings.demoName || "";
  loader.value = settings.loaderType || "vanilla";
  wantLoaderVer = settings.loaderVersion || "";

  const save = () => L.settings.set({
    memory: Number(ram.value), version: ver.value, snapshots: snap.checked,
    joinServer: join.checked, demoName: q.value.trim(), loaderType: loader.value, loaderVersion: loaderVer.value,
    companion: companionToggle.checked, discord: discordToggle.checked,
    concurrency: concVal()
  });
  ram.addEventListener("input", () => { ramOut.textContent = `${ram.value} ГБ`; });
  ram.addEventListener("change", save);
  conc.addEventListener("input", () => { concOut.textContent = (conc.value == 17) ? "∞" : conc.value; });
  conc.addEventListener("change", save);
  join.addEventListener("change", save);
  ver.addEventListener("change", () => { save(); fillLoaderVersions(); });
  loader.addEventListener("change", () => { save(); refreshLoader(); });
  loaderVer.addEventListener("change", () => { wantLoaderVer = loaderVer.value; save(); });
  snap.addEventListener("change", () => { save(); fillVersions(); });
  q.addEventListener("blur", save);
  q.addEventListener("input", renderProfile);
  // Enter запускает только из меню — иначе он убивал запущенную игру
  q.addEventListener("keydown", (e) => { if (e.key === "Enter" && (uiState === "idle" || uiState === "error")) play.click(); });
  companionToggle.addEventListener("change", () => { save(); C.setVisible(companionToggle.checked); });
  discordToggle.addEventListener("change", () => L.settings.set({ discord: discordToggle.checked }));

  // ---------- карточки ----------
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
    cardsEl.appendChild(card("#e8b45a", "открытая бета", "при ошибках отправляйте логи", "farci", []));
    $("joinWrap").hidden = true;
  }

  // ---------- версии ----------
  function fillVersions() {
    if (!manifest) return;
    const currentVal = ver.value;
    const keep = (currentVal && currentVal !== "загрузка…") ? currentVal : settings.version;
    ver.textContent = "";
    manifest.versions
      .filter((v) => supported ? supported.has(v.id) : (v.type === "release" || (snap.checked && v.type === "snapshot")))
      .forEach((v) => {
        const o = document.createElement("option");
        o.value = v.id; o.textContent = v.id;
        ver.appendChild(o);
      });
    const has = (id) => [...ver.options].some((o) => o.value === id);
    ver.value = has(keep) ? keep : has(manifest.latest.release) ? manifest.latest.release : (ver.options[0] ? ver.options[0].value : "");
  }

  const gamesCache = {};
  let loaderReq = 0;   // защита от устаревших ответов при быстром переключении
  const addOpt = (sel, value, text) => { const o = document.createElement("option"); o.value = value; o.textContent = text; sel.appendChild(o); };

  async function fillLoaderVersions() {
    const type = loader.value;
    loaderVerWrap.hidden = type === "vanilla";
    if (type === "vanilla" || !ver.value || !manifest) return;
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
      loaderVer.disabled = false;   // не залочиваем селект после ошибки сети
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

  // ---------- аккаунт и профиль ----------
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

  // ---------- запуск ----------
  play.addEventListener("click", async () => {
    if (uiState === "running" || uiState === "loading") {
      await L.stop();
      showHint("останавливаю…", true);   // UI переключится по событию game:state, без гонки
      starting = false;
      return;
    }
    if (starting) return;
    if (!manifest) { showHint("Список версий ещё загружается, подожди пару секунд"); return; }
    if (loader.value !== "vanilla" && !loaderVer.value) { showHint("Выбери версию загрузчика"); return; }
    starting = true;
    save(); showHint("");
    await C.slam();
    const res = await L.play({
      version: ver.value, memory: Number(ram.value), joinServer: join.checked,
      mode: account ? "microsoft" : "demo", name: q.value,
      loaderType: loader.value, loaderVersion: loaderVer.value,
      concurrency: concVal()   // ФИКС: «безлимит» уезжает как 0, а не 17
    });
    starting = false;
    if (res.cancelled) { setUi("idle"); C.phase("idle"); progress.className = "progress"; stopTimer(); showHint(""); return; }
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
      progress.className = "progress done"; stopTimer(); log("игра запущена", "ok"); showHint("");
    } else if (state === "stopped") {
      setUi("idle"); C.phase("idle"); progress.className = "progress"; stopTimer(); log("игра закрыта"); showHint("");
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

  // ---------- вкладки ----------
  const tabs = document.querySelectorAll(".tab");
  const tabIndicator = $("tabIndicator");
  function moveIndicator(activeTab) {
    if (!activeTab || !tabIndicator) return;
    tabIndicator.style.width = `${activeTab.offsetWidth}px`;
    tabIndicator.style.transform = `translateX(${activeTab.offsetLeft}px)`;
  }
  function applyCompanionTargets(mode) {
    if (mode === "network") {
      C.setTargets(".tab, .net-box, .net-guide-card, .guide, .play-btn-small, .net-btn-outline, .sc-btn, .room-code-box");
      C.setActionBtn($("btnCreateRoom"));
    } else if (mode === "play") {
      C.setTargets(".panel, .card, .play, .tab, .brand, .scard");
      C.setActionBtn($("play"));
    } else {
      C.setTargets(".panel, .card, .play, .tab, .brand, .scard");
      C.setActionBtn(null);
    }
  }
  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      tabs.forEach(t => t.classList.remove("active"));
      tab.classList.add("active");
      moveIndicator(tab);
      const target = tab.dataset.target;
      document.body.dataset.mode = target;
      applyCompanionTargets(target);
      if (uiState === "idle" || uiState === "error") C.phase("idle");
    });
  });
  document.body.dataset.mode = "play";
  // плашка встаёт точно после догрузки шрифтов (font-display: swap меняет ширины)
  const placeIndicator = () => moveIndicator(document.querySelector(".tab.active"));
  placeIndicator();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(placeIndicator);
  addEventListener("resize", placeIndicator);

  // ---------- окно ----------
  $("wmin").addEventListener("click", () => L.win("min"));
  $("wclose").addEventListener("click", () => L.win("close"));
  window.addEventListener("blur", () => {
    if (companionToggle.checked && uiState !== "running") C.setVisible(false);
  });
  window.addEventListener("focus", () => {
    if (companionToggle.checked && uiState !== "running") C.setVisible(true);
  });

  // ---------- вкладка СЕТЬ ----------
  const netStart = $("netStart"), netHost = $("netHost"), netGuest = $("netGuest");
  const btnCreateRoom = $("btnCreateRoom"), btnJoinRoom = $("btnJoinRoom");
  const joinCodeInput = $("joinCodeInput");
  const hostRoomCode = $("hostRoomCode"), tunnelPlayersList = $("tunnelPlayersList");
  const guestStatus = $("guestStatus"), guestLoader = $("guestLoader"), guestSuccess = $("guestSuccess"), guestAddress = $("guestAddress");
  let codeCopied = false;
  const playerItems = new Map();   // ники с пробелами/дубликаты больше не ломают список

  btnCreateRoom.addEventListener("click", async () => {
    if (btnCreateRoom.disabled) return;
    btnCreateRoom.disabled = true;   // лочим ДО анимации, двойной клик не пройдёт
    const btnText = $("btnCreateText");
    try {
      const playerName = account ? account.name : (q.value.trim() || "Host");
      await C.slam();
      btnText.textContent = "ПОИСК ИГРЫ...";
      const res = await L.tunnelHost(playerName);
      if (res.ok) {
        netStart.classList.add("hidden");
        btnCreateRoom.style.display = "none";
        netHost.classList.remove("hidden");
        hostRoomCode.dataset.code = res.roomCode;   // код живёт тут, текст можно менять смело
        hostRoomCode.textContent = res.roomCode;
        C.setTargets(".tab, .room-code-box, .players-list li");
        C.setActionBtn(hostRoomCode);
        C.phase("running");
      } else {
        alert("Ошибка: " + res.error);
      }
    } finally {
      btnText.textContent = "СОЗДАТЬ КОМНАТУ";
      btnCreateRoom.disabled = false;
    }
  });

  hostRoomCode.addEventListener("click", async () => {
    const code = hostRoomCode.dataset.code;
    if (!code || codeCopied) return;   // повторный клик не копирует «СКОПИРОВАНО!»
    try { await navigator.clipboard.writeText(code); } catch { return; }
    codeCopied = true;
    hostRoomCode.textContent = "СКОПИРОВАНО!";
    setTimeout(() => {
      hostRoomCode.textContent = hostRoomCode.dataset.code || "----";
      codeCopied = false;
    }, 1500);
  });

  btnJoinRoom.addEventListener("click", async () => {
    if (btnJoinRoom.disabled) return;
    const code = joinCodeInput.value.trim();
    if (code.length < 10) {
      joinCodeInput.style.borderColor = "var(--red)";
      setTimeout(() => joinCodeInput.style.borderColor = "", 2000);
      return;
    }
    btnJoinRoom.disabled = true;
    const playerName = account ? account.name : (q.value.trim() || "Guest");
    netStart.classList.add("hidden");
    netGuest.classList.remove("hidden");
    guestStatus.classList.remove("hidden", "text-yellow");   // сбрасываем прошлую ошибку
    guestStatus.textContent = "Ищем хоста...";
    guestSuccess.classList.add("hidden");
    guestLoader.classList.remove("hidden");
    try {
      const res = await L.tunnelJoin(code, playerName);
      if (res.ok) {
        guestStatus.classList.add("hidden");
        guestLoader.classList.add("hidden");
        guestSuccess.classList.remove("hidden");
        guestAddress.textContent = res.address;
        C.setTargets(".tab, .room-code-box");
        C.setActionBtn(guestAddress);   // глаз бьёт именно по адресу
        if (window.ASCII_BG) ASCII_BG.setLinked(true);   // капли на фоне сливаются
        C.slam().then(() => C.phase("running"));
      } else {
        guestStatus.textContent = "Ошибка: " + res.error;
        guestStatus.classList.add("text-yellow");
        guestLoader.classList.add("hidden");
        setTimeout(() => {
          netGuest.classList.add("hidden");
          netStart.classList.remove("hidden");
        }, 3000);
      }
    } finally {
      btnJoinRoom.disabled = false;
    }
  });

  const resetTunnelUI = () => {
    netHost.classList.add("hidden");
    netGuest.classList.add("hidden");
    netStart.classList.remove("hidden");
    tunnelPlayersList.innerHTML = "";
    playerItems.clear();
    joinCodeInput.value = "";
    delete hostRoomCode.dataset.code;
    hostRoomCode.textContent = "----";
    codeCopied = false;
    guestStatus.classList.remove("hidden", "text-yellow");
    btnJoinRoom.disabled = false;
    $("btnCreateText").textContent = "СОЗДАТЬ КОМНАТУ";
    btnCreateRoom.style.display = "";
    btnCreateRoom.disabled = false;
    C.phase("idle");
    if (window.ASCII_BG) ASCII_BG.setLinked(false);
    applyCompanionTargets(document.body.dataset.mode || "play");   // не сбрасываем таргеты на play, если мы в «Вместе»
  };

  const stopTunnel = async () => {
    resetTunnelUI();
    try { await L.tunnelClose(); } catch (e) { log("Ошибка при отключении: " + e.message, "err"); }
  };
  $("btnStopHost").addEventListener("click", stopTunnel);
  $("btnStopGuest").addEventListener("click", stopTunnel);
  L.on("tunnel:closed", resetTunnelUI);

  L.on("tunnel:player-join", (name) => {
    if (playerItems.has(name)) return;
    const li = document.createElement("li");
    li.textContent = name;
    tunnelPlayersList.appendChild(li);
    playerItems.set(name, li);
    if (window.ASCII_BG) ASCII_BG.setLinked(true);
  });
  L.on("tunnel:player-leave", (name) => {
    const li = playerItems.get(name);
    if (li) { li.remove(); playerItems.delete(name); }
    if (!playerItems.size && window.ASCII_BG) ASCII_BG.setLinked(false);
  });

  // ---------- экспорт/импорт сборки ----------
  const btnExport = $("btnExportModpack"), btnImport = $("btnImportModpack");
  const importWrap = $("importWrap"), importCodeInput = $("importCodeInput"), btnImportGo = $("btnImportGo");

  if (btnExport) {
    btnExport.addEventListener("click", async () => {
      if (btnExport.disabled) return;
      btnExport.disabled = true;
      try {
        const code = await L.exportModpack(ver.value, loader.value);
        await navigator.clipboard.writeText(code);
        btnExport.textContent = "СКОПИРОВАНО!";
        setTimeout(() => { btnExport.textContent = "СКОПИРОВАТЬ СБОРКУ"; btnExport.disabled = false; }, 2000);
      } catch (e) {
        btnExport.disabled = false;
        alert("Ошибка экспорта: " + e.message);
      }
    });
  }

  // prompt() в Electron не поддерживается — вместо него inline-поле (см. патч index.html)
  if (btnImport && importWrap) {
    btnImport.addEventListener("click", () => {
      importWrap.classList.toggle("hidden");
      if (!importWrap.classList.contains("hidden")) importCodeInput.focus();
    });
    const doImport = async () => {
      const code = importCodeInput.value.trim();
      if (!code || btnImportGo.disabled) return;
      btnImportGo.disabled = true; btnImport.disabled = true;
      btnImport.textContent = "ЗАГРУЗКА...";
      log("Начинаю скачивание сборки хоста...");
      try {
        const res = await L.importModpack(ver.value, loader.value, code);
        if (res.ok) {
          log("Сборка успешно установлена!", "ok");
          importWrap.classList.add("hidden");
          importCodeInput.value = "";
          alert("Сборка успешно скачана! Можете запускать игру.");
        } else {
          log("Ошибка импорта: " + res.error, "err");
          alert("Ошибка: " + res.error);
        }
      } finally {
        btnImportGo.disabled = false; btnImport.disabled = false;
        btnImport.textContent = "ЗАГРУЗИТЬ СБОРКУ ХОСТА";
      }
    };
    btnImportGo.addEventListener("click", doImport);
    importCodeInput.addEventListener("keydown", (e) => { if (e.key === "Enter") doImport(); });
  }

  // ---------- загрузка данных (кнопки выше уже работают) ----------
  const newsItems = (await newsPromise) || cfg.news || [];
  newsItems.forEach((n) => {
    const color = n.color === "green" ? "#3dcf6f" : n.color === "amber" ? "#e8b45a" : "#6d7288";
    cardsEl.appendChild(card(color, n.title, n.text, "", n.tag ? [n.tag] : []));
  });

  try {
    log("загружаю список версий");
    manifest = await versionsPromise;
    fillVersions();
    log(`версий: ${manifest.versions.length}, последний релиз ${manifest.latest.release}`, "ok");
  } catch (e) {
    log("список версий недоступен: " + e.message, "err");
    showHint("Нет связи с серверами Mojang. Проверь интернет и перезапусти лаунчер.");
  }

  await refreshLoader();

  account = await sessionPromise;
  if (account) log(`сессия Microsoft восстановлена: ${account.name}`, "ok");
  renderAccount();
})();
