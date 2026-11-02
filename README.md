<img width="256" height="256" alt="farcipal-icon-512" src="https://github.com/user-attachments/assets/0d787f9f-9202-49d4-94f8-1cb335602620" />

# FARCIPAL Launcher

Лаунчер Minecraft Java на Electron: Vanilla, Fabric и Forge. Дизайн и глаз-компаньон из FARCIPAL EYE.

## Запуск

```
pnpm install       # или npm install, если у твоей версии @xmcl нет workspace-зависимостей
pnpm start         # открыть приложение
pnpm dist          # собрать portable .exe в dist/
```

Если `npm install` падает с `EUNSUPPORTEDPROTOCOL workspace:*`, ставь через pnpm: часть пакетов `@xmcl` публикуется с этим протоколом.

## Java

Нужная версия берётся из JSON выбранной версии игры, лаунчер сам скажет, если Java старая:

| Версия игры | Java |
| --- | --- |
| 1.18 – 1.20.4 | 17+ |
| 1.20.5 – 1.21.x | 21+ |
| 26.x и новее | 25+ |

Java ставится вручную (например, Temurin с adoptium.net). Для Forge она нужна и во время установки.

## Что внутри

- `main.js`: окно, IPC, вход через Microsoft (msmc), профиль для запуска.
- `game.js`: `installAndLaunch`. Ваниль (база) → загрузчик → зависимости → запуск, через `@xmcl/core` и `@xmcl/installer`.
- `loaders.js`: списки версий Fabric (Fabric Meta) и Forge (maven-metadata + promotions), установка профиля Fabric.
- `preload.js`: безопасный мост между окном и `main.js`.
- `config.js`: сервер для автозахода, новости, папка игры.
- `renderer/`: интерфейс; `companion.js`: глаз и живая сеть нитей. API: `Companion.slam()`, `Companion.phase('idle'|'loading'|'running'|'error')`. Элементы, за которые цепляется сеть, задаются селектором в `app.js` (`targets: ".panel, .card, .play"`).
- `build/`: иконка для `.exe`.

## Загрузчики

- **Vanilla**: чистая игра.
- **Fabric**: профиль берётся с Fabric Meta и кладётся в `versions/`, библиотеки докачивает установщик.
- **Forge**: `installForge`, версии 1.12 и новее. Повторный запуск ничего не ставит заново.

В списке версий игры при выбранном загрузчике остаются только те, которые он поддерживает.

## Вход и демо

Игровая папка: `%APPDATA%\.farcipal`. Журнал последнего запуска: `launcher-last.log` в ней же, его можно прислать при проблемах.

Без входа игра запускается в демо-режиме Mojang (флаг `--demo`, ограничение накладывает сам клиент). С Microsoft-аккаунтом без купленной игры тоже запустится демо.

## Не сделано

- Автоскачивание Java.
- Загрузка новостей с сайта (сейчас список в `config.js`).
- NeoForge и Quilt, управление модами.
Farcipal Launcher is not an official Minecraft product. Not approved by or associated with Mojang or Microsoft.
