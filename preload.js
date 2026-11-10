const { contextBridge, ipcRenderer } = require("electron");
const wrappers = new WeakMap();
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
   // апдейтер
  updateState: () => ipcRenderer.invoke("update:state"),
  updateInstall: () => ipcRenderer.invoke("update:install"),
  appVersion: () => ipcRenderer.invoke("app:version"),  
   // тунель 
  tunnelJoin: (code, playerName) => ipcRenderer.invoke('tunnel:join', code, playerName),
  tunnelClose: () => ipcRenderer.invoke('tunnel:close'),
  tunnelHost: (playerName) => ipcRenderer.invoke('tunnel:host', playerName),
  exportModpack: (mc, loader) => ipcRenderer.invoke("modpack:export", { mc, loader }),
  importModpack: (mc, loader, code) => ipcRenderer.invoke("modpack:import", { mc, loader, code }),
  

  settings: { get: () => ipcRenderer.invoke("settings:get"), set: (s) => ipcRenderer.invoke("settings:set", s) },
  win: (action) => ipcRenderer.send("win:" + action),
  on: (channel, fn) => {
    const allowed = ["game:log", "game:progress", "game:state", "store:progress", "update:status","tunnel:code", "tunnel:error", "tunnel:player-join", "tunnel:player-leave", "tunnel:closed"];
    if (!allowed.includes(channel)) return;
    const wrapped = (_e, data) => fn(data);
    wrappers.set(fn, wrapped);
    ipcRenderer.on(channel, wrapped);
  },
  off: (channel, fn) => {
     const allowed = [
      "game:log", "game:progress", "game:state", 
      "store:progress", "update:status", 
      "tunnel:code", "tunnel:error", "tunnel:player-join", "tunnel:player-leave", "tunnel:closed"];
  if (!allowed.includes(channel)) return;
  const wrapped = wrappers.get(fn);
  if (wrapped) {
      ipcRenderer.removeListener(channel, wrapped);
      wrappers.delete(fn);
    }
},
  news: {
    get: () => ipcRenderer.invoke("news:get")
  }
});
