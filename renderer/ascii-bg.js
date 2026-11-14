
// renderer/ascii-bg.js
// ASCII-сцена на заднем плане. Показывается только в двух состояниях (управляет companion.js):
//   "load" — пока идёт загрузка/подготовка запуска (кольцо и капли вокруг прогресс-бара)
//   "link" — на вкладке «Вместе» (две капли; setLinked(true) сливает их в одну)
// Цвет берётся у компаньона (цвет режима), сцена монохромная и растворяется к краям.
const RAMP = " .,:;i1tfLCG08@";            // 16 градаций, длина = LEVELS в ascii-worker.js
const LEVELS = RAMP.length;
const FPS = 60;
const LINK_BASE = [61, 207, 111];   // зелёная база кристаллов (НЕ наследует янтарь глаза)
const LINK_HOT  = [232, 180, 90];   // янтарь вспышки удара
const LINK_ALPHA = 0.75;
const LINK_FPS = 60;    
const ANCHOR_LINK = { x: 0.62, y: 0.80 };   
const BASE_ALPHA = 0.30; // яркость для не-link сцен (load/заглушки)         // выше, чтобы вспышки не мерцали через parity
 
class ASCIIBackground {
  constructor() {
    this.canvas = document.getElementById("ascii-bg") || this._makeCanvas();
    this.ctx = this.canvas.getContext("2d", { alpha: true });
    this.worker = new Worker("ascii-worker.js");
 
    this.scene = null;          // что рисуем сейчас
    this.want = null;           // что хотим (смена идёт через плавное затухание)
    this.opacity = 0;
    this.target = 0;
    this.col = [61, 207, 111];
    this.anchor = { x: 0.5, y: 0.5 };
    this.anchorT = { x: 0.5, y: 0.5 };
    this.focal = 1.8;
    this.sep = 1.3;
    this.linked = false;
    this.t = 0;
 
    this.frame = null;          // { w, h, data }
    this.busy = false;
    this.dirty = false;
    this.lastRender = 0;
    this.lastDrawOpacity = -1;
    this.idle = true;
    this.bucketsL=Array.from({length:LEVELS},()=>[]); this.bucketsH=Array.from({length:16},()=>[]);
 
    this.worker.onmessage = (e) => {
  const { w, h, buf } = e.data;
  this.frame = { w, h, buf: new Uint8Array(buf) };
  this.busy = false;
  this.dirty = true;
};
 
    this.resize();
    window.addEventListener("resize", () => this.resize());
  }
 
  _makeCanvas() {
    const c = document.createElement("canvas");
    c.id = "ascii-bg";
    c.setAttribute("aria-hidden", "true");
    c.style.cssText = "position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:-1";
    // кладём внутрь #shake (там весь интерфейс) и даём ему свой слой: канвас всегда между фоном окна и интерфейсом,
    // раскладку это не меняет
    const host = document.getElementById("shake") || document.body;
    host.style.isolation = "isolate";
    host.insertBefore(c, host.firstChild);
    return c;
  }
 
  resize() {
    this.W = window.innerWidth; this.H = window.innerHeight;
    this.dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    this.canvas.width = Math.round(this.W * this.dpr);
    this.canvas.height = Math.round(this.H * this.dpr);
    const ctx = this.ctx;
    const charH = Math.max(8, Math.min(11, Math.round(this.H / 164))); // плотная сетка: пол и тени читаются   // мельче символы = чётче фигуры
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.font = `${charH}px "JetBrains Mono","Consolas","Courier New",monospace`;
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    const charW = ctx.measureText("M").width || charH * 0.6;
    this.cols = Math.max(20, Math.ceil(this.W / charW));
    this.rows = Math.max(10, Math.ceil(this.H / charH));
    this.cellW = this.W / this.cols; this.cellH = this.H / this.rows;
    this.frame = null; this.dirty = false;
  }
 
  // ---- API (вызывает companion.js каждый кадр; повторные вызовы дешёвые)
  setScene(name) {                    // "load" | "link" | null
    if (name === this.want) return;
    this.want = name;
    this._wake();
  }
  setColor(c) { this.col = c; }
  setAnchor(x, y) { this.anchorT.x = x; this.anchorT.y = y; }
  setLinked(v) { this.linked = !!v; }  // true — капли сливаются (соединение установлено)
 
  _wake() {
    if (!this.idle) return;
    this.idle = false;
    this.lastTime = performance.now();
    requestAnimationFrame((t) => this.loop(t));
  }
 
  loop(now) {
    const dt = Math.min((now - this.lastTime) / 1000, 0.1);
    this.lastTime = now;
    this.t += dt * 0.5;
 
    // смена сцены: сперва гаснем, потом переключаем
    if (this.want !== this.scene) {
      this.target = 0;
      if (this.opacity < 0.03) {
        this.scene = this.want; this.frame = null; this.dirty = false;
        if (this.scene === "load") { this.focal = 2.6; this.anchor.x = this.anchorT.x; this.anchor.y = this.anchorT.y; }
        if (this.scene === "link") { this.focal = 2.3; this.anchorT.x = ANCHOR_LINK.x; this.anchorT.y = ANCHOR_LINK.y; this.anchor.x = ANCHOR_LINK.x; this.anchor.y = ANCHOR_LINK.y; }
      }
    } else this.target = this.scene ? 1 : 0;
 
    this.opacity += (this.target - this.opacity) * Math.min(1, dt * 4);
    if (this.opacity < 0.01 && this.target === 0 && !this.scene) {      // полностью погасли: останавливаем цикл
      this.opacity = 0;
      this.ctx.clearRect(0, 0, this.W, this.H);
      this.lastDrawOpacity = -1; this.idle = true;
      return;
    }
    if (this.scene === "link") this.anchorT.x = ANCHOR_LINK.x, this.anchorT.y = ANCHOR_LINK.y;
    const k = Math.min(1, dt * 5);
    this.anchor.x += (this.anchorT.x - this.anchor.x) * k;
    this.anchor.y += (this.anchorT.y - this.anchor.y) * k;
    const sepT = this.linked ? 0.12 : 1.3 + 0.25 * Math.sin(this.t * 0.9);
    this.sep += (sepT - this.sep) * Math.min(1, dt * 1.6);
 
    // новый кадр у воркера (не чаще FPS и только если он не занят)
    if (this.scene && !this.busy && !document.hidden && now - this.lastRender >= 1000/(this.scene==="link"?LINK_FPS:FPS)) {
      this.lastRender = now; this.busy = true;
      this.worker.postMessage({
        w: this.cols, h: this.rows, t: this.t, scene: this.scene, sep: this.sep,
        ax: this.anchor.x, ay: this.anchor.y, ar: this.W / this.H, focal: this.focal,
      });
    }
 
    // перерисовка только когда пришёл кадр или заметно изменилась прозрачность
    if (this.frame && (this.dirty || Math.abs(this.opacity - this.lastDrawOpacity) > 0.02)) {
      this.draw();
      this.dirty = false; this.lastDrawOpacity = this.opacity;
    }
    requestAnimationFrame((t) => this.loop(t));
  }
 
  draw() {
    const {w,h,buf}=this.frame; if(w!==this.cols||h!==this.rows)return;
    const ctx=this.ctx, BL=this.bucketsL, BH=this.bucketsH, cw=this.cellW, ch=this.cellH;
    const HOT_MIN=4;   // с этого уровня янтаря клетка рисуется ТОЛЬКО янтарём (один глиф вместо каши из двух)
    for(let i=0;i<LEVELS;i++)BL[i].length=0; for(let i=0;i<16;i++)BH[i].length=0;
    for(let i=0;i<buf.length;i++){
      const b=buf[i], lv=b>>4, ht=b&15;
      if(ht>=HOT_MIN) BH[ht].push(i); else if(lv) BL[lv].push(i);
    }
    ctx.clearRect(0,0,this.W,this.H);
    const base = this.scene==="link"?LINK_BASE:this.col;
    const alpha = this.scene==="link"?LINK_ALPHA:BASE_ALPHA;
    ctx.fillStyle=`rgb(${base[0]|0},${base[1]|0},${base[2]|0})`; ctx.textBaseline="middle";
    for(let lv=1;lv<LEVELS;lv++){ const list=BL[lv]; if(!list.length)continue;
      ctx.globalAlpha=this.opacity*alpha*(0.3+0.7*(lv/(LEVELS-1))); const chr=RAMP[lv];
      for(let n=0;n<list.length;n++){ const idx=list[n]; ctx.fillText(chr,(idx%w)*cw+cw*0.5,((idx/w)|0)*ch+ch*0.5); } }
    // янтарь попадания: обычное наложение, цвет плавно уходит от зелёного к янтарю по силе удара
    for(let ht=HOT_MIN;ht<16;ht++){ const list=BH[ht]; if(!list.length)continue;
      const k=ht/15;
      ctx.fillStyle=`rgb(${(base[0]+(LINK_HOT[0]-base[0])*k)|0},${(base[1]+(LINK_HOT[1]-base[1])*k)|0},${(base[2]+(LINK_HOT[2]-base[2])*k)|0})`;
      ctx.globalAlpha=this.opacity*Math.min(1,alpha*1.6+0.25*k);
      for(let n=0;n<list.length;n++){ const idx=list[n];
        const lv=Math.max(buf[idx]>>4, 6+((k*9)|0)); const chr=RAMP[Math.min(LEVELS-1,lv)];
        ctx.fillText(chr,(idx%w)*cw+cw*0.5,((idx/w)|0)*ch+ch*0.5); } }
    ctx.globalAlpha=1;
  }
}
// глобально, чтобы companion.js и app.js могли им управлять
window.ASCII_BG = new ASCIIBackground();
 