// Установка и запуск: ваниль (база) -> загрузчик (Forge / Fabric) -> зависимости -> запуск.
// Всё через @xmcl/core и @xmcl/installer. Без Electron, поэтому порядок вызовов проверяется тестом на подставных модулях.
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const loaders = require("./loaders");
const { farcipalAgent } = require('./network');
const { ensureAssets } = require('./assets');

// @xmcl бывают и CJS, и ESM: динамический import работает в обоих случаях
async function loadXmcl() {
  const pick = (m, key) => (m && m[key] ? m : m && m.default && m.default[key] ? m.default : m);
  return { core: pick(await import("@xmcl/core"), "launch"), inst: pick(await import("@xmcl/installer"), "install") };
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
  if (task && typeof task.startAndWait === "function") {
    let lastSend = 0;
    if (hooks.cancel) hooks.cancel.task = task;        // чтобы stop мог вызвать task.cancel()
    try {
      await task.startAndWait({
        onUpdate() {
          const now = Date.now();
          if (now - lastSend < 150) return;
          lastSend = now;
          hooks.progress({ type: label, task: Math.floor((task.progress || 0) / 1048576), total: Math.max(1, Math.ceil((task.total || 0) / 1048576)) });
        },
        onFailed(t, e) { hooks.log(`сбой: ${(t && t.path) || label}: ${(e && e.message) || e}`); }
      });
    } catch (e) {
      if (hooks.cancel && hooks.cancel.cancelled) checkCancel(hooks);   // задачу отменили: это не ошибка установки
      throw e;
    } finally { if (hooks.cancel) hooks.cancel.task = null; }
  } else await fallback();
  checkCancel(hooks);
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
  const { gameDir, mcVersion, loaderType = "vanilla", loaderVersion, javaPath = "java", memoryGB = 4, auth, server, concurrency = 4} = opts;
  const { core, inst } = deps && deps.core ? deps : await loadXmcl();
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

  // 1) базовая ванильная версия: качаем, только если её ещё нет
  hooks.state("loading");
  if (!exists(versionJson(gameDir, mcVersion))) {
    hooks.log(`скачиваю Minecraft ${mcVersion}`);
    const list = await inst.getVersionList();
    checkCancel(hooks);
    const meta = list.versions.find((v) => v.id === mcVersion);
    if (!meta) throw new Error(`Версия ${mcVersion} не найдена в манифесте Mojang`);
        await runTask(
      inst.installTask && inst.installTask(meta, gameDir, { agent: farcipalAgent, concurrency: concurrency }), 
      () => inst.install(meta, gameDir, { agent: farcipalAgent, concurrency : concurrency}), 
      "Minecraft " + mcVersion, 
      hooks
    );
  }
     // Парсим версию, чтобы достать ID индекса ассетов
  const parsedBase = await core.Version.parse(gameDir, mcVersion);
  // Если ID нет (очень старые версии), используем 'legacy'
  const assetIndexId = (parsedBase.assetIndex && parsedBase.assetIndex.id) ? parsedBase.assetIndex.id : 'legacy';
  
  hooks.log(`Проверяю и докачиваю ассеты (индекс: ${assetIndexId})...`);
  await ensureAssets(gameDir, assetIndexId, concurrency, (p) => hooks.progress({ type: "файлы " + mcVersion, ...p })); 
  
  // Теперь отдаем это @xmcl, он проверит за секунду и перейдет к библиотекам
  const base = await ensureDeps(mcVersion, "файлы " + mcVersion);       // докачает недостающее и битое, лишнего не трогает

  // 2) нужная Java: берём из JSON версии, а не угадываем
  const need = (base.javaVersion && base.javaVersion.majorVersion) || fallbackJava(mcVersion), have = getJava(javaPath);
  if (!have) throw new Error(`Не найдена Java. Для ${mcVersion} нужна Java ${need}+ (например, Temurin с adoptium.net)`);
  if (have < need) throw new Error(`Для ${mcVersion} нужна Java ${need}+, у тебя ${have}. Обнови Java`);

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
      const r = await inst.installForge({ version: loaderVersion, mcversion: mcVersion }, gameDir, { java: javaPath, agent: farcipalAgent, concurrency: concurrency});
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
    gamePath: instance, resourcePath: gameDir, javaPath, version: versionId,
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
