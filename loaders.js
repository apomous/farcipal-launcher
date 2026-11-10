// Списки версий Fabric и Forge + установка профиля Fabric. Только Node: без Electron и без @xmcl, поэтому легко тестируется.
const fs = require("fs");
const path = require("path");
const { fetch } = require('undici');
const { farcipalAgent } = require('./network');
const urls = {
  fabricMeta: "https://meta.fabricmc.net",
  forgeMaven: "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml",
  forgePromos: "https://files.minecraftforge.net/net/minecraftforge/forge/promotions_slim.json"
};
const configure = (o) => Object.assign(urls, o);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function fetchText(url, { tries = 3, timeout = 20000 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { dispatcher: farcipalAgent, signal: AbortSignal.timeout(timeout) });
      if (!res.ok) throw new Error("HTTP " + res.status);
      return await res.text();
    } catch (e) { last = e; await sleep(300 * (i + 1)); }
  }
  throw new Error(`${url}: ${last && last.message ? last.message : last}`);
}
const fetchJson = async (url, o) => JSON.parse(await fetchText(url, o));

// кэш на время работы приложения: списки большие, а меняются редко
const cache = new Map();
async function cached(key, fn) { if (!cache.has(key)) cache.set(key, fn().catch((e) => { cache.delete(key); throw e; })); return cache.get(key); }

const cmpNum = (a, b) => {                      // "47.3.10" > "47.3.9"
  const x = a.split(/[.\-]/).map(Number), y = b.split(/[.\-]/).map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (y[i] || 0) - (x[i] || 0); if (d) return d; }
  return 0;
};

// ---------- Fabric ----------
// версии игры, которые поддерживает Fabric (только релизы)
async function fabricGames() {
  const list = await cached("fabric:games", () => fetchJson(`${urls.fabricMeta}/v2/versions/game`));
  return list.filter((g) => g.stable).map((g) => g.version);
}
// версии загрузчика для данной версии игры; новые первыми
async function fabricLoaders(mc) {
  const list = await cached("fabric:loaders:" + mc, () => fetchJson(`${urls.fabricMeta}/v2/versions/loader/${encodeURIComponent(mc)}`));
  const items = list.map((e) => ({ id: e.loader.version, label: e.loader.version + (e.loader.stable ? "" : " · beta"), stable: !!e.loader.stable }));
  const rec = items.find((i) => i.stable) || items[0];
  return { items, recommended: rec ? rec.id : null };
}
// профиль Fabric = готовый JSON версии (id вида fabric-loader-<loader>-<mc>, inheritsFrom = версия игры).
// Кладём его в versions/<id>/<id>.json; библиотеки докачает installDependencies.
async function installFabricProfile(gameDir, mc, loader) {
  const json = await fetchJson(`${urls.fabricMeta}/v2/versions/loader/${encodeURIComponent(mc)}/${encodeURIComponent(loader)}/profile/json`);
  if (!json || !json.id) throw new Error("Fabric Meta вернул профиль без id");
  const file = path.join(gameDir, "versions", json.id, json.id + ".json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(json, null, 2));
  return json.id;
}

// ---------- Forge ----------
// maven-metadata.xml: <version>1.20.1-47.3.0</version>. Берём только релизные версии игры 1.12+ без хвостов вида "-1.7.10"
async function forgeIndex() {
  return cached("forge:index", async () => {
    const xml = await fetchText(urls.forgeMaven);
    const map = new Map();
    for (const m of xml.matchAll(/<version>([^<]+)<\/version>/g)) {
      const x = /^(\d+(?:\.\d+)+)-(\d+(?:\.\d+)+)$/.exec(m[1]);
      if (!x) continue;
      const mc = x[1], parts = mc.split(".").map(Number);
      const modern = parts[0] >= 26 || (parts[0] === 1 && parts[1] >= 12);   // 1.12+ и новая годовая нумерация
      if (!modern) continue;
      if (!map.has(mc)) map.set(mc, []);
      map.get(mc).push(x[2]);
    }
    for (const arr of map.values()) arr.sort(cmpNum);
    return map;
  });
}
async function forgeGames() { return [...(await forgeIndex()).keys()]; }
async function forgePromos() {
  try { return (await cached("forge:promos", () => fetchJson(urls.forgePromos))).promos || {}; } catch { return {}; }
}
async function forgeVersions(mc) {
  const arr = (await forgeIndex()).get(mc) || [], promos = await forgePromos();
  const rec = promos[`${mc}-recommended`], lat = promos[`${mc}-latest`];
  const items = arr.map((v) => ({ id: v, label: v + (v === rec ? " · recommended" : v === lat ? " · latest" : ""), stable: v === rec }));
  return { items, recommended: (items.find((i) => i.id === rec) || items[0] || {}).id || null };
}

// папка профиля: у ванили общая (как раньше, чтобы не потерять миры), у загрузчиков своя на пару «версия + загрузчик»:
// моды под 1.20.1 нельзя смешивать с модами под 1.21, игра падает
function instanceDir(root, mc, loaderType) {
  if (!loaderType || loaderType === "vanilla") return root;
  return path.join(root, "instances", `${mc}-${loaderType}`);
}

module.exports = { instanceDir, configure, fabricGames, fabricLoaders, installFabricProfile, forgeGames, forgeVersions };
