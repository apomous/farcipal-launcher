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
const { createHostInElectron, manageSessions, createGuestInElectron } = require('mc-tunnel/electron');
const zlib = require('zlib');
const { fetch } = require('undici');
const { farcipalAgent } = require('./network');
const { spawn } = require("child_process");

function getEasytierBinDir() {
  if (app.isPackaged) {
    // В собранном приложении (resources/easytier)
    return path.join(process.resourcesPath, 'easytier');
  } else {
    // В режиме разработки (vendor/easytier)
    return path.join(__dirname, 'vendor', 'easytier');
  }
}
const EASYTIER_NODES = [
  'tcp://public.easytier.cn:11010',
  'udp://public.easytier.cn:11010'
];

const MANIFEST = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json";
const gameDir = path.join(app.getPath("appData"), config.gameDirName);
const settingsFile = path.join(app.getPath("userData"), "settings.json");
const authFile = path.join(app.getPath("userData"), "auth.json");
const launchLog = path.join(gameDir, "launcher-last.log");   // полный журнал последнего запуска: его можно прислать при проблемах

let win = null;
let game = null;
const appAbortController = new AbortController();
const send = (ch, data) => win && !win.isDestroyed() && win.webContents.send(ch, data); // { proc, cancel } пока игра устанавливается, запускается или работает

// ---------- файлы настроек ----------
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);   // краш посреди записи больше не убивает конфиг
}
const SAFE_ID = /^[A-Za-z0-9._-]+$/;
const badId = (s) => typeof s !== "string" || !SAFE_ID.test(s) || s.includes("..");
function saveAuth(data) {
  let buf;
  if (safeStorage.isEncryptionAvailable()) {
    buf = safeStorage.encryptString(JSON.stringify(data));
  } else {
    console.warn("⚠️ Шифрование недоступно. Сохраняю в открытом виде.");
    buf = Buffer.from(JSON.stringify(data));
  }
  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  fs.writeFileSync(authFile + ".tmp", buf);
  fs.renameSync(authFile + ".tmp", authFile);
}

function loadAuth() {
  if (!fs.existsSync(authFile)) return null;
  try {
    const data = fs.readFileSync(authFile);
    if (safeStorage.isEncryptionAvailable()) {
      try {
        const decrypted = safeStorage.decryptString(data);
        return JSON.parse(decrypted);
      } catch (decryptError) {
        // Если расшифровка не удалась, возможно, это старый plaintext-формат
        try {
          return JSON.parse(data.toString());
        } catch (parseError) {
          console.error("Не удалось прочитать auth ни как зашифрованный, ни как plaintext:", parseError);
          return null;
        }
      }
    }
    // Если шифрование недоступно, читаем как есть
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

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win && !win.isDestroyed()) { if (win.isMinimized()) win.restore(); win.focus(); }
  });
  app.whenReady().then(() => {
    createWindow();
    const updater = require("./updater");
    updater.init({ send, log: console.log, isGameRunning: () => !!game });
    discord.init({ clientId: config.discordClientId, enabled: getSettings().discord !== false, brand: "Farcipal" });
  });
}
app.on("before-quit", () => {
  appAbortController.abort(); 
  discord.destroy();
});
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
  next.memory = Math.max(1, Math.min(32, Number(next.memory) || 4));
  const c = Number(next.concurrency);
  next.concurrency = Number.isFinite(c) ? Math.max(0, Math.min(64, c)) : 4;
  writeJson(settingsFile, next);
  discord.setEnabled(next.discord !== false);
  return next;
});

// ---------- версии игры (Mojang) ----------
ipcMain.handle("versions:list", async () => {
  const res = await fetch(MANIFEST, { dispatcher: farcipalAgent, signal: AbortSignal.timeout(20000) });
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

// магазин модов и ресурспаков: IPC store:* живёт в modrinth.js
modrinth.register(ipcMain, { gameDir, shell, send, signal: appAbortController.signal });

ipcMain.handle("game:play", async (_e, opts) => {
  if (game) return { ok: false, error: "Игра уже запущена" };
  let { version, loaderType = "vanilla", loaderVersion = "", memory, mode, name, joinServer, concurrency = 4 } = opts;
  if (badId(version)) return { ok: false, error: "Некорректная версия игры" };
  if (loaderVersion && badId(loaderVersion)) return { ok: false, error: "Некорректная версия загрузчика" };
  if (!["vanilla", "fabric", "forge"].includes(loaderType)) return { ok: false, error: "Неизвестный загрузчик" };
  memory = Math.max(1, Math.min(32, Number(memory) || 4));

  let auth;
  try { auth = buildAuth(mode, name); } catch (e) { return { ok: false, error: e.message }; }

  const log = (m) => { send("game:log", { text: String(m) }); try { fs.appendFileSync(launchLog, m + "\n"); } catch {} };
  try { fs.mkdirSync(gameDir, { recursive: true }); fs.writeFileSync(launchLog, `# ${new Date().toISOString()} ${version} ${loaderType} ${loaderVersion}\n`); } catch {}

  game = { proc: null, cancel: { cancelled: false, task: null }, abortController: new AbortController() };   // занимаем слот: двойной запуск невозможен; cancel — для кнопки «Остановить»
  try {
    const { proc, versionId } = await installAndLaunch(
      {
        gameDir, mcVersion: version, loaderType, loaderVersion, memoryGB: memory, auth,
        server: joinServer && config.server.host ? { host: config.server.host, port: config.server.port } : null,
        concurrency,
        signal: game.abortController.signal
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
      if (proc.stdout) proc.stdout.removeAllListeners("data");
      if (proc.stderr) proc.stderr.removeAllListeners("data");
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

function killTree(proc) {
  if (!proc || !proc.pid) return;
  try {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { windowsHide: true });
    else proc.kill("SIGKILL");
  } catch { try { proc.kill(); } catch {} }
}

ipcMain.handle("game:stop", () => {
  if (!game) return true;
  game.cancel.cancelled = true;
  if (game.abortController) game.abortController.abort();
  try { if (game.cancel.task && game.cancel.task.cancel) game.cancel.task.cancel(); } catch {}
  killTree(game.proc);   // добиваем и дочернюю Java установщика Forge
  return true;
});

const NEWS_URL = "https://raw.githubusercontent.com/apomous/farcipal-launcher/main/news.json";

ipcMain.handle("news:get", async () => {
  try {
    // Таймаут 5 секунд, чтобы не вешать лаунчер, если гитхаб лежит
    const res = await fetch(NEWS_URL, { dispatcher: farcipalAgent, signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    if (Array.isArray(data) && data.length > 0) return data;
    throw new Error("Пустой ответ");
  } catch (e) {
    console.warn("Не удалось загрузить новости:", e.message);
    // Фолбэк: если сети нет, берем новости из config.js
    return config.news || [];
  }
});

let tunnelSession = null;
let tunnelBusy = false;   // синхронный замок: проверка ДО первого await

ipcMain.handle('tunnel:host', async (_e, playerName) => {
  if (tunnelSession || tunnelBusy) return { ok: false, error: 'Сессия уже запущена' };
  tunnelBusy = true;
  try {
     const host = await createHostInElectron(app, {
  playerName: String(playerName || 'Host').slice(0, 32),
  easyTier: {
    binDir: getEasytierBinDir(),
    publicNodes: EASYTIER_NODES,   // точка встречи: без неё узлы не найдут друг друга
    p2pOnly: false                 // разрешаем relay — при двух Symmetric NAT это единственный путь
  }
});
    tunnelSession = host;
    manageSessions(app, host);
    send('tunnel:code', host.roomCode);
    host.on('player-join', (p) => send('tunnel:player-join', p.name));
    host.on('player-leave', (p) => send('tunnel:player-leave', p.name));
    host.on('error', (e) => send('tunnel:error', e.message));
    return { ok: true, roomCode: host.roomCode };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally { tunnelBusy = false; }
});

ipcMain.handle('tunnel:join', async (_e, roomCode, playerName) => {
  if (tunnelSession || tunnelBusy) return { ok: false, error: 'Сессия уже запущена' };
  tunnelBusy = true;
  try {
    const guest = await createGuestInElectron(app, {
  roomCode: String(roomCode || '').trim(),
  playerName: String(playerName || 'Guest').slice(0, 32),
  easyTier: {
    binDir: getEasytierBinDir(),
    publicNodes: EASYTIER_NODES,
    p2pOnly: false
  }
});
    tunnelSession = guest;
    manageSessions(app, guest);
    return { ok: true, address: guest.address };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally { tunnelBusy = false; }
});

ipcMain.handle('tunnel:close', async () => {
  if (!tunnelSession) return { ok: true };
  tunnelBusy = true;
  const s = tunnelSession;
  tunnelSession = null;
  try {
    await Promise.race([
      s.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Таймаут закрытия")), 3000))
    ]);
  } catch (e) {
    console.error("Ошибка при закрытии сессии:", e);
  } finally { tunnelBusy = false; }
  send('tunnel:closed');
  return { ok: true };
});

ipcMain.handle("modpack:export", (_e, { mc, loader }) => {
  if (badId(mc) || !["vanilla", "fabric", "forge"].includes(loader)) throw new Error("Некорректный профиль");
  const manifest = modrinth.exportInstance(gameDir, mc, loader);
  return zlib.deflateSync(JSON.stringify(manifest)).toString("base64");
});

ipcMain.handle("modpack:import", async (_e, { mc, loader, code }) => {
  try {
    if (badId(mc) || !["vanilla", "fabric", "forge"].includes(loader)) throw new Error("Некорректный профиль");
    if (typeof code !== "string" || code.length > 200000) throw new Error("Код сборки повреждён или слишком большой");
    // maxOutputLength — защита от zip-бомбы из буфера обмена
    const json = zlib.inflateSync(Buffer.from(code, "base64"), { maxOutputLength: 1000000 }).toString("utf8");
    const manifest = JSON.parse(json);
    if (!manifest || !Array.isArray(manifest.items) || manifest.items.length > 500) throw new Error("Некорректный манифест сборки");
    for (const it of manifest.items) {
      if (!it || !["mod", "resourcepack"].includes(it.kind) ||
          typeof it.projectId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(it.projectId)) {
        throw new Error("Некорректный элемент сборки");
      }
    }
    await modrinth.importInstance(gameDir, mc, loader, manifest, (p) => {
      send("game:log", { text: `Скачивание сборки: ${p.task}/${p.total}` });
    }, appAbortController.signal);
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});


