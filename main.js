const { app, BrowserWindow, ipcMain, shell, safeStorage } = require("electron");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const { Auth } = require("msmc");
const config = require("./config");
const loaders = require("./loaders");
const modrinth = require("./modrinth");
const discord = require("./discord");
const { installAndLaunch } = require("./game");



const MANIFEST = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json";
const gameDir = path.join(app.getPath("appData"), config.gameDirName);
const settingsFile = path.join(app.getPath("userData"), "settings.json");
const authFile = path.join(app.getPath("userData"), "auth.json");
const launchLog = path.join(gameDir, "launcher-last.log");   // полный журнал последнего запуска: его можно прислать при проблемах

let win = null;
let game = null; // { proc, cancel } пока игра устанавливается, запускается или работает

// ---------- файлы настроек ----------
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}
// ---------- безопасное сохранение токена ----------
function saveAuth(data) {
  if (!safeStorage.isEncryptionAvailable()) {
    console.warn("⚠️ Шифрование недоступно. Сохраняю в открытом виде.");
    return writeJson(authFile, data);
  }
  const encrypted = safeStorage.encryptString(JSON.stringify(data));
  fs.writeFileSync(authFile, encrypted);
}

function loadAuth() {
  if (!fs.existsSync(authFile)) return null;
  try {
    const data = fs.readFileSync(authFile);
    // Если файл уже был зашифрован safeStorage
    if (safeStorage.isEncryptionAvailable()) {
      // Проверка на старый формат (открытый JSON), чтобы не сломать вход у тех, кто уже авторизовался
      if (data.toString().startsWith('{')) {
        return JSON.parse(data.toString());
      }
      const decrypted = safeStorage.decryptString(data);
      return JSON.parse(decrypted);
    }
    return JSON.parse(data.toString());
  } catch (e) {
    console.error("Ошибка загрузки auth:", e);
    return null;
  }
}
const defaults = { memory: 4, version: "", snapshots: false, joinServer: false, demoName: "", loaderType: "vanilla", loaderVersion: "", discord: true };
const getSettings = () => ({ ...defaults, ...readJson(settingsFile, {}) });

// ---------- окно ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 900,
    minHeight: 640,
    frame: false,
    backgroundColor: "#09090f",
    title: config.name,
    icon: path.join(__dirname, "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });
  win.setMenu(null);
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
}

app.whenReady().then(() => {
  createWindow();
// статус в Discord: нужен Application ID в config.js (discordClientId), включается переключателем в настройках
discord.init({ clientId: config.discordClientId, enabled: getSettings().discord !== false, brand: "Farcipal" });
});
app.on("before-quit", () => discord.destroy());
app.on("window-all-closed", () => app.quit());

ipcMain.on("win:min", () => win && win.minimize());
ipcMain.on("win:close", () => win && win.close());

// ---------- конфиг, настройки ----------
ipcMain.handle("config:get", () => ({
  name: config.name,
  server: config.server,
  news: config.news,
  gameDir
}));
ipcMain.handle("settings:get", () => getSettings());
ipcMain.handle("settings:set", (_e, s) => {
  const next = { ...getSettings(), ...s };
  writeJson(settingsFile, next);
  discord.setEnabled(next.discord !== false);
  return next;
});

// ---------- версии игры (Mojang) ----------
ipcMain.handle("versions:list", async () => {
  const res = await fetch(MANIFEST, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error("Манифест версий недоступен: HTTP " + res.status);
  const data = await res.json();
  return {
    latest: data.latest,
    versions: data.versions.map((v) => ({ id: v.id, type: v.type }))
  };
});

// ---------- загрузчики: какие версии игры поддерживаются и какие версии загрузчика доступны ----------
ipcMain.handle("loader:games", async (_e, type) => {
  if (type === "fabric") return loaders.fabricGames();
  if (type === "forge") return loaders.forgeGames();
  return [];
});
ipcMain.handle("loader:versions", async (_e, { type, mc }) => {
  if (type === "fabric") return loaders.fabricLoaders(mc);
  if (type === "forge") return loaders.forgeVersions(mc);
  return { items: [], recommended: null };
});

// ---------- вход через Microsoft ----------
let mcToken = null; // токен msmc текущей сессии

function describeToken(token) {
  const p = token.profile || {};
  return { name: p.name || "игрок", demo: !!p.demo };
}

ipcMain.handle("auth:session", async () => {
  const saved = loadAuth();
  if (!saved) return null;
  try {
    const authManager = new Auth("select_account");
    const xbox = await authManager.refresh(saved);
    mcToken = await xbox.getMinecraft();
    saveAuth(xbox.save());
    return describeToken(mcToken);
  } catch {
    return null; // сессия протухла: нужен новый вход
  }
});

ipcMain.handle("auth:microsoft", async () => {
  const authManager = new Auth("select_account");
  const xbox = await authManager.launch("electron");
  mcToken = await xbox.getMinecraft();
  saveAuth(xbox.save());
  return describeToken(mcToken);
});

ipcMain.handle("auth:logout", () => {
  mcToken = null;
  try { fs.unlinkSync(authFile); } catch {}
  return true;
});

// ---------- профиль для запуска ----------
// стандартный offline-UUID Minecraft: md5("OfflinePlayer:<ник>") с версией 3
function offlineUUID(name) {
  const h = crypto.createHash("md5").update("OfflinePlayer:" + name).digest();
  h[6] = (h[6] & 0x0f) | 0x30; h[8] = (h[8] & 0x3f) | 0x80;
  const x = h.toString("hex");
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

function buildAuth(mode, name) {
  if (mode === "microsoft") {
    if (!mcToken) throw new Error("Сначала войди через Microsoft");
    const a = mcToken.mclc();                       // { access_token, uuid, name, ... }
    return {
      profile: { id: a.uuid, name: a.name },
      accessToken: a.access_token,
      userType: "msa",
      demo: !!(mcToken.profile && mcToken.profile.demo)   // аккаунт без купленной игры: демо-режим
    };
  }
  // демо без аккаунта: флаг --demo, ограничение накладывает сам клиент Mojang
  const nick = (name || "").trim();
  if (!/^[A-Za-z0-9_]{3,16}$/.test(nick)) throw new Error("Ник: 3–16 символов, латиница, цифры и _");
  return { profile: { id: offlineUUID(nick), name: nick }, accessToken: "0", userType: "legacy", demo: false };
}

// ---------- запуск ----------
const send = (ch, data) => win && !win.isDestroyed() && win.webContents.send(ch, data);

// магазин модов и ресурспаков: IPC store:* живёт в modrinth.js
modrinth.register(ipcMain, { gameDir, shell, send });

ipcMain.handle("game:play", async (_e, opts) => {
  if (game) return { ok: false, error: "Игра уже запущена" };
  const { version, loaderType = "vanilla", loaderVersion = "", memory, mode, name, joinServer, concurrency = 4 } = opts;

  let auth;
  try { auth = buildAuth(mode, name); } catch (e) { return { ok: false, error: e.message }; }

  const log = (m) => { send("game:log", { text: String(m) }); try { fs.appendFileSync(launchLog, m + "\n"); } catch {} };
  try { fs.mkdirSync(gameDir, { recursive: true }); fs.writeFileSync(launchLog, `# ${new Date().toISOString()} ${version} ${loaderType} ${loaderVersion}\n`); } catch {}

  game = { proc: null, cancel: { cancelled: false, task: null } };   // занимаем слот: двойной запуск невозможен; cancel — для кнопки «Остановить»
  try {
    const { proc, versionId } = await installAndLaunch(
      {
        gameDir, mcVersion: version, loaderType, loaderVersion, memoryGB: memory, auth,
        server: joinServer && config.server.host ? { host: config.server.host, port: config.server.port } : null,
        concurrency
      },
      { log, progress: (p) => send("game:progress", p), state: (s) => send("game:state", { state: s }), cancel: game.cancel }
    );
    game.proc = proc;

    const onLine = (chunk) => {
      const t = String(chunk).replace(/\r/g, "").trimEnd();
      if (!t) return;
      try { fs.appendFileSync(launchLog, t + "\n"); } catch {}
      for (const line of t.split("\n")) send("game:log", { text: line.slice(0, 200), game: true });
    };
    proc.stdout && proc.stdout.on("data", onLine);
    proc.stderr && proc.stderr.on("data", onLine);
    proc.on("error", (e) => { game = null; discord.clear(); log("не удалось запустить Java: " + e.message); send("game:state", { state: "error", code: -1 }); });
    proc.on("close", (code) => {
      discord.clear();
      const byUser = !!(game && game.cancel.cancelled);   // закрыли кнопкой «Остановить»: это не сбой
      game = null;
      const c = (code === null ? -1 : code) | 0;      // 4294967289 -> -7: показываем знаковое значение
      send("game:state", { state: c === 0 || byUser ? "stopped" : "error", code: c });
    });
    send("game:state", { state: "running" });
    log(`версия ${versionId} запущена`);
    // «играет в Minecraft 1.21.4 • Farcipal»; на сервере показываем название из config, не адрес
    discord.playing({ mc: version, loaderType, loaderVersion, server: joinServer && config.server.host ? (config.server.name || null) : null });
    return { ok: true };
  } catch (e) {
    const cancelled = !!((e && e.cancelled) || (game && game.cancel.cancelled));
    game = null;
    if (cancelled) { log("запуск отменён"); return { ok: false, cancelled: true }; }
    const msg = (e && e.message) || String(e);
    try { fs.appendFileSync(launchLog, "ОШИБКА: " + (e && e.stack || msg) + "\n"); } catch {}
    return { ok: false, error: msg };
  }
});

ipcMain.handle("game:stop", () => {
  if (!game) return true;
  game.cancel.cancelled = true;                         // установка остановится на ближайшей границе этапа
  try { if (game.cancel.task && game.cancel.task.cancel) game.cancel.task.cancel(); } catch {}   // и скачивание прервётся сразу
  if (game.proc) game.proc.kill();
  return true;
});
