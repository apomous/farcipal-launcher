// Настройки лаунчера. Меняй под свой сервер и сайт.
module.exports = {
  name: "FARCIPAL",
  // Папка игры: %APPDATA%/.farcipal (Windows)
  gameDirName: ".farcipal",
  // Сервер, на который можно заходить кнопкой «Играть» (оставь host пустым, если не нужен)
  server: { name: "Farcipal SMP", host: "", port: 25565 },
  // Новости в правой колонке. Потом можно заменить на загрузку JSON с твоего сайта.
  news: [
    { title: "Лаунчер запущен", text: "Первая сборка. Выбирай версию и жми «Играть».", tag: "лаунчер" }
  ],
  // Azure-приложение для входа через Microsoft. Пусто = используется стандартный client id msmc.
  msClientId: "",
  discordClientId: "1566845844961886238"
};
