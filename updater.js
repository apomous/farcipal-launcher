// Автообновление через GitHub Releases (electron-updater).
// В разработке (npm start) выключено; в собранном .exe проверяет обновления при старте и раз в 4 часа,
// качает в фоне, ставит при закрытии лаунчера или по кнопке «Обновить» (кнопка не работает, пока идёт игра).
const { app, ipcMain } = require("electron");

function init({ send, log = () => {}, isGameRunning = () => false, intervalMs = 4 * 3600 * 1000, firstDelayMs = 8000, allowPrerelease = true } = {}) {
  let state = { state: "idle" };
  const set = (s) => { state = s; try { send("update:status", s); } catch {} };

  ipcMain.handle("update:state", () => state);
  ipcMain.handle("app:version", () => app.getVersion());

  if (!app.isPackaged) {                                // npm start: обновлять нечего
    log("updater: режим разработки, обновления выключены");
    ipcMain.handle("update:check", async () => ({ ok: false, reason: "dev" }));
    ipcMain.handle("update:install", async () => ({ ok: false, reason: "dev" }));
    return { check: async () => {} };
  }

  const { autoUpdater } = require("electron-updater");
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;              // не нажал кнопку: поставится при закрытии
  autoUpdater.allowPrerelease = allowPrerelease;        // пока релизы помечаешь «Pre-release», друзья их тоже видят
  autoUpdater.logger = { info: (m) => log("updater: " + m), warn: (m) => log("updater: " + m), error: (m) => log("updater: " + m), debug() {} };

  autoUpdater.on("checking-for-update", () => { if (state.state !== "downloading" && state.state !== "ready") set({ state: "checking" }); });
  autoUpdater.on("update-available", (i) => set({ state: "downloading", version: i && i.version, percent: 0 }));
  autoUpdater.on("update-not-available", () => { if (state.state !== "ready") set({ state: "none" }); });
  autoUpdater.on("download-progress", (p) => set({ state: "downloading", version: state.version, percent: Math.round((p && p.percent) || 0) }));
  autoUpdater.on("update-downloaded", (i) => set({ state: "ready", version: (i && i.version) || state.version }));
  autoUpdater.on("error", (e) => { log("updater: ошибка " + ((e && e.message) || e)); if (state.state !== "ready") set({ state: "error", message: (e && e.message) || String(e) }); });

  let checking = false;
  async function check() {
    if (checking || state.state === "downloading" || state.state === "ready") return;   // уже качаем или всё скачано
    checking = true;
    try { await autoUpdater.checkForUpdates(); }
    catch (e) { log("updater: проверка не удалась: " + ((e && e.message) || e)); set({ state: "error", message: (e && e.message) || String(e) }); }   // нет интернета: тихо, повторим позже
    finally { checking = false; }
  }

  ipcMain.handle("update:check", async () => { await check(); return { ok: true }; });
  ipcMain.handle("update:install", async () => {
    if (state.state !== "ready") return { ok: false, reason: "not-ready" };
    if (isGameRunning()) return { ok: false, reason: "game" };           // игру не рвём: поставится после закрытия лаунчера
    setImmediate(() => autoUpdater.quitAndInstall(true, true));          // тихая установка и перезапуск
    return { ok: true };
  });

  const t1 = setTimeout(check, firstDelayMs), t2 = setInterval(check, intervalMs);
  if (t1.unref) t1.unref(); if (t2.unref) t2.unref();
  return { check };
}

module.exports = { init };
