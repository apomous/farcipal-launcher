const fs = require('fs');
const path = require('path');
const crypto = require('crypto'); 
const { fetch } = require('undici'); 
const { farcipalAgent } = require('./network');


async function readBody(res, kind = "arrayBuffer", timeoutMs = 65000, signal) {
    let timer;
    try {
        const bodyPromise = res[kind]();
        const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("Таймаут чтения тела ответа")), timeoutMs);
        });
        const signalPromise = signal ? new Promise((_, reject) => {
            if (signal.aborted) return reject(new Error("Отменено"));
            signal.addEventListener("abort", () => reject(new Error("Отменено")), { once: true });
        }) : null;
        return await Promise.race(signalPromise ? [bodyPromise, timeoutPromise, signalPromise] : [bodyPromise, timeoutPromise]);
    } finally {
        clearTimeout(timer);
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
    let isAborted = false;
    const totalBytes = objects.reduce((acc, obj) => acc + obj.size, 0);
    

    async function worker() {
         while (index < objects.length && !isAborted) {
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
        retries++;
        if (hooks && hooks.cancel && hooks.cancel.cancelled) {
        isAborted = true;
        throw new Error("Отменено");
        }
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
    if (consecutiveFailures >= MAX_FAILURES) {
        isAborted = true;
        throw new Error(`[Сеть] Слишком много ошибок подряд (${MAX_FAILURES}). Похоже, интернет или VPN полностью отвалились.`);
    }
    index--; 
   }
  }
}

const workers = Array.from({ length: concurrency }, () => worker());   
await Promise.all(workers);          
}

module.exports = { ensureAssets };