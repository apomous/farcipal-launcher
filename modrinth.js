// Магазин модов и ресурспаков: клиент Modrinth + установка в папку профиля. Только Node (без Electron), поэтому тестируется отдельно.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const loaders = require("./loaders");

const cfg = {
  api: "https://api.modrinth.com/v2",
  cdnHosts: ["cdn.modrinth.com"],        // качаем только отсюда, даже если API вернёт что-то другое
  allowHttp: false,
  ua: "apomous/farcipal-launcher/0.1 (github.com/apomous/farsipal-launcher)"
};
const configure = (o) => Object.assign(cfg, o);

const KINDS = {
  mod: { folder: "mods", ext: ".jar" },
  resourcepack: { folder: "resourcepacks", ext: ".zip" }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- API ----------
async function api(pathAndQuery, tries = 3) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(cfg.api + pathAndQuery, { headers: { "User-Agent": cfg.ua, Accept: "application/json" }, signal: AbortSignal.timeout(20000) });
      if (res.status === 429) { await sleep((Number(res.headers.get("retry-after")) || 2) * 1000); throw new Error("HTTP 429"); }
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.json();
    } catch (e) { last = e; await sleep(350 * (i + 1)); }
  }
  throw new Error("Modrinth недоступен: " + (last && last.message ? last.message : last));
}

const infoCache = new Map();
async function projectInfo(id) {
  if (!infoCache.has(id)) infoCache.set(id, api(`/project/${encodeURIComponent(id)}`).then((p) => ({ id: p.id, slug: p.slug, title: p.title, icon: p.icon_url || "", type: p.project_type })).catch((e) => { infoCache.delete(id); throw e; }));
  return infoCache.get(id);
}

const hex = (n) => (typeof n === "number" ? "#" + (n & 0xffffff).toString(16).padStart(6, "0") : null);

async function search({ kind = "mod", query = "", mc = "", loader = "", sort = "downloads", category = "", offset = 0, limit = 24, onlyCompatible = true }) {
  const facets = [[`project_type:${kind}`]];
  if (mc && onlyCompatible) facets.push([`versions:${mc}`]);
  if (kind === "mod" && loader && loader !== "vanilla") facets.push([`categories:${loader}`]);
  if (kind === "mod") facets.push(["client_side:required", "client_side:optional"]);   // серверные моды клиенту не нужны
  if (category) facets.push([`categories:${category}`]);
  const q = new URLSearchParams({ query, facets: JSON.stringify(facets), index: sort, limit: String(limit), offset: String(offset) });
  const r = await api("/search?" + q.toString());
  return {
    total: r.total_hits || 0,
    hits: (r.hits || []).map((h) => ({
      id: h.project_id, slug: h.slug, kind: h.project_type, title: h.title, author: h.author, description: h.description,
      icon: h.icon_url || "", color: hex(h.color), downloads: h.downloads || 0, follows: h.follows || 0,
      categories: h.display_categories || h.categories || [], updated: h.date_modified
    }))
  };
}

// подходящая версия: релиз предпочтительнее беты и альфы
async function pickVersion(projectId, { kind, mc, loader }) {
  const q = new URLSearchParams({ game_versions: JSON.stringify([mc]) });
  if (kind === "mod") q.set("loaders", JSON.stringify([loader]));
  const list = await api(`/project/${encodeURIComponent(projectId)}/version?` + q.toString());
  if (!list.length) throw new Error(`нет версии для ${mc}${kind === "mod" ? " · " + loader : ""}`);
  return list.find((v) => v.version_type === "release") || list[0];
}
const primaryFile = (v) => (v.files || []).find((f) => f.primary) || (v.files || [])[0];

// что именно будет установлено: для окна «подробнее»
async function preview(opts) {
  const v = await pickVersion(opts.projectId, opts);
  const f = primaryFile(v);
  const deps = [];
  if (opts.kind === "mod") for (const d of v.dependencies || []) if (d.dependency_type === "required" && d.project_id) { try { deps.push((await projectInfo(d.project_id)).title); } catch {} }
  return { name: v.name, versionNumber: v.version_number, versionType: v.version_type, date: v.date_published, size: f ? f.size : 0, filename: f ? f.filename : "", deps };
}

// ---------- файлы ----------
function checkUrl(u) {
  const x = new URL(u);
  if (!(x.protocol === "https:" || (cfg.allowHttp && x.protocol === "http:"))) throw new Error("небезопасная ссылка на файл");
  if (!cfg.cdnHosts.includes(x.hostname)) throw new Error("файл не с cdn.modrinth.com: " + x.hostname);
}
function safeName(name, ext) {
  const n = path.basename(String(name || ""));
  // Проверяем на недопустимые символы Windows (включая двоеточие)
  if (!n || n.startsWith(".") || /[<>:"/\\|?*]/.test(n) || !n.toLowerCase().endsWith(ext)) {
    throw new Error("странное имя файла: " + name);
  }
  return n;
}

async function sha1File(file) {
  return new Promise((ok, bad) => { const h = crypto.createHash("sha1"), s = fs.createReadStream(file); s.on("data", (d) => h.update(d)); s.on("error", bad); s.on("end", () => ok(h.digest("hex"))); });
}
async function download(url, dest, sha1, onPct, tries = 3,signal = null) {
  checkUrl(url);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let last;
  for (let i = 0; i < tries; i++) {
    const tmp = dest + ".part";
    try {
      const fetchOpts = { headers: { "User-Agent": cfg.ua } };
      if (signal){
        fetchOpts.signal = AbortSignal.any([signal, AbortSignal.timeout(10 * 60 * 1000)]);
      } else {
        fetchOpts.signal = AbortSignal.timeout(10 * 60 * 1000);
      }
      
      const res = await fetch(url, fetchOpts);
      if (!res.ok) throw new Error("HTTP " + res.status);
      const total = Number(res.headers.get("content-length")) || 0, out = fs.createWriteStream(tmp), reader = res.body.getReader(), hash = crypto.createHash("sha1");
      let got = 0;
      for (;;) {
        const r = await Promise.race([reader.read(), sleep(30000).then(() => { throw new Error("нет данных 30 с"); })]);
        if (r.done) break;
        out.write(r.value); hash.update(r.value); got += r.value.length;
        if (onPct && total) onPct(Math.min(99, Math.round((got / total) * 100)));
      }
      await new Promise((ok, bad) => out.end((e) => (e ? bad(e) : ok())));
      if (sha1 && hash.digest("hex") !== sha1) throw new Error("контрольная сумма не совпала");
      fs.renameSync(tmp, dest);
      return;
    } catch (e) { last = e; try { fs.unlinkSync(tmp); } catch {} await sleep(500 * (i + 1)); }
  }
  throw new Error(`${path.basename(dest)}: ${last && last.message ? last.message : last}`);
}

// ---------- учёт установленного ----------
const metaFile = (inst) => path.join(inst, "farcipal-installed.json");
function readMeta(inst) { try { return JSON.parse(fs.readFileSync(metaFile(inst), "utf8")).items || {}; } catch { return {}; } }
function writeMeta(inst, items) { fs.mkdirSync(inst, { recursive: true }); fs.writeFileSync(metaFile(inst), JSON.stringify({ items }, null, 2)); }
const key = (kind, file) => kind + "/" + file;

function listInstalled(root, mc, loaderType) {
  const inst = loaders.instanceDir(root, mc, loaderType), meta = readMeta(inst), out = [];
  for (const [kind, k] of Object.entries(KINDS)) {
    const dir = path.join(inst, k.folder);
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith(k.ext)); } catch {}
    for (const f of files) {
      const m = meta[key(kind, f)] || {};
      let size = 0; try { size = fs.statSync(path.join(dir, f)).size; } catch {}
      out.push({ kind, file: f, size, title: m.title || f.replace(/\.(jar|zip)$/i, ""), version: m.versionNumber || "", icon: m.icon || "", projectId: m.projectId || "", slug: m.slug || "", manual: !m.projectId, dependency: !!m.dependencyOf });
    }
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title));
}

const inflight = new Set();
async function install({ root, mc, loaderType, kind, projectId, title, icon, slug,signal }, onProgress) {
  if (!KINDS[kind]) throw new Error("неизвестный тип: " + kind);
  if (kind === "mod" && (!loaderType || loaderType === "vanilla")) throw new Error("Для модов выбери Fabric или Forge в настройках");
  if (!mc) throw new Error("не выбрана версия игры");
  if (inflight.has(projectId)) throw new Error("уже устанавливается");
  inflight.add(projectId);
  const inst = loaders.instanceDir(root, mc, loaderType), K = KINDS[kind], dir = path.join(inst, K.folder), done = [], visited = new Set();
  const note = (name, pct) => onProgress && onProgress({ projectId, name, pct });
  try {
    const run = async (pid, info, depth, parentId) => {
      if (visited.has(pid)) return; visited.add(pid);
      const meta = readMeta(inst), already = Object.entries(meta).find(([, v]) => v.projectId === pid && v.kind === kind);
      const v = await pickVersion(pid, { kind, mc, loader: loaderType });
      const f = primaryFile(v);
      if (!f) throw new Error(`${info.title}: у версии нет файла`);
      const name = safeName(f.filename, K.ext), dest = path.join(dir, name);
      const same = fs.existsSync(dest) && f.hashes && f.hashes.sha1 && (await sha1File(dest)) === f.hashes.sha1;
      if (!same) { note(info.title, 0); await download(f.url, dest, f.hashes && f.hashes.sha1, (p) => note(info.title, p), 3, signal); }
      const m2 = readMeta(inst);
      if (already && already[0] !== key(kind, name)) { try { fs.unlinkSync(path.join(dir, already[0].split("/").slice(1).join("/"))); } catch {} delete m2[already[0]]; }   // обновление: старый файл убираем
      m2[key(kind, name)] = { kind, projectId: pid, slug: info.slug, title: info.title, icon: info.icon, versionId: v.id, versionNumber: v.version_number, installedAt: new Date().toISOString(), dependencyOf: parentId || undefined };
      writeMeta(inst, m2);
      done.push({ title: info.title, file: name, dependency: !!parentId, skipped: same });
      if (kind === "mod" && depth < 3) {
        for (const d of v.dependencies || []) {
          if (d.dependency_type !== "required" || !d.project_id) continue;
          if (Object.values(readMeta(inst)).some((x) => x.projectId === d.project_id)) continue;      // уже стоит
          await run(d.project_id, await projectInfo(d.project_id), depth + 1, pid);
        }
      }
    };
    await run(projectId, { title: title || projectId, icon: icon || "", slug: slug || "" }, 0, null);
    note("", 100);
    return { installed: done };
  } finally { inflight.delete(projectId); }
}

function remove({ root, mc, loaderType, kind, file }) {
  if (!KINDS[kind]) throw new Error("неизвестный тип");
  const inst = loaders.instanceDir(root, mc, loaderType), dir = path.join(inst, KINDS[kind].folder), name = safeName(file, KINDS[kind].ext), target = path.join(dir, name);
  if (path.dirname(target) !== dir) throw new Error("недопустимый путь");
  try { fs.unlinkSync(target); } catch (e) { if (e.code !== "ENOENT") throw e; }
  const meta = readMeta(inst); delete meta[key(kind, name)]; writeMeta(inst, meta);
  return true;
}

// ---------- регистрация IPC ----------
// ctx: { gameDir, shell, send(channel, data) }
function register(ipcMain, ctx) {
  const prof = (o) => ({ root: ctx.gameDir, mc: o.mc, loaderType: o.loader });
  ipcMain.handle("store:search", (_e, o) => search(o));
  ipcMain.handle("store:preview", (_e, o) => preview({ projectId: o.projectId, kind: o.kind, mc: o.mc, loader: o.loader }));
  ipcMain.handle("store:installed", (_e, o) => listInstalled(ctx.gameDir, o.mc, o.loader));
  ipcMain.handle("store:install", async (_e, o) => {
    
    try { return { ok: true, ...(await install({ ...prof(o), kind: o.kind, projectId: o.projectId, title: o.title, icon: o.icon, slug: o.slug, signal: ctx.signal }, (p) => ctx.send("store:progress", p))) }; }
    catch (e) { return { ok: false, error: e.message || String(e) }; }
  });
  ipcMain.handle("store:remove", (_e, o) => { try { return { ok: remove({ ...prof(o), kind: o.kind, file: o.file }) }; } catch (e) { return { ok: false, error: e.message }; } });
  ipcMain.handle("store:folder", async (_e, o) => {
    const dir = path.join(loaders.instanceDir(ctx.gameDir, o.mc, o.loader), KINDS[o.kind] ? KINDS[o.kind].folder : "mods");
    fs.mkdirSync(dir, { recursive: true });
    await ctx.shell.openPath(dir);
    return dir;
  });
}

module.exports = { configure, search, preview, install, remove, listInstalled, register };
