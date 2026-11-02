const fs = require('fs');
const path = require('path');

// Указываем точный путь к твоему файлу индекса
const indexFile = 'C:\\Users\\Apomous D\\AppData\\Roaming\\.farcipal\\assets\\indexes\\34.json';
// Папка, куда будем качать (objects)
const outputDir = 'C:\\Users\\Apomous D\\AppData\\Roaming\\.farcipal\\assets\\objects';

if (!fs.existsSync(indexFile)) {
    console.error("❌ Файл индекса не найден по пути:", indexFile);
    process.exit(1);
}

const indexData = JSON.parse(fs.readFileSync(indexFile, 'utf8'));
const objects = Object.values(indexData.objects);
let completed = 0;
let index = 0;

async function worker() {
    while (index < objects.length) {
        const obj = objects[index++];
        const hash = obj.hash;
        const prefix = hash.substring(0, 2);
        const url = `https://resources.download.minecraft.net/${prefix}/${hash}`;
        const dest = path.join(outputDir, prefix, hash);
        
        if (fs.existsSync(dest)) {
            completed++;
            continue;
        }

        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            const buffer = await res.arrayBuffer();
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            fs.writeFileSync(dest, Buffer.from(buffer));
        } catch (e) {
            console.error(`❌ Ошибка ${hash}: ${e.message}`);
            index--; // Попробовать снова
            await new Promise(r => setTimeout(r, 1000));
            continue;
        }
        
        completed++;
        if (completed % 100 === 0 || completed === objects.length) {
            console.log(`📦 Скачано ассетов: ${completed} / ${objects.length}`);
        }
    }
}

async function main() {
    console.log(`🚀 Всего файлов для скачивания: ${objects.length}`);
    console.log(`⏳ Начинаю скачивание в 4 потока...`);
    
    // Запускаем 4 параллельных потока
    const workers = Array.from({ length: 4 }, () => worker());
    await Promise.all(workers);
    
    console.log("✅ Все ассеты успешно скачаны!");
}

main();