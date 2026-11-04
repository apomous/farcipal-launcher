const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("launcher", {
  config: () => ipcRenderer.invoke("config:get"),
  versions: () => ipcRenderer.invoke("versions:list"),
  loaderGames: (type) => ipcRenderer.invoke("loader:games", type),
  loaderVersions: (type, mc) => ipcRenderer.invoke("loader:versions", { type, mc }),
  session: () => ipcRenderer.invoke("auth:session"),
  login: () => ipcRenderer.invoke("auth:microsoft"),
  logout: () => ipcRenderer.invoke("auth:logout"),
  play: (opts) => ipcRenderer.invoke("game:play", opts),
  stop: () => ipcRenderer.invoke("game:stop"),
  // магазин модов и ресурспаков (Modrinth)
  storeSearch: (o) => ipcRenderer.invoke("store:search", o),
  storePreview: (o) => ipcRenderer.invoke("store:preview", o),
  storeInstalled: (o) => ipcRenderer.invoke("store:installed", o),
  storeInstall: (o) => ipcRenderer.invoke("store:install", o),
  storeRemove: (o) => ipcRenderer.invoke("store:remove", o),
  storeFolder: (o) => ipcRenderer.invoke("store:folder", o),
  updateState: () => ipcRenderer.invoke("update:state"),
  updateInstall: () => ipcRenderer.invoke("update:install"),
  appVersion: () => ipcRenderer.invoke("app:version"),

  settings: { get: () => ipcRenderer.invoke("settings:get"), set: (s) => ipcRenderer.invoke("settings:set", s) },
  win: (action) => ipcRenderer.send("win:" + action),
  on: (channel, fn) => {
    const allowed = ["game:log", "game:progress", "game:state", "store:progress", "store:progress", "update:status"];
    if (!allowed.includes(channel)) return;
    ipcRenderer.on(channel, (_e, data) => fn(data));

  },
  news: {
    get: () => ipcRenderer.invoke("news:get")
  }
});
