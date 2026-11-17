// Все различия между Windows и Linux в одном месте.
const isWin = process.platform === "win32";

module.exports = {
  isWin,
  // имя файла Java, который ищем после распаковки
  javaExeName: isWin ? "javaw.exe" : "java",
  // параметры для Adoptium (скачивание Java >= 21)
  adoptiumOs: isWin ? "windows" : "linux",
  adoptiumArch: isWin ? "x64" : (process.arch === "arm64" ? "aarch64" : "x64"),
  // Windows получает zip, Linux получает tar.gz
  javaArchiveExt: isWin ? "zip" : "tar.gz",
};
