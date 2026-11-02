/* FARCIPAL · Магазин модов и ресурспаков (Modrinth).
 * Самодостаточный: сам встраивается в .stage, читает версию игры и загрузчик из #ver и #loader,
 * работает только когда body[data-mode="store"]. Все данные от сервера выводятся через textContent. */
(() => {
  "use strict";
  const L = window.launcher;
  const stage = document.querySelector(".stage");
  if (!L || !L.storeSearch || !stage) return;

  const KIND_LABEL = { mod: "модов", resourcepack: "ресурспаков" };
  const CATS = {
    mod: [["", "Все"], ["optimization", "Оптимизация"], ["utility", "Утилиты"], ["technology", "Технологии"], ["magic", "Магия"], ["adventure", "Приключения"], ["decoration", "Декор"], ["worldgen", "Генерация мира"], ["library", "Библиотеки"], ["storage", "Хранение"], ["mobs", "Мобы"]],
    resourcepack: [["", "Все"], ["16x", "16×"], ["32x", "32×"], ["64x", "64×"], ["realistic", "Реализм"], ["simplistic", "Минимализм"], ["vanilla-like", "Как ваниль"], ["themed", "Тематические"], ["gui", "Интерфейс"], ["audio", "Звук"]]
  };
  const CAT_RU = {};
  Object.values(CATS).flat().forEach(([k, v]) => { if (k) CAT_RU[k] = v; });
  Object.assign(CAT_RU, { adventure: "Приключения", cursed: "Проклятое", economy: "Экономика", equipment: "Снаряжение", food: "Еда", "game-mechanics": "Механики", management: "Управление", minigame: "Мини-игры", social: "Соцсети", transportation: "Транспорт", fabric: "Fabric", forge: "Forge", neoforge: "NeoForge", quilt: "Quilt" });

  // ---------- каркас ----------
  const root = document.createElement("section");
  root.className = "store"; root.id = "store";
  root.innerHTML = `
    <div class="st-head">
      <div class="st-seg" id="stSeg"><i class="st-ind" id="stInd"></i>
        <button type="button" class="on" data-k="mod">Моды</button>
        <button type="button" data-k="resourcepack">Ресурспаки</button>
        <button type="button" data-k="installed">Установлено<em id="stCount">0</em></button>
      </div>
      <label class="st-search" id="stSearchWrap">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
        <input id="stQ" type="text" placeholder="Поиск модов…" spellcheck="false" autocomplete="off">
      </label>
      <select id="stSort" aria-label="Сортировка">
        <option value="downloads">Популярные</option><option value="follows">Любимые</option><option value="newest">Новые</option><option value="updated">Обновлённые</option><option value="relevance">По запросу</option>
      </select>
      <button type="button" class="st-ghost" id="stFolder" title="Открыть папку профиля: можно положить свои файлы">Папка</button>
    </div>
    <div class="st-ctx">
      <span class="st-prof"><i></i><b id="stProf">—</b></span>
      <span class="st-switch on" id="stCompat" role="switch" aria-checked="true" tabindex="0"><i></i><span id="stCompatText">Только совместимое</span></span>
      <span class="st-total" id="stTotal"></span>
    </div>
    <div class="st-banner" id="stBanner" hidden>
      <span>Моды работают только с загрузчиком. Выбери Fabric или Forge в настройках, и профиль для модов создастся автоматически.</span>
      <button type="button" class="st-ghost" id="stToSettings">Открыть настройки</button>
    </div>
    <div class="st-chips" id="stChips"></div>
    <div class="st-scroll" id="stScroll"><div class="st-grid" id="stGrid"></div><div class="st-more" id="stMore"></div></div>
    <div class="st-toast" id="stToast" role="status"></div>
    <div class="st-modal" id="stModal" hidden><div class="st-dialog" id="stDialog"></div></div>`;
  stage.appendChild(root);

  const $ = (id) => document.getElementById(id);
  const el = { seg: $("stSeg"), ind: $("stInd"), count: $("stCount"), q: $("stQ"), sort: $("stSort"), folder: $("stFolder"), prof: $("stProf"), compat: $("stCompat"), compatText: $("stCompatText"), total: $("stTotal"), banner: $("stBanner"), chips: $("stChips"), scroll: $("stScroll"), grid: $("stGrid"), more: $("stMore"), toast: $("stToast"), modal: $("stModal"), dialog: $("stDialog") };

  // ---------- состояние ----------
  let kind = "mod", sort = "downloads", category = "", query = "", offset = 0, total = 0, loading = false, reqId = 0, hasMore = false, onlyCompat = true;
  let ctx = { mc: "", loader: "vanilla" };
  let installed = [];                         // список с диска для текущего профиля
  const busy = new Map();                     // projectId -> { pct, name }
  const armed = new Map();                    // projectId -> timeout: первый клик по «Установлено» просит подтверждение
  const cards = new Map();                    // projectId -> элементы кнопки
  const LIMIT = 24;

  const fmtNum = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1).replace(".0", "") + "M" : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e5 ? 0 : 1).replace(".0", "") + "K" : String(n));
  const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toFixed(1) + " МБ" : Math.max(1, Math.round(b / 1024)) + " КБ");
  const mk = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const readCtx = () => ({ mc: (document.getElementById("ver") || {}).value || "", loader: (document.getElementById("loader") || {}).value || "vanilla" });
  const isStore = () => document.body.dataset.mode === "store";
  const instById = (id) => installed.find((i) => i.projectId === id && i.kind === kind);
  const blocked = () => kind === "mod" && ctx.loader === "vanilla";
  const loaderName = (l) => ({ fabric: "Fabric", forge: "Forge", vanilla: "Vanilla" }[l] || l);

  let toastT = 0;
  function toast(msg, err) {
    el.toast.textContent = msg; el.toast.className = "st-toast show" + (err ? " err" : "");
    clearTimeout(toastT); toastT = setTimeout(() => { el.toast.className = "st-toast" + (err ? " err" : ""); }, err ? 5200 : 3400);
  }

  // ---------- иконка проекта ----------
  function iconBox(url, title, color, size) {
    const b = mk("div", "sc-icon"); if (size) b.style.cssText = `width:${size}px;height:${size}px;font-size:${Math.round(size * 0.38)}px`;
    if (color) b.style.setProperty("--c", color);
    const letter = (title || "?").trim().charAt(0).toUpperCase();
    if (url) {
      const img = new Image(); img.alt = ""; img.decoding = "async"; img.loading = "lazy";
      img.onerror = () => { img.remove(); b.textContent = letter; };
      img.src = url; b.appendChild(img);
    } else b.textContent = letter;
    return b;
  }

  // ---------- кнопка установки ----------
  function paintBtn(btn, id) {
    const b = busy.get(id), done = instById(id);
    btn.className = "sc-btn"; btn.disabled = false; btn.textContent = "";
    const fill = mk("i", "fill"); btn.appendChild(fill);
    const t = (cls, text) => btn.appendChild(mk("span", cls, text));
    if (b) { btn.classList.add("busy"); fill.style.setProperty("--p", Math.max(4, b.pct) + "%"); t("t", b.pct > 0 ? `${b.pct}%` : "Качаю…"); btn.title = b.name || ""; }
    else if (armed.has(id)) { btn.classList.add("confirm"); t("t", "Точно удалить?"); }
    else if (done) { btn.classList.add("done"); t("t t-ok", "✓ Установлено"); t("t t-del", "Удалить"); }
    else if (blocked()) { btn.classList.add("blocked"); t("t", "Нужен загрузчик"); }
    else t("t", "Установить");
  }
  function repaint(id) { const c = cards.get(id); if (c) paintBtn(c.btn, id); if (modalId === id) paintModalBtn(); }

  async function doInstall(hit) {
    if (blocked()) { toast("Для модов выбери Fabric или Forge в настройках", true); return; }
    if (busy.has(hit.id)) return;
    busy.set(hit.id, { pct: 0, name: hit.title }); repaint(hit.id);
    const r = await L.storeInstall({ projectId: hit.id, kind: hit.kind || kind, mc: ctx.mc, loader: ctx.loader, title: hit.title, icon: hit.icon, slug: hit.slug });
    busy.delete(hit.id);
    await loadInstalled();
    if (r && r.ok) {
      const main = r.installed.find((x) => !x.dependency), deps = r.installed.filter((x) => x.dependency).map((x) => x.title);
      toast(`Установлено: ${main ? main.title : hit.title}` + (deps.length ? ` · зависимости: ${deps.join(", ")}` : "") + (main && main.skipped ? " (уже была)" : ""));
    } else toast("Не вышло: " + ((r && r.error) || "неизвестная ошибка"), true);
    cards.forEach((_, id) => repaint(id));
  }
  async function doRemove(item) {
    const r = await L.storeRemove({ kind: item.kind, mc: ctx.mc, loader: ctx.loader, file: item.file });
    await loadInstalled();
    if (r && r.ok) toast(`Удалено: ${item.title}`); else toast("Не удалось удалить: " + ((r && r.error) || ""), true);
    cards.forEach((_, id) => repaint(id)); if (kind === "installed") renderInstalled();
  }
  function onBtn(hit) {
    const id = hit.id, done = instById(id);
    if (busy.has(id)) return;
    if (done) {
      if (armed.has(id)) { clearTimeout(armed.get(id)); armed.delete(id); doRemove(done); }
      else { armed.set(id, setTimeout(() => { armed.delete(id); repaint(id); }, 2600)); repaint(id); }
      return;
    }
    doInstall(hit);
  }

  // ---------- карточки ----------
  function card(hit, i) {
    const c = mk("article", "scard"); c.style.setProperty("--i", i % 24); if (hit.color) c.style.setProperty("--c", hit.color);
    const top = mk("div", "sc-top"); top.appendChild(iconBox(hit.icon, hit.title, hit.color));
    const tt = mk("div", "sc-title"); tt.appendChild(mk("h3", "", hit.title)); tt.appendChild(mk("span", "", "от " + hit.author)); top.appendChild(tt);
    c.appendChild(top);
    c.appendChild(mk("p", "sc-desc", hit.description));
    const tags = mk("div", "sc-tags"); (hit.categories || []).slice(0, 3).forEach((k) => tags.appendChild(mk("span", "st-tag", CAT_RU[k] || k))); c.appendChild(tags);
    const foot = mk("div", "sc-foot");
    foot.appendChild(stat("M12 3v12m0 0l-4.5-4.5M12 15l4.5-4.5M5 20h14", fmtNum(hit.downloads)));
    foot.appendChild(stat("M12 20s-7-4.6-7-10a4 4 0 017-2.6A4 4 0 0119 10c0 5.4-7 10-7 10z", fmtNum(hit.follows)));
    const btn = mk("button", "sc-btn"); btn.type = "button";
    btn.addEventListener("click", (e) => { e.stopPropagation(); onBtn(hit); });
    foot.appendChild(btn); c.appendChild(foot);
    cards.set(hit.id, { btn }); paintBtn(btn, hit.id);
    c.addEventListener("click", () => openModal(hit));
    return c;
  }
  function stat(path, text) {
    const s = mk("span", "sc-stat");
    s.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="${path}"/></svg>`;
    s.appendChild(document.createTextNode(text)); return s;
  }
  function skeletons(n) { for (let i = 0; i < n; i++) el.grid.appendChild(mk("div", "sk")); }
  function empty(text, sub, btnText, fn) {
    const e = mk("div", "st-empty"); const img = new Image(); img.src = "icon-small.svg"; img.alt = ""; e.appendChild(img);
    e.appendChild(mk("h4", "", text)); if (sub) e.appendChild(mk("p", "", sub));
    if (btnText) { const b = mk("button", "st-ghost", btnText); b.type = "button"; b.addEventListener("click", fn); e.appendChild(b); }
    el.grid.appendChild(e);
  }

  // ---------- загрузка списка ----------
  async function loadInstalled() {
    try { installed = await L.storeInstalled({ mc: ctx.mc, loader: ctx.loader }); } catch { installed = []; }
    el.count.textContent = String(installed.length); el.count.classList.toggle("has", installed.length > 0);
  }
  async function load(reset) {
    if (kind === "installed") return renderInstalled();
    if (loading && !reset) return;
    const my = ++reqId; loading = true;
    if (reset) { offset = 0; total = 0; cards.clear(); el.grid.textContent = ""; el.grid.classList.remove("list"); skeletons(9); el.total.textContent = ""; }
    try {
      const r = await L.storeSearch({ kind, query, mc: ctx.mc, loader: ctx.loader, sort: query && sort === "downloads" ? "relevance" : sort, category, offset, limit: LIMIT, onlyCompatible: onlyCompat });
      if (my !== reqId) return;
      if (reset) el.grid.textContent = "";
      el.grid.querySelectorAll(".sk").forEach((s) => s.remove());
      r.hits.forEach((h, i) => el.grid.appendChild(card(h, i)));
      offset += r.hits.length; total = r.total; hasMore = offset < total;
      el.total.textContent = total ? `Найдено ${total.toLocaleString("ru-RU")}` : "";
      if (!el.grid.children.length) empty("Ничего не нашлось", onlyCompat ? `Для ${ctx.mc} под ${loaderName(ctx.loader)} пусто. Попробуй выключить «Только совместимое».` : "Попробуй другой запрос.", onlyCompat ? "Показать всё" : "", () => setCompat(false));
    } catch (e) {
      if (my !== reqId) return;
      el.grid.textContent = ""; hasMore = false;
      empty("Магазин не отвечает", (e && e.message) || "Проверь интернет и повтори", "Повторить", () => load(true));
    } finally { if (my === reqId) loading = false; }
  }

  // ---------- вкладка «Установлено» ----------
  function renderInstalled() {
    reqId++; loading = false; hasMore = false; cards.clear(); el.grid.textContent = ""; el.grid.classList.add("list"); el.total.textContent = "";
    if (!installed.length) { empty("Здесь пока пусто", `Для профиля ${ctx.mc} · ${loaderName(ctx.loader)} ничего не установлено. Загляни в «Моды» или «Ресурспаки».`); return; }
    el.total.textContent = `${installed.length} шт. в профиле`;
    [["mod", "Моды"], ["resourcepack", "Ресурспаки"]].forEach(([k, name]) => {
      const items = installed.filter((x) => x.kind === k); if (!items.length) return;
      el.grid.appendChild(mk("div", "st-group", `${name} · ${items.length}`));
      items.forEach((it, i) => {
        const row = mk("div", "st-row"); row.style.setProperty("--i", i);
        row.appendChild(iconBox(it.icon, it.title, null, 40));
        const tx = mk("div", "sr-text"); tx.appendChild(mk("b", "", it.title));
        tx.appendChild(mk("span", "", [it.version, fmtSize(it.size), it.dependency ? "зависимость" : "", it.manual ? "добавлено вручную" : ""].filter(Boolean).join(" · "))); row.appendChild(tx);
        const del = mk("button", "sc-btn danger sr-del"); del.type = "button"; const lab = mk("span", "t", "Удалить"); del.appendChild(lab);
        del.addEventListener("click", () => { if (del.dataset.arm) { doRemove(it); } else { del.dataset.arm = "1"; del.classList.add("confirm"); lab.textContent = "Точно?"; setTimeout(() => { delete del.dataset.arm; del.classList.remove("confirm"); lab.textContent = "Удалить"; }, 2600); } });
        row.appendChild(del); el.grid.appendChild(row);
      });
    });
  }

  // ---------- окно «подробнее» ----------
  let modalId = null, modalHit = null;
  function paintModalBtn() { const b = el.dialog.querySelector(".sc-btn.md"); if (b && modalHit) paintBtn(b, modalHit.id); }
  async function openModal(hit) {
    modalId = hit.id; modalHit = hit;
    const d = el.dialog; d.textContent = "";
    const head = mk("div", "md-head"); head.appendChild(iconBox(hit.icon, hit.title, hit.color, 64));
    const ht = mk("div", "md-title"); ht.appendChild(mk("h3", "", hit.title)); ht.appendChild(mk("span", "", `от ${hit.author} · ${fmtNum(hit.downloads)} скачиваний`)); head.appendChild(ht);
    const x = mk("button", "md-x", "×"); x.type = "button"; x.setAttribute("aria-label", "Закрыть"); x.addEventListener("click", closeModal); head.appendChild(x);
    d.appendChild(head); d.appendChild(mk("p", "md-desc", hit.description));
    const tags = mk("div", "sc-tags"); (hit.categories || []).forEach((k) => tags.appendChild(mk("span", "st-tag", CAT_RU[k] || k))); d.appendChild(tags);
    const info = mk("div", "md-info"); info.appendChild(mk("div", "md-skel")); d.appendChild(info);
    const foot = mk("div", "md-foot");
    const link = mk("button", "st-ghost", "Открыть на Modrinth"); link.type = "button";
    link.addEventListener("click", () => window.open(`https://modrinth.com/${hit.kind === "resourcepack" ? "resourcepack" : "mod"}/${hit.slug}`, "_blank"));
    const btn = mk("button", "sc-btn md"); btn.type = "button"; btn.addEventListener("click", () => onBtn(hit));
    foot.appendChild(link); foot.appendChild(btn); d.appendChild(foot); paintBtn(btn, hit.id);
    el.modal.hidden = false; requestAnimationFrame(() => el.modal.classList.add("open"));
    try {
      const p = await L.storePreview({ projectId: hit.id, kind: hit.kind || kind, mc: ctx.mc, loader: ctx.loader });
      if (modalId !== hit.id) return;
      info.textContent = "";
      const row = (k, v) => { const r = mk("div", "md-row"); r.appendChild(mk("span", "", k)); r.appendChild(mk("b", "", v)); info.appendChild(r); };
      row("Будет установлено", `${p.versionNumber}${p.versionType && p.versionType !== "release" ? " · " + p.versionType : ""}`);
      row("Файл", `${p.filename} · ${fmtSize(p.size)}`);
      row("Профиль", `${ctx.mc} · ${loaderName(ctx.loader)}`);
      if (p.deps && p.deps.length) row("Нужно для работы", p.deps.join(", ") + " (поставится само)");
    } catch (e) {
      if (modalId !== hit.id) return;
      info.textContent = ""; const w = mk("div", "md-warn", (e && e.message ? e.message : "нет подходящей версии") + ". Попробуй другую версию игры."); info.appendChild(w);
    }
  }
  function closeModal() { el.modal.classList.remove("open"); setTimeout(() => { el.modal.hidden = true; modalId = null; modalHit = null; }, 180); }
  el.modal.addEventListener("click", (e) => { if (e.target === el.modal) closeModal(); });
  addEventListener("keydown", (e) => {
    if (!isStore()) return;
    if (e.key === "Escape" && !el.modal.hidden) closeModal();
    else if (e.key === "/" && el.modal.hidden && kind !== "installed" && document.activeElement !== el.q) { e.preventDefault(); el.q.focus(); }
  });

  // ---------- шапка, чипы, переключатели ----------
  function moveInd() {
    const on = el.seg.querySelector("button.on"); if (!on) return;
    el.ind.style.width = on.offsetWidth + "px"; el.ind.style.transform = `translateX(${on.offsetLeft}px)`;
  }
  function renderChips() {
    el.chips.textContent = ""; el.chips.hidden = kind === "installed";
    (CATS[kind] || []).forEach(([k, name]) => {
      const b = mk("button", "st-chip" + (k === category ? " on" : ""), name); b.type = "button";
      b.addEventListener("click", () => { category = k; renderChips(); load(true); }); el.chips.appendChild(b);
    });
  }
  function setKind(k) {
    if (k === kind) return;
    kind = k; category = ""; query = ""; el.q.value = "";
    el.seg.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b.dataset.k === k)); moveInd();
    const inst = k === "installed";
    el.q.placeholder = inst ? "" : `Поиск ${KIND_LABEL[k]}…`; el.q.parentNode.style.visibility = inst ? "hidden" : ""; el.sort.style.visibility = inst ? "hidden" : ""; el.compat.style.visibility = inst ? "hidden" : "";
    renderChips(); updateBanner(); load(true);
  }
  function setCompat(v) {
    onlyCompat = !!v; el.compat.classList.toggle("on", onlyCompat); el.compat.setAttribute("aria-checked", String(onlyCompat)); load(true);
  }
  function updateBanner() { el.banner.hidden = !(kind === "mod" && ctx.loader === "vanilla"); }
  function syncCtx(force) {
    const n = readCtx();
    if (!force && n.mc === ctx.mc && n.loader === ctx.loader) return false;
    ctx = n; el.prof.textContent = `${ctx.mc || "—"} · ${loaderName(ctx.loader)}`;
    el.compatText.textContent = ctx.mc ? `Только для ${ctx.mc}` : "Только совместимое";
    updateBanner(); return true;
  }

  el.seg.addEventListener("click", (e) => { const b = e.target.closest("button"); if (b) setKind(b.dataset.k); });
  let qT = 0;
  el.q.addEventListener("input", () => { clearTimeout(qT); qT = setTimeout(() => { query = el.q.value.trim(); load(true); }, 350); });
  el.sort.addEventListener("change", () => { sort = el.sort.value; load(true); });
  el.compat.addEventListener("click", () => setCompat(!onlyCompat));
  el.compat.addEventListener("keydown", (e) => { if (e.key === " " || e.key === "Enter") { e.preventDefault(); setCompat(!onlyCompat); } });
  el.folder.addEventListener("click", () => L.storeFolder({ kind: kind === "installed" ? "mod" : kind, mc: ctx.mc, loader: ctx.loader }));
  $("stToSettings").addEventListener("click", () => { const t = document.querySelector('.tab[data-target="settings"]'); if (t) t.click(); });
  if (L.on) L.on("store:progress", (p) => { const b = busy.get(p.projectId); if (!b) return; b.pct = p.pct; b.name = p.name; repaint(p.projectId); });

  // дозагрузка при прокрутке
  new IntersectionObserver((es) => { if (es[0].isIntersecting && hasMore && !loading && isStore() && kind !== "installed") load(false); }, { root: el.scroll, rootMargin: "320px" }).observe(el.more);

  // ---------- вход в магазин ----------
  let started = false;
  async function onEnter() {
    const changed = syncCtx(!started);
    if (!started) { started = true; renderChips(); moveInd(); await loadInstalled(); load(true); }
    else if (changed) { busy.clear(); await loadInstalled(); load(true); }
    if (window.Companion && window.Companion.setHome) window.Companion.setHome(() => ({ x: innerWidth - 84, y: innerHeight - 84 }));   // в магазине глаз «спит» в углу, а не над поиском
  }
  function onLeave() { if (window.Companion && window.Companion.setHome) window.Companion.setHome(null); }
  new MutationObserver(() => { if (isStore()) onEnter(); else onLeave(); }).observe(document.body, { attributes: true, attributeFilter: ["data-mode"] });
  setInterval(() => { if (isStore() && syncCtx(false)) { busy.clear(); loadInstalled().then(() => load(true)); } }, 900);   // версию и загрузчик меняют в настройках
  addEventListener("resize", moveInd);
  if (isStore()) onEnter();
})();
