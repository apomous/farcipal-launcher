/* FARCIPAL · кнопка обновления в шапке. Самомонтирующийся: ничего править в app.js не нужно.
 * Показывается, только когда обновление качается или готово к установке; версия лаунчера пишется рядом с брендом. */
(() => {
  "use strict";
  const L = window.launcher;
  const top = document.querySelector(".top-right");
  if (!L || !L.on || !L.updateState || !top) return;

  const st = document.createElement("style");
  st.textContent = `
  .upd { -webkit-app-region: no-drag; position: relative; z-index: 10; display: inline-flex; align-items: center; gap: 8px; height: 28px; padding: 0 12px; border-radius: 999px; border: 1px solid rgba(61,207,111,.45); background: rgba(61,207,111,.1); color: var(--green); font: 600 11px var(--sans); letter-spacing: .06em; cursor: pointer; transition: border-color .2s, background .2s, box-shadow .2s; white-space: nowrap; }
  .upd[hidden] { display: none; }
  .upd:hover, .upd:focus-visible { outline: 0; background: rgba(61,207,111,.18); box-shadow: 0 0 18px rgba(61,207,111,.3); }
  .upd i { width: 6px; height: 6px; border-radius: 50%; background: currentColor; animation: updPulse 1.4s ease-in-out infinite; }
  .upd.busy { border-color: rgba(232,180,90,.45); background: rgba(232,180,90,.08); color: var(--amber); cursor: progress; box-shadow: none; }
  .upd.warn { border-color: rgba(248,113,113,.45); background: rgba(248,113,113,.08); color: var(--red); }
  @keyframes updPulse { 50% { opacity: .25; } }
  @media (prefers-reduced-motion: reduce) { .upd i { animation: none; } }`;
  document.head.appendChild(st);

  const btn = document.createElement("button");
  btn.type = "button"; btn.className = "upd"; btn.hidden = true;
  top.insertBefore(btn, top.querySelector("wbtns"));

  if (L.appVersion) L.appVersion().then((v) => { const sub = document.querySelector(".brand-sub"); if (sub && v) sub.textContent = "launcher v" + v; }).catch(() => {});

  let cur = { state: "idle" }, warnT = 0;
  function render(s) {
    cur = s || cur;
    btn.classList.remove("busy", "warn"); btn.textContent = "";
    const dot = document.createElement("i"), t = document.createElement("span");
    if (cur.state === "downloading") { btn.classList.add("busy"); t.textContent = `Обновление ${cur.percent || 0}%`; btn.title = `Скачиваю версию ${cur.version || ""}`; btn.hidden = false; }
    else if (cur.state === "ready") { t.textContent = `Обновить до ${cur.version || "новой версии"}`; btn.title = "Перезапустить лаунчер и поставить обновление"; btn.hidden = false; }
    else { btn.hidden = true; return; }
    btn.appendChild(dot); btn.appendChild(t);
  }
  btn.addEventListener("click", async () => {
    if (cur.state !== "ready") return;
    const r = await L.updateInstall();
    if (r && r.reason === "game") {                      // игру не рвём
      btn.classList.add("warn"); btn.lastChild.textContent = "Сначала закрой игру";
      clearTimeout(warnT); warnT = setTimeout(() => render(), 3200);
    }
  });
  L.on("update:status", render);
  L.updateState().then(render).catch(() => {});
})();
