const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { fetch } = require('undici');
const { farcipalAgent } = require('./network');


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
async function ensureAssets(gameDir, indexId, concurrency = 4, onProgress, hooks, signal) {
    const indexFile = path.join(gameDir, 'assets', 'indexes', indexId + '.json');
    const outputDir = path.join(gameDir, 'assets', 'objects');

    if (!fs.existsSync(indexFile)) throw new Error(`Файл индекса не найден: ${indexFile}. Возможно, версия не скачалась полностью.`);

    const indexData = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
    const objects = Object.values(indexData.objects);
    let completed = 0;
    let index = 0;
    let downloadedBytes = 0;
    let consecutiveFailures = 0;
    const MAX_FAILURES = 30;
    const failedAttempts = new Map();   // счётчик неудач на конкретный объект — без бесконечного requeue
    let isAborted = false;
    const totalBytes = objects.reduce((acc, obj) => acc + obj.size, 0);


    async function worker() {
         while (index < objects.length && !isAborted) {
            // если другой воркер уже упал фатально — выходим, не качаем дальше
            if (isAborted) return;
            if (hooks && hooks.cancel && hooks.cancel.cancelled) {
              isAborted = true;
              throw new Error("Отменено");
            }
            const obj = objects[index++];
            const hash = obj.hash;
            const prefix = hash.substring(0, 2);
            const dest = path.join(outputDir, prefix, hash);
            const url = `https://resources.download.minecraft.net/${prefix}/${hash}`;

            let needsDownload = true;
            if (fs.existsSync(dest)) {
                const stat = fs.statSync(dest);
                if (stat.size === obj.size) {
                    try {
                                                const fileHash = crypto.createHash('sha1');
                        const stream = fs.createReadStream(dest);
                        for await (const chunk of stream) {
                            fileHash.update(chunk);
                        }
                if (fileHash.digest('hex') === hash) {
                needsDownload = false;
            }
        } catch (err) {
                        // Если файл заблокирован (EBUSY) или нет прав — качаем заново
                        needsDownload = true;
        }
    }
}

let success = !needsDownload;
let retries = 0;
while (!success && retries < 10) {
    try {
        const res = await fetch(url, { dispatcher: farcipalAgent, signal });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buffer = await readBody(res, "arrayBuffer", 65000, signal);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        await fs.promises.writeFile(dest, Buffer.from(buffer));
        success = true;
    } catch (e) {
        // отмена — не ретраим, выходим сразу (иначе висящий fetch съест всю паузу до checkCancel)
        if ((hooks && hooks.cancel && hooks.cancel.cancelled) || e.cancelled || (signal && signal.aborted)) {
        isAborted = true;
        throw new Error("Отменено");
        }
        retries++;
        await new Promise(r => setTimeout(r, 1000));
    }
}

if (success) {
    completed++;
    downloadedBytes += obj.size;
    consecutiveFailures = 0;
    if (onProgress) {
        onProgress({ task: Math.floor(downloadedBytes / 1048576), total: Math.ceil(totalBytes / 1048576) });
    }
} else if (!isAborted) {
    consecutiveFailures++;
    // лимит неудач на конкретный объект: не гоняем битый файл по кругу бесконечно
    const objFails = (failedAttempts.get(hash) || 0) + 1;
    failedAttempts.set(hash, objFails);
    if (objFails >= 3) {
        isAborted = true;   // фатально для этого объекта — останавливаем всех воркеров
        throw new Error(`Не удалось скачать объект ассетов ${hash} после ${objFails} попыток.`);
    }
    if (consecutiveFailures >= MAX_FAILURES) {
        isAborted = true;
        throw new Error(`[Сеть] Слишком много ошибок подряд (${MAX_FAILURES}). Похоже, интернет или VPN полностью отвалились.`);
    }
    index--;
   }
  }
}

const workers = Array.from({ length: concurrency }, () => worker());
await Promise.allSettled(workers).then((results) => {   // фатальная ошибка одного воркера останавливает всех
  isAborted = true;                                      // после завершения цикла больше никто не качает
  const failed = results.find((r) => r.status === "rejected");
  if (failed) throw failed.reason;
});
}

module.exports = { ensureAssets };