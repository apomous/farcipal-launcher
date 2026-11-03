const fs = require('fs');
const path = require('path');
const crypto = require('crypto'); 
const { fetch } = require('undici'); 
const { farcipalAgent } = require('./network');

async function ensureAssets(gameDir, indexId, concurrency = 4, onProgress) {
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
            const obj = objects[index++];
            const hash = obj.hash;
            const prefix = hash.substring(0, 2);
            const dest = path.join(outputDir, prefix, hash);
            const url = `https://resources.download.minecraft.net/${prefix}/${hash}`;

            let needsDownload = true;
            if (fs.existsSync(dest)) {
                const stat = fs.statSync(dest);
                if (stat.size === obj.size) {
                    // ЧИТАЕМ ФАЙЛ И СЧИТАЕМ SHA1
                    const fileBuffer = fs.readFileSync(dest);
                    const fileHash = crypto.createHash('sha1').update(fileBuffer).digest('hex');
                    if (fileHash === hash) {
                        needsDownload = false; // Файл идеален, @xmcl будет счастлив
                    }
                }
            }

            if (!needsDownload) {
                completed++;
                downloadedBytes += obj.size;
                consecutiveFailures = 0;
                if (onProgress && completed % 100 === 0) {
                    onProgress({ task: Math.floor(downloadedBytes / 1048576), total: Math.ceil(totalBytes / 1048576) });
                }
                continue;
            }

            let success = false;
            let retries = 0;
            while (!success && retries < 10) {
                try {
                    const res = await fetch(url, { dispatcher: farcipalAgent });
                    if (!res.ok) throw new Error(`HTTP ${res.status}`);
                    const buffer = await res.arrayBuffer();
                    fs.mkdirSync(path.dirname(dest), { recursive: true });
                    fs.writeFileSync(dest, Buffer.from(buffer));
                    success = true;
                } catch (e) {
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
                onsecutiveFailures++;
                if (consecutiveFailures >= MAX_FAILURES) {
                    isAborted = true;
                    throw new Error(`[Сеть] Слишком много ошибок подряд (${MAX_FAILURES}). Похоже, интернет или VPN полностью отвалились.`);
                }
                index--; 
            }
        }
    }

    const workers = Array.from({ length: concurrency }, () => worker());
     try {
        await Promise.all(workers);
    } catch (e) {
        throw e;
    }
}

module.exports = { ensureAssets };