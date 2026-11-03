// Discord Rich Presence без зависимостей: говорим с локальным Discord по IPC (именованный канал / unix-сокет).
// Статус показывается, только пока идёт игра. Discord не запущен или упал: тихо переподключаемся.
const net = require("net");
const path = require("path");
const crypto = require("crypto");

const OP = { HANDSHAKE: 0, FRAME: 1, CLOSE: 2, PING: 3, PONG: 4 };

// Тексты и вид статуса меняются здесь (или через configure)
const cfg = {
  clientId: "",                      // Application ID из discord.com/developers/applications
  brand: "Farcipal",
  largeImage: "farcipal",            // ключ картинки из Rich Presence → Art Assets
  statusDisplayType: 2,              // 0 = имя приложения, 1 = state, 2 = details: в списке участников «Playing <details>»
  button: { label: "Скачать лаунчер", url: "https://github.com/apomous/farsipal-launcher" },   // null = без кнопки
  showIdle: true,                   // показывать «В лаунчере», пока игра не запущена
  retryMs: 15000,
  paths: null,                       // для тестов: свои пути к каналу
  log: () => {}
};
const configure = (o) => Object.assign(cfg, o);

const LOADER = { fabric: "Fabric", forge: "Forge", neoforge: "NeoForge", quilt: "Quilt" };
const clip = (s, n) => { s = String(s); return s.length > n ? s.slice(0, n - 1) + "…" : s; };
const two = (s) => (String(s).length < 2 ? String(s) + " " : String(s));      // Discord отвергает строки короче 2 символов

// info: { mc, loaderType, loaderVersion, server, startedAt }
function buildActivity(info) {
  const loader = LOADER[info.loaderType] || "";
  const details = `Minecraft ${info.mc}`;                      // «Minecraft 1.21.4 • Farcipal»
  const state = info.server ? `На сервере ${info.server}` : loader ? `${loader}${info.loaderVersion ? " " + info.loaderVersion : ""}` : "Ванильная игра";
  const a = {
    type: 0,
    status_display_type: cfg.statusDisplayType,
    details: clip(two(details), 128),
    state: clip(two(state), 128),
    timestamps: { start: info.startedAt || Date.now() },
    assets: { large_image: cfg.largeImage, large_text: `${cfg.brand} Launcher` },
    instance: true
  };
  if (loader) { a.assets.small_image = info.loaderType; a.assets.small_text = clip(two(loader), 128); }
  if (cfg.button && cfg.button.url) a.buttons = [{ label: clip(cfg.button.label, 32), url: cfg.button.url }];
  return a;
}

// ---------- соединение ----------
let enabled = false, sock = null, ready = false, connecting = false, buf = Buffer.alloc(0), current = null, timer = 0, sendT = 0, stopped = false;

function pipePaths() {
  if (cfg.paths) return cfg.paths;
  const out = [];
  for (let i = 0; i < 10; i++) {
    if (process.platform === "win32") out.push(`\\\\?\\pipe\\discord-ipc-${i}`);
    else {
      const base = process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || "/tmp";
      out.push(path.join(base, `discord-ipc-${i}`));
      if (process.env.XDG_RUNTIME_DIR) out.push(path.join(base, "app/com.discordapp.Discord", `discord-ipc-${i}`), path.join(base, "snap.discord", `discord-ipc-${i}`));
    }
  }
  return out;
}
function tryConnect(p) {
  return new Promise((res) => {
    const s = net.createConnection(p), t = setTimeout(() => { s.destroy(); res(null); }, 1500);
    s.once("connect", () => { clearTimeout(t); s.removeAllListeners("error"); res(s); });
    s.once("error", () => { clearTimeout(t); res(null); });
  });
}
const frame = (op, obj) => { const d = Buffer.from(JSON.stringify(obj), "utf8"), h = Buffer.alloc(8); h.writeInt32LE(op, 0); h.writeInt32LE(d.length, 4); return Buffer.concat([h, d]); };
const send = (op, obj) => { if (sock && !sock.destroyed) sock.write(frame(op, obj)); };

function schedule(ms) {
  clearTimeout(timer);
  if (!enabled || stopped || !cfg.clientId) return;
  timer = setTimeout(connect, ms == null ? cfg.retryMs : ms);
}
async function connect() {
  if (connecting || ready || !enabled || stopped || !cfg.clientId) return;
  connecting = true;
  let s = null;
  for (const p of pipePaths()) { s = await tryConnect(p); if (s) break; }
  connecting = false;
  if (!s) return schedule();                                    // Discord не запущен: попробуем позже
  if (!enabled) { s.destroy(); return; }
  sock = s; buf = Buffer.alloc(0); ready = false;
  s.on("data", onData);
  s.on("close", () => { if (sock === s) { sock = null; ready = false; cfg.log("discord: канал закрыт"); schedule(); } });
  s.on("error", () => {});
  send(OP.HANDSHAKE, { v: 1, client_id: cfg.clientId });
}
function onData(d) {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 8) {
    const op = buf.readInt32LE(0), len = buf.readInt32LE(4);
    if (len < 0 || len > 1 << 20) { sock && sock.destroy(); return; }
    if (buf.length < 8 + len) return;                           // кадр пришёл не целиком: ждём остальное
    let msg = null; try { msg = JSON.parse(buf.slice(8, 8 + len).toString("utf8")); } catch {}
    buf = buf.slice(8 + len);
    handle(op, msg);
  }
}
function handle(op, msg) {
  if (op === OP.PING) return send(OP.PONG, msg || {});
  if (op === OP.CLOSE) { cfg.log("discord: CLOSE " + JSON.stringify(msg)); if (msg && msg.code === 4000) stopped = true; sock && sock.destroy(); return; }   // 4000: неверный client id, не долбим
  if (!msg) return;
  if (msg.evt === "READY") { ready = true; cfg.log("discord: готов"); flush(); }
  else if (msg.evt === "ERROR") { cfg.log("discord: ошибка " + JSON.stringify(msg.data)); if (msg.data && msg.data.code === 4000) stopped = true; }
}
function flush() {
  if (!ready) return;
  send(OP.FRAME, { cmd: "SET_ACTIVITY", args: { pid: process.pid, activity: current }, nonce: crypto.randomUUID() });
}
// слияние частых обновлений в одно (Discord ограничивает частоту)
function push() { clearTimeout(sendT); sendT = setTimeout(flush, 250); if (!sock && !connecting) schedule(0); }

// ---------- публичный API ----------
function init(o) {
  configure(o || {});
  stopped = false; enabled = o.enabled !== false && !!cfg.clientId;
  if (enabled) schedule(0);
  if (enabled && cfg.showIdle) current = { type: 0, details: two("В лаунчере"), state: two(cfg.brand), assets: { large_image: cfg.largeImage }, timestamps: { start: Date.now() } };
}
function playing(info) { current = buildActivity(info); if (enabled) push(); }
function clear() { current = enabled && cfg.showIdle ? { type: 0, details: two("В лаунчере"), state: two(cfg.brand), assets: { large_image: cfg.largeImage }, timestamps: { start: Date.now() } } : null; if (enabled) push(); }
function setEnabled(v) {
  v = !!v && !!cfg.clientId;
  if (v === enabled) return;
  enabled = v;
  if (v) { stopped = false; schedule(0); if (current) push(); }
  else { clearTimeout(timer); const hadSock = sock; if (hadSock && ready) { send(OP.FRAME, { cmd: "SET_ACTIVITY", args: { pid: process.pid, activity: null }, nonce: crypto.randomUUID() }); setTimeout(() => hadSock.destroy(), 150); } else if (hadSock) hadSock.destroy(); }
}
function destroy() {
  clearTimeout(timer); clearTimeout(sendT); enabled = false;
  const s = sock; sock = null; ready = false;
  if (s && !s.destroyed) { try { s.write(frame(OP.FRAME, { cmd: "SET_ACTIVITY", args: { pid: process.pid, activity: null }, nonce: crypto.randomUUID() })); } catch {} setTimeout(() => s.destroy(), 100); }
}
const _state = () => ({ enabled, ready, connected: !!sock, stopped });

module.exports = { init, playing, clear, setEnabled, destroy, configure, buildActivity, _state };
