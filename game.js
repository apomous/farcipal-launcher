// Установка и запуск: ваниль (база) -> загрузчик (Forge / Fabric) -> зависимости -> запуск.
// Всё через @xmcl/core и @xmcl/installer. Без Electron, поэтому порядок вызовов проверяется тестом на подставных модулях.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const loaders = require("./loaders");
const { farcipalAgent } = require('./network');
const { ensureAssets } = require('./assets');
const { fetch } = require('undici');



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
    result = await fallback();
  }
  checkCancel(hooks);
  return result;
}

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
    const { gameDir, mcVersion, loaderType = "vanilla", loaderVersion, javaPath = "java", memoryGB = 4, auth, server, concurrency: rawConcurrency = 4} = opts;
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
        // Если пользователь сам нажал "Отмена" — не делаем ретраи
        if (hooks.cancel && hooks.cancel.cancelled) throw e; 
        
        // Если это была последняя попытка — кидаем ошибку наверх
        if (attempt === maxRetries) throw e; 
        
        hooks.log(`[Сеть] Сбой скачивания (попытка ${attempt}/${maxRetries}). Ждем 3 секунды и продолжаем...`);
        await new Promise(r => setTimeout(r, 3000)); // Ждем 3 секунды перед следующей попыткой
        attempt++;
      }
    }
    return resolved;
  
  };

  
    // 1) базовая ванильная версия: качаем JSON и JAR руками, без @xmcl (чтобы не качал ассеты)
  hooks.state("loading");
  if (!exists(versionJson(gameDir, mcVersion))) {
    hooks.log(`качаю метаданные Minecraft ${mcVersion}`);
    const list = await inst.getVersionList();
    checkCancel(hooks);
    const meta = list.versions.find((v) => v.id === mcVersion);
    if (!meta) throw new Error(`Версия ${mcVersion} не найдена в манифесте Mojang`);
    
    // Качаем JSON версии
    const res = await fetch(meta.url, { dispatcher: farcipalAgent });
    if (!res.ok) throw new Error(`HTTP ${res.status} при скачивании JSON`);
    const versionData = await res.json();
    
    const vDir = path.join(gameDir, "versions", mcVersion);
    fs.mkdirSync(vDir, { recursive: true });
    fs.writeFileSync(path.join(vDir, `${mcVersion}.json`), JSON.stringify(versionData, null, 2));
    
    // Качаем сам клиентский jar
    if (versionData.downloads && versionData.downloads.client) {
      hooks.log(`качаю client.jar для ${mcVersion}`);
      const jarUrl = versionData.downloads.client.url;
      const jarRes = await fetch(jarUrl, { dispatcher: farcipalAgent });
      if (!jarRes.ok) throw new Error(`HTTP ${jarRes.status} при скачивании JAR`);
      const jarBuffer = await jarRes.arrayBuffer();
      fs.writeFileSync(path.join(vDir, `${mcVersion}.jar`), Buffer.from(jarBuffer));
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
      const indexRes = await fetch(assetIndex.url, { dispatcher: farcipalAgent });
      if (!indexRes.ok) throw new Error(`HTTP ${indexRes.status} при скачивании индекса`);
      const indexData = await indexRes.text();
      fs.writeFileSync(indexPath, indexData);
    }
  }

  // Если ID нет (очень старые версии), используем 'legacy'
  const assetIndexId = (parsedBase.assetIndex && parsedBase.assetIndex.id) ? parsedBase.assetIndex.id : 'legacy';
  hooks.log(`Проверяю и докачиваю ассеты (индекс: ${assetIndexId})...`);
  await ensureAssets(gameDir, assetIndexId, concurrency, (p) => hooks.progress({ type: "файлы " + mcVersion, ...p })); 
  
  // Теперь отдаем это @xmcl, он проверит за секунду и перейдет к библиотекам
  const base = await ensureDeps(mcVersion, "файлы " + mcVersion);       // докачает недостающее и битое, лишнего не трогает
  const need = (base.javaVersion && base.javaVersion.majorVersion) || fallbackJava(mcVersion);
  let actualJavaPath = javaPath;
  let have = getJava(actualJavaPath);
  
 
    if (!have || have < need || (need === 8 && have > 8)) {
    hooks.log(`Установлена Java ${have || 'не найдена'}. Для ${mcVersion} нужна Java ${need}. Скачиваю Java ${need}...`);
    hooks.progress({ type: "Java", task: 0, total: 1 });
    
    try {
      const javaRuntimeDir = path.join(gameDir, "runtime");
      
      // Если нужна Java 21+, качаем через Adoptium API
      if (need >= 21) {
        hooks.log(`Скачиваю Java ${need} с Adoptium...`);
        
        // Получаем ссылку на последнюю версию нужной Java для Windows x64
        const apiUrl = `https://api.adoptium.net/v3/assets/latest/${need}/hotspot?architecture=x64&image_type=jdk&os=windows`;
        const apiRes = await fetch(apiUrl, { dispatcher: farcipalAgent });
        if (!apiRes.ok) throw new Error(`HTTP ${apiRes.status} при запросе к Adoptium`);
        const apiData = await apiRes.json();
        
        if (!apiData || !apiData[0] || !apiData[0].binary || !apiData[0].binary.package || !apiData[0].binary.package.link) {
          throw new Error("Не удалось получить ссылку на Java от Adoptium");
        }
        
        const downloadUrl = apiData[0].binary.package.link;
        hooks.log(`качаю архив Java ${need}...`);
        
        // Скачиваем архив
        const zipRes = await fetch(downloadUrl, { dispatcher: farcipalAgent });
        if (!zipRes.ok) throw new Error(`HTTP ${zipRes.status} при скачивании архива`);
        const zipBuffer = await zipRes.arrayBuffer();
        
        const zipPath = path.join(gameDir, "cache", `java-${need}.zip`);
        fs.mkdirSync(path.dirname(zipPath), { recursive: true });
        fs.writeFileSync(zipPath, Buffer.from(zipBuffer));
        
        // Распаковываем через 7zip
        const sevenZip = require('7zip-bin');
        let sevenZipPath = sevenZip.path7za;
        if (process.resourcesPath) {
          const unpackedPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
          if (fs.existsSync(unpackedPath)) sevenZipPath = unpackedPath;
        }
        
        const { spawn } = require('child_process');
        await new Promise((resolve, reject) => {
          const child = spawn(sevenZipPath, ['x', zipPath, `-o${javaRuntimeDir}`, '-y']);
          child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`7zip exited with code ${code}`)));
          child.on('error', reject);
        });
        
        // Ищем javaw.exe в распакованной папке
        const javaExeName = process.platform === "win32" ? "javaw.exe" : "java";
        const findJavaExe = (dir) => {
          const files = fs.readdirSync(dir, { withFileTypes: true });
          for (const file of files) {
            const fullPath = path.join(dir, file.name);
            if (file.isDirectory()) {
              const found = findJavaExe(fullPath);
              if (found) return found;
            } else if (file.name === javaExeName) {
              return fullPath;
            }
          }
          return null;
        };
        
        const foundPath = findJavaExe(javaRuntimeDir);
        if (foundPath) {
          actualJavaPath = foundPath;
          hooks.log(`Java ${need} успешно установлена: ${actualJavaPath}`);
        } else {
          throw new Error(`Не удалось найти ${javaExeName} в ${javaRuntimeDir}`);
        }
      } else {
        // Для старых версий (Java 8) используем встроенную функцию
        const { spawn } = require('child_process');
        const sevenZip = require('7zip-bin');
        
        const unpackLZMA = async (src, dest) => {
          const tarDir = path.dirname(src);
          let sevenZipPath = sevenZip.path7za;
          if (process.resourcesPath) {
            const unpackedPath = path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
            if (fs.existsSync(unpackedPath)) sevenZipPath = unpackedPath;
          }
          if (!fs.existsSync(sevenZipPath)) throw new Error(`7za.exe не найден по пути: ${sevenZipPath}`);
          
          await new Promise((resolve, reject) => {
            const child = spawn(sevenZipPath, ['e', src, `-o${tarDir}`, '-y']);
            child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`7zip (lzma) exited with code ${code}`)));
            child.on('error', reject);
          });
          
          const tarFile = path.join(tarDir, path.basename(src, '.lzma'));
          await new Promise((resolve, reject) => {
            const child = spawn(sevenZipPath, ['x', tarFile, `-o${dest}`, '-y']);
            child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`7zip (tar) exited with code ${code}`)));
            child.on('error', reject);
          });
        };
        
        const cacheDir = path.join(gameDir, "cache");
        const downloadedJavaPath = await runTask(
          inst.installJreFromMojangTask ? inst.installJreFromMojangTask({ destination: javaRuntimeDir, unpackLZMA, cacheDir }) : null,
          () => inst.installJreFromMojang({ destination: javaRuntimeDir, unpackLZMA, cacheDir }),
          "Java " + need,
          hooks
        );
        
        if (downloadedJavaPath) {
          actualJavaPath = downloadedJavaPath;
          hooks.log(`Java ${need} успешно установлена: ${actualJavaPath}`);
        } else {
          const javaExeName = process.platform === "win32" ? "javaw.exe" : "java";
          const findJavaExe = (dir) => {
            const files = fs.readdirSync(dir, { withFileTypes: true });
            for (const file of files) {
              const fullPath = path.join(dir, file.name);
              if (file.isDirectory()) {
                const found = findJavaExe(fullPath);
                if (found) return found;
              } else if (file.name === javaExeName) {
                return fullPath;
              }
            }
            return null;
          };
          const foundPath = findJavaExe(javaRuntimeDir);
          if (foundPath) {
            actualJavaPath = foundPath;
            hooks.log(`Найдена Java: ${actualJavaPath}`);
          } else {
            throw new Error(`Не удалось найти ${javaExeName} в ${javaRuntimeDir}`);
          }
        }
      }
    } catch (e) {
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
