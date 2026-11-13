// Установка и запуск: ваниль (база) -> загрузчик (Forge / Fabric) -> зависимости -> запуск.
// Всё через @xmcl/core и @xmcl/installer. Без Electron, поэтому порядок вызовов проверяется тестом на подставных модулях.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const loaders = require("./loaders");
const { farcipalAgent } = require('./network');
const { ensureAssets } = require('./assets');
const { fetch } = require('undici');
const crypto = require("crypto");

async function readBody(res, kind = "arrayBuffer", timeoutMs = 65000, signal) {
    let timer, onAbort;
    try {
        const bodyPromise = res[kind]();
        const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("Таймаут чтения тела ответа")), timeoutMs);
        });
        const signalPromise = signal ? new Promise((_, reject) => {
            if (signal.aborted) return reject(new Error("Отменено"));
            onAbort = () => reject(new Error("Отменено"));
            signal.addEventListener("abort", onAbort, { once: true });
        }) : null;
        return await Promise.race(signalPromise ? [bodyPromise, timeoutPromise, signalPromise] : [bodyPromise, timeoutPromise]);
    } catch (e) {
        try { if (res.body) res.body.cancel(); } catch {}   // не докачиваем отменённое в фоне
        throw e;
    } finally {
        clearTimeout(timer);
        if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    }
}
// @xmcl бывают и CJS, и ESM: динамический import работает в обоих случаях
async function loadXmcl() {
   const coreModule = await import("@xmcl/core");
   const instModule = await import("@xmcl/installer");
   console.log("Ключи instModule:", Object.keys(instModule));
   console.log("Ключи instModule.default:", Object.keys(instModule.default || {}));
   return {
     core: { ...(coreModule.default || {}), ...coreModule },
     inst: { ...(instModule.default || {}), ...instModule }
 };
}

function javaMajor(javaPath) {
  const r = spawnSync(javaPath, ["-version"], { encoding: "utf8" });
  if (r.error) return null;
  const m = /version "(\d+)(?:\.(\d+))?/.exec(r.stderr || r.stdout || "");
  if (!m) return null;
  return m[1] === "1" ? Number(m[2]) : Number(m[1]);
}
// запасной вариант, если в JSON версии нет javaVersion (там он есть почти всегда)
function fallbackJava(mc) {
  const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(mc);
  if (!m) return 25;
  if (Number(m[1]) >= 26) return 25;
  const minor = Number(m[2]), patch = Number(m[3] || 0);
  if (minor >= 21 || (minor === 20 && patch >= 5)) return 21;
  if (minor >= 17) return 17;
  return 8;
}

// отмена: main.js выставляет hooks.cancel.cancelled = true и вызывает task.cancel(); здесь проверяем на границах этапов
function checkCancel(hooks) {
  if (hooks.cancel && hooks.cancel.cancelled) { const e = new Error("Отменено"); e.cancelled = true; throw e; }
}

// запуск задачи установщика с прогрессом (МБ); если у функции нет Task-версии — просто ждём промис
async function runTask(task, fallback, label, hooks) {
  checkCancel(hooks);
  let result;
  if (task && typeof task.startAndWait === "function") {
    let lastSend = 0;
    if (hooks.cancel) hooks.cancel.task = task;
    try {
      result = await task.startAndWait({
        onUpdate() {
          const now = Date.now();
          if (now - lastSend < 150) return;
          lastSend = now;
          hooks.progress({ type: label, task: Math.floor((task.progress || 0) / 1048576), total: Math.max(1, Math.ceil((task.total || 0) / 1048576)) });
        },
        onFailed(t, e) { hooks.log(`сбой: ${(t && t.path) || label}: ${(e && e.message) || e}`); }
      });
    } catch (e) {
      if (hooks.cancel && hooks.cancel.cancelled) checkCancel(hooks);
      throw e;
    } finally { if (hooks.cancel) hooks.cancel.task = null; }
  } else {
    // Оборачиваем в гонку, чтобы отмена срабатывала, даже если @xmcl завис
    let checkInt;
    const cancelPromise = new Promise((_, reject) => {
      checkInt = setInterval(() => {
        if (hooks.cancel && hooks.cancel.cancelled) {
          clearInterval(checkInt);
          reject(new Error("Отменено"));
        }
      }, 200);
    });
    try {
      const fbPromise = fallback();
      fbPromise.catch(() => {});
      result = await Promise.race([fbPromise, cancelPromise]);
    } finally {
      clearInterval(checkInt);
    }
  }
  checkCancel(hooks);
  return result;
}
const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal && signal.aborted) { const e = new Error("Отменено"); e.cancelled = true; return reject(e); }
  const onAbort = () => { clearTimeout(t); const e = new Error("Отменено"); e.cancelled = true; reject(e); };
  const t = setTimeout(() => { if (signal) signal.removeEventListener("abort", onAbort); resolve(); }, ms);
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
});
const exists = (p) => { try { return fs.existsSync(p); } catch { return false; } };
const versionJson = (gameDir, id) => path.join(gameDir, "versions", id, id + ".json");

/**
 * opts: { gameDir, mcVersion, loaderType: "vanilla"|"forge"|"fabric", loaderVersion, javaPath, memoryGB, auth, server }
 *   auth: { profile: {id, name}, accessToken, userType, demo }
 * hooks: { log(msg), progress({type, task, total}), state("loading") }
 * deps: { core, inst, javaMajor } — только для тестов
 * возвращает { proc, versionId }
 */
async function installAndLaunch(opts, hooks, deps) {
    const { gameDir, mcVersion, loaderType = "vanilla", loaderVersion, javaPath = "java", memoryGB = 4, auth, server, concurrency: rawConcurrency = 4, signal } = opts;
  // 0 означает "безлимит" (из ползунка на 17), ставим 64 потока
  const concurrency = rawConcurrency === 0 ? 64 : rawConcurrency;
  const { core, inst } = deps && deps.core ? deps : await loadXmcl();
  console.log("Доступные функции в inst:", Object.keys(inst));
  const getJava = (deps && deps.javaMajor) || javaMajor;
  if (!mcVersion) throw new Error("Выбери версию игры");
  if ((loaderType === "forge" || loaderType === "fabric") && !loaderVersion) throw new Error(`Выбери версию ${loaderType === "forge" ? "Forge" : "Fabric"}`);
  fs.mkdirSync(gameDir, { recursive: true });

    const ensureDeps = async (id, label) => {
    const resolved = await core.Version.parse(gameDir, id);

    let attempt = 1;
    const maxRetries = 10; // 10 попыток — с головой хватит

    while (attempt <= maxRetries) {
      try {
        await runTask(
          inst.installLibrariesTask && inst.installLibrariesTask(resolved, { agent: farcipalAgent, concurrency: concurrency }),
          () => inst.installLibraries(resolved, { agent: farcipalAgent, concurrency: concurrency }),
          label,
          hooks
        );
        break; // Если ошибок нет — выходим из цикла
      } catch (e) {
        // Отмена («Остановить») или последняя попытка — не ретраим, а падаем наружу
        if ((hooks.cancel && hooks.cancel.cancelled) || e.cancelled || attempt >= maxRetries) throw e;
        const delay = Math.min(3000 * 2 ** (attempt - 1), 15000);   // экспоненциальный backoff
        hooks.log(`[Сеть] Сбой скачивания (попытка ${attempt}/${maxRetries}). Пауза ${Math.round(delay / 1000)} с...`);
        await sleep(delay, signal);   // «Остановить» прерывает и паузу
        attempt++;
      }
    }
    return resolved;

  };


    // 1) базовая ванильная версия: качаем JSON и JAR руками, без @xmcl (чтобы не качал ассеты)
  hooks.state("loading");
  const vDir = path.join(gameDir, "versions", mcVersion);
  const versionJsonPath = path.join(vDir, `${mcVersion}.json`);
  let versionData = null;

  // Всегда читаем (или скачиваем) JSON
  if (!exists(versionJsonPath)) {
    hooks.log(`качаю метаданные Minecraft ${mcVersion}`);
    const list = await inst.getVersionList();
    checkCancel(hooks);
    const meta = list.versions.find((v) => v.id === mcVersion);
    if (!meta) throw new Error(`Версия ${mcVersion} не найдена в манифесте Mojang`);

    const res = await fetch(meta.url, { dispatcher: farcipalAgent, signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} при скачивании JSON`);
    versionData = await readBody(res, "json", 65000, signal);

    fs.mkdirSync(vDir, { recursive: true });
    fs.writeFileSync(versionJsonPath, JSON.stringify(versionData, null, 2));
  } else {
    versionData = JSON.parse(fs.readFileSync(versionJsonPath, 'utf8'));
  }

  // Всегда проверяем JAR (если он есть на диске)
  if (versionData.downloads && versionData.downloads.client) {
    const jarPath = path.join(vDir, `${mcVersion}.jar`);
    const expectedSha1 = versionData.downloads.client.sha1;
    const jarUrl = versionData.downloads.client.url;

    let needsJarDownload = !exists(jarPath);

    if (!needsJarDownload) {
      // Проверяем SHA1 существующего JAR

      const { pipeline } = require('stream/promises');
      const fileHash = crypto.createHash('sha1');
      await pipeline(fs.createReadStream(jarPath), async function* (source) {
          for await (const chunk of source) fileHash.update(chunk);
      });
      const actualSha1 = fileHash.digest('hex');

      if (actualSha1 !== expectedSha1) {
        hooks.log(`JAR повреждён (ожидался ${expectedSha1.slice(0, 8)}..., получен ${actualSha1.slice(0, 8)}...). Перекачиваю...`);
        needsJarDownload = true;
      }
    }

       if (needsJarDownload) {
      hooks.log(`качаю client.jar для ${mcVersion}`);
      const jarRes = await fetch(jarUrl, { dispatcher: farcipalAgent, signal });
      if (!jarRes.ok) throw new Error(`HTTP ${jarRes.status} при скачивании JAR`);
      const jarBuffer = Buffer.from(await readBody(jarRes, "arrayBuffer", 120000, signal));
      if (expectedSha1 && crypto.createHash("sha1").update(jarBuffer).digest("hex") !== expectedSha1) {
        throw new Error("Скачанный JAR повреждён (SHA1 не совпал). Запусти ещё раз — перекачаю.");
      }
      fs.writeFileSync(jarPath + ".tmp", jarBuffer);
      fs.renameSync(jarPath + ".tmp", jarPath);
    }
  }


  // Парсим версию, чтобы достать ID индекса ассетов
  const parsedBase = await core.Version.parse(gameDir, mcVersion);

  const assetIndex = parsedBase.assetIndex;
  if (assetIndex && assetIndex.url) {
    const indexDir = path.join(gameDir, "assets", "indexes");
    fs.mkdirSync(indexDir, { recursive: true });
    const indexPath = path.join(indexDir, `${assetIndex.id}.json`);

    if (!fs.existsSync(indexPath)) {
      hooks.log(`качаю индекс ассетов ${assetIndex.id}...`);
      const indexRes = await fetch(assetIndex.url, { dispatcher: farcipalAgent, signal });
      if (!indexRes.ok) throw new Error(`HTTP ${indexRes.status} при скачивании индекса`);
      const indexData = await readBody(indexRes, "text", 65000, signal);
      fs.writeFileSync(indexPath, indexData);
    }
  }

  // Если ID нет (очень старые версии), используем 'legacy'
  const assetIndexId = (parsedBase.assetIndex && parsedBase.assetIndex.id) ? parsedBase.assetIndex.id : 'legacy';
  hooks.log(`Проверяю и докачиваю ассеты (индекс: ${assetIndexId})...`);
  await ensureAssets(gameDir, assetIndexId, concurrency, (p) => hooks.progress({ type: "файлы " + mcVersion, ...p }), hooks, signal);

  // Теперь отдаем это @xmcl, он проверит за секунду и перейдет к библиотекам
  const base = await ensureDeps(mcVersion, "файлы " + mcVersion);
       // докачает недостающее и битое, лишнего не трогает
    // 2) Java: ищем подходящую локально, иначе качаем в runtime/java-<major>
  const need = (base.javaVersion && base.javaVersion.majorVersion) || fallbackJava(mcVersion);
  let actualJavaPath = javaPath;
  let have = getJava(actualJavaPath);

  const runtimeDir = path.join(gameDir, "runtime");
  const javaDirFor = (major) => path.join(runtimeDir, "java-" + major);
  const javaExeName = process.platform === "win32" ? "javaw.exe" : "java";
  const javaFits = (v) => !!v && (need === 8 ? v === 8 : v >= need);

  // собираем ВСЕ кандидаты и проверяем версию, а не берём первый попавшийся javaw.exe
  const findAllJava = (dir) => {
    const out = [];
    const walk = (d) => {
      let entries;
      try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
      for (const f of entries) {
        const p = path.join(d, f.name);
        if (f.isDirectory()) walk(p);
        else if (f.name === javaExeName) out.push(p);
      }
    };
    walk(dir);
    return out;
  };

  const candidates = [...new Set([...findAllJava(javaDirFor(need)), ...findAllJava(runtimeDir)])];
  for (const p of candidates) {
    const v = getJava(p);
    if (javaFits(v)) { actualJavaPath = p; have = v; break; }
  }

  if (!javaFits(have)) {
    hooks.log(`Установлена Java ${have || "не найдена"}. Для ${mcVersion} нужна Java ${need}. Скачиваю Java ${need}...`);
    hooks.progress({ type: "Java", task: 0, total: 1 });

    const javaRuntimeDir = javaDirFor(need);   // своя папка на мажорную версию — больше не перекачиваем каждый запуск
    const { spawn } = require("child_process");
    const sevenZip = require("7zip-bin");
    let sevenZipPath = sevenZip.path7za;
    if (process.resourcesPath) {
      const unpacked = path.join(process.resourcesPath, "app.asar.unpacked", "node_modules", "7zip-bin", "win", "x64", "7za.exe");
      if (fs.existsSync(unpacked)) sevenZipPath = unpacked;
    }
    const run7z = (args) => new Promise((resolve, reject) => {
      if (!fs.existsSync(sevenZipPath)) return reject(new Error("7za.exe не найден: " + sevenZipPath));
      const child = spawn(sevenZipPath, args, { windowsHide: true });
      const onAbort = () => { try { child.kill(); } catch {} };
      if (signal) signal.addEventListener("abort", onAbort, { once: true });
      const done = (fn, arg) => { if (signal) signal.removeEventListener("abort", onAbort); fn(arg); };
      child.on("close", (code) => code === 0 ? done(resolve) : done(reject, new Error(`7zip exited with code ${code}`)));
      child.on("error", (e) => done(reject, e));
    });

    try {
      if (need >= 21) {
        // Adoptium: сначала JRE (~45 МБ), JDK (~190 МБ) — только запасной вариант
        let downloadUrl = null;
        for (const imageType of ["jre", "jdk"]) {
          try {
            const apiUrl = `https://api.adoptium.net/v3/assets/latest/${need}/hotspot?architecture=x64&image_type=${imageType}&os=windows`;
            const apiRes = await fetch(apiUrl, { dispatcher: farcipalAgent, signal });
            if (!apiRes.ok) continue;
            const apiData = await readBody(apiRes, "json", 65000, signal);
            const link = apiData && apiData[0] && apiData[0].binary && apiData[0].binary.package && apiData[0].binary.package.link;
            if (link) { downloadUrl = link; hooks.log(`Скачиваю Java ${need} (${imageType.toUpperCase()}) с Adoptium...`); break; }
          } catch (e) { hooks.log(`Adoptium API (${imageType}): ${e.message}`); }
        }
        if (!downloadUrl) downloadUrl = `https://api.adoptium.net/v3/binary/latest/${need}/ga/windows/x64/jre/hotspot/normal/eclipse`;

        hooks.log(`Скачивание Java ${need} может занять несколько минут, не закрывай лаунчер...`);
        const zipRes = await fetch(downloadUrl, { dispatcher: farcipalAgent, signal });
        if (!zipRes.ok) throw new Error(`HTTP ${zipRes.status} при скачивании архива`);
        const zipBuffer = await readBody(zipRes, "arrayBuffer", 600000, signal);

        const zipPath = path.join(gameDir, "cache", `java-${need}.zip`);
        fs.mkdirSync(path.dirname(zipPath), { recursive: true });
        fs.writeFileSync(zipPath, Buffer.from(zipBuffer));
        checkCancel(hooks);
        await run7z(["x", zipPath, `-o${javaRuntimeDir}`, "-y"]);
      } else {
        // Java 8/17 — JRE с серверов Mojang
        const unpackLZMA = async (src, dest) => {
          const tarDir = path.dirname(src);
          await run7z(["e", src, `-o${tarDir}`, "-y"]);
          await run7z(["x", path.join(tarDir, path.basename(src, ".lzma")), `-o${dest}`, "-y"]);
        };
        const cacheDir = path.join(gameDir, "cache");
        const downloadedJavaPath = await runTask(
          inst.installJreFromMojangTask ? inst.installJreFromMojangTask({ destination: javaRuntimeDir, unpackLZMA, cacheDir }) : null,
          () => inst.installJreFromMojang({ destination: javaRuntimeDir, unpackLZMA, cacheDir }),
          "Java " + need,
          hooks
        );
        if (downloadedJavaPath) actualJavaPath = downloadedJavaPath;
      }
      // ищем exe только в папке нужной версии и проверяем, что он той версии
      if (!actualJavaPath || !fs.existsSync(actualJavaPath) || !javaFits(getJava(actualJavaPath))) {
        const found = findAllJava(javaRuntimeDir).find((p) => javaFits(getJava(p)));
        if (!found) throw new Error(`Не удалось найти ${javaExeName} в ${javaRuntimeDir}`);
        actualJavaPath = found;
      }
      hooks.log(`Java ${need} успешно установлена: ${actualJavaPath}`);
    } catch (e) {
      if (hooks.cancel && hooks.cancel.cancelled) throw e;
      throw new Error(`Не удалось скачать Java ${need}: ${e.message}.`);
    }
  }
  // 3) загрузчик
  let versionId = mcVersion;
  if (loaderType === "fabric") {
    hooks.log(`ставлю Fabric ${loaderVersion}`);
    versionId = await loaders.installFabricProfile(gameDir, mcVersion, loaderVersion);
    checkCancel(hooks);
  } else if (loaderType === "forge") {
    const expected = `${mcVersion}-forge-${loaderVersion}`;
    if (exists(versionJson(gameDir, expected))) versionId = expected;
    else {
      hooks.log(`ставлю Forge ${loaderVersion}: установщик запускает Java, это может занять несколько минут`);
      hooks.progress({ type: "Forge", task: 0, total: 1 });
      const r = await inst.installForge({ version: loaderVersion, mcversion: mcVersion }, gameDir, { java: actualJavaPath, agent: farcipalAgent, concurrency: concurrency});
      checkCancel(hooks);
      versionId = typeof r === "string" && r ? r : expected;
      if (!exists(versionJson(gameDir, versionId))) {                  // подстраховка: ищем установленную папку Forge
        const dir = path.join(gameDir, "versions");
        const found = fs.readdirSync(dir).find((d) => d.includes("forge") && d.includes(loaderVersion) && exists(versionJson(gameDir, d)));
        if (!found) throw new Error("Forge установился, но профиль версии не найден в " + dir);
        versionId = found;
      }
    }
  }
  if (versionId !== mcVersion) await ensureDeps(versionId, "библиотеки загрузчика");

  // 4) запуск
  hooks.log(`запускаю ${versionId}`);
  // профиль: у ванили общая папка (миры не теряются), у Forge/Fabric своя на пару «версия + загрузчик», там лежат моды из магазина.
  // Библиотеки, ассеты и версии общие: resourcePath = корень
  const instance = loaders.instanceDir(gameDir, mcVersion, loaderType);
  fs.mkdirSync(instance, { recursive: true });
  const opt = {
    gamePath: instance, resourcePath: gameDir, javaPath: actualJavaPath, version: versionId,
    gameProfile: auth.profile, accessToken: auth.accessToken, userType: auth.userType,
    minMemory: 1024, maxMemory: Math.max(1024, Math.round(memoryGB * 1024)),
    launcherName: "Farcipal", launcherBrand: "Farcipal",
    extraMCArgs: auth.demo ? ["--demo"] : []
  };
  if (server && server.host) { opt.server = { ip: server.host, port: server.port || 25565 }; opt.quickPlayMultiplayer = `${server.host}:${server.port || 25565}`; }
  checkCancel(hooks);
     // ПРИНУДИТЕЛЬНО ИЗВЛЕКАЕМ НАТИВНЫЕ БИБЛИОТЕКИ
  hooks.log("Проверяю нативные библиотеки...");
  const { LaunchPrecheck, MinecraftFolder } = await import("@xmcl/core");

  const resolvedVersion = await core.Version.parse(gameDir, versionId);
  const minecraftFolder = MinecraftFolder.from(gameDir);

  // ЯВНО УКАЗЫВАЕМ, КУДА РАСПАКОВЫВАТЬ НАТИВЫ
  opt.nativeRoot = path.join(gameDir, "versions", versionId, versionId + "-natives");
  fs.mkdirSync(opt.nativeRoot, { recursive: true });

  // Теперь checkNatives точно знает, куда распаковывать
  await LaunchPrecheck.checkNatives(minecraftFolder, resolvedVersion, opt);
    // Гарантируем, что Java увидит нативы
  if (!opt.extraJVMArgs) opt.extraJVMArgs = [];
  opt.extraJVMArgs.push(`-Djava.library.path=${opt.nativeRoot}`);
  checkCancel(hooks);
  const proc = await core.launch(opt);
  if (hooks.cancel && hooks.cancel.cancelled) { try { proc.kill(); } catch {} checkCancel(hooks); }   // отменили в момент старта
  return { proc, versionId };
}

module.exports = { installAndLaunch, javaMajor, fallbackJava };
