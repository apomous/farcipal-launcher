// renderer/ascii-worker.js
// Два зелёных кристалла перестреливаются файрболами. В точке попадания — янтарная вспышка + ударное кольцо.
// Выход: 1 байт/клетка. hi nibble = яркость (0..LEVELS-1), lo nibble = янтарь (0..15).
//
// Что исправлено относительно прошлой версии:
//  * оба кристалла стреляют ВСЕГДА (linked лишь чуть усиливает вспышку)
//  * файрбол летит от грани к грани (точка входа/выхода считается по SDF с учётом поворота),
//    а не в центр; удар вспыхивает ровно там, где шар касается грани
//  * тест глубины: шар прячется за кристаллом, а не просвечивает насквозь
//  * настоящие рёбра: id грани на пиксель -> граница между гранями/силуэт = яркая линия
//  * вспышка = пятно на грани + расходящееся кольцо + bloom в экранном пространстве
const LEVELS = 15;                 // = длина RAMP в ascii-bg.js

const CRX = 0.40, CRY = 0.74, CRZ = 0.40;
const CMIN = 1/Math.sqrt(1/(CRX*CRX)+1/(CRY*CRY)+1/(CRZ*CRZ));   // честная липшиц-константа L1-нормы (раньше 0.40 завышала шаг в ~1.5 раза и лучи пролетали сквозь кристалл)

const GAP = 1.9;
const AYAW = 0.32, APITCH = 0.42, BYAW = -0.32, BPITCH = 0.42;

const V_SOFT = 0.16, V_HARD = 0.40;
const H_EDGE = 0.82;

const FLY = 0.78;                  // доля цикла на полёт
const WD  = 0.30;                  // спад вспышки
const BOUND = 2.6;
const FIRE_HEAT = 0.75;            // 0 = файрбол зелёный, 1 = полностью янтарный
const CA = 0.6;                    // поправка: клетка выше, чем шире

const len3 = (x,y,z)=>Math.sqrt(x*x+y*y+z*z)||1;
const clamp=(x,lo,hi)=>x<lo?lo:x>hi?hi:x;
const smoothstep=(a,b,x)=>{const t=clamp((x-a)/(b-a),0,1);return t*t*(3-2*t);};
const hash=(x,y,z)=>{const n=Math.sin(x*127.1+y*311.7+z*74.7)*43758.5453;return n-Math.floor(n);};

function rot(x,y,z,yaw,pitch){
  let c=Math.cos(yaw),s=Math.sin(yaw); let nx=x*c+z*s, nz=-x*s+z*c; x=nx; z=nz;
  c=Math.cos(pitch); s=Math.sin(pitch); let ny=y*c-z*s; nz=y*s+z*c; y=ny; z=nz;
  return [x,y,z];
}
function sd(st,x,y,z){
  const [lx,ly,lz]=rot(x-st.c[0],y-st.c[1],z-st.c[2],st.yaw,st.pitch);
  return (Math.abs(lx)/CRX + Math.abs(ly)/CRY + Math.abs(lz)/CRZ - 1) * CMIN;
}

const bez=(s,c,d,p)=>{const u=1-p;return [u*u*s[0]+2*u*p*c[0]+p*p*d[0], u*u*s[1]+2*u*p*c[1]+p*p*d[1], u*u*s[2]+2*u*p*c[2]+p*p*d[2]];};

// станции стоят на месте, только чуть покачиваются по высоте (повороты не трогаем — рёбра не плывут)
function makeStations(t){
  return [
    { c:[-GAP, 0.07*Math.sin(t*2.2),     0], yaw:AYAW, pitch:APITCH },
    { c:[ GAP, 0.07*Math.sin(t*2.2+2.1), 0], yaw:BYAW, pitch:BPITCH },
  ];
}

// [src, dst, side(z), arc(y), speed, phaseOffset]
const ARC_DEFS = [
  [0,1, 0.00,0.85,0.40,0.00],
  [0,1, 0.45,0.60,0.38,0.50],
  [1,0, 0.00,0.85,0.40,0.25],
  [1,0,-0.45,0.60,0.38,0.75],
];

// участок кривой между гранью источника и гранью цели
function buildArcs(st){
  const arcs=[];
  for(const [src,dst,side,arc,spd,off] of ARC_DEFS){
    const s=st[src].c, d=st[dst].c;
    const ctrl=[(s[0]+d[0])/2,(s[1]+d[1])/2+arc,(s[2]+d[2])/2+side];
    const N=48; let p0=0,p1=1,k1=N;
    for(let k=0;k<=N;k++){const P=bez(s,ctrl,d,k/N); if(sd(st[src],P[0],P[1],P[2])>0.03){p0=k/N;break;}}
    for(let k=Math.round(p0*N);k<=N;k++){const P=bez(s,ctrl,d,k/N); if(sd(st[dst],P[0],P[1],P[2])<=0){k1=k;break;}}
    let lo=Math.max(0,(k1-1)/N), hi=k1/N;
    for(let it=0;it<6;it++){const m=(lo+hi)/2,P=bez(s,ctrl,d,m); if(sd(st[dst],P[0],P[1],P[2])<=0)hi=m; else lo=m;}
    p1=hi;
    arcs.push({s,ctrl,d,spd,off,target:dst,p0,p1});
  }
  return arcs;
}

self.onmessage=function(e){
  const {w,h,t,scene,sep,ax,ay,ar,focal}=e.data;
  const linked = scene==="link" && sep<0.5;
  const gain = linked ? 1.0 : 0.8;

  const st=makeStations(t);
  const arcs=buildArcs(st);
  const sparks=[];
  for(const a of arcs){
    const phi=((t*a.spd+a.off)%1+1)%1;
    let flash=0, age=1;
    if(phi>=FLY){ age=(phi-FLY)/(1-FLY); flash=Math.exp(-age/WD)*gain; }
    a.phi=phi;
    sparks.push({impact:bez(a.s,a.ctrl,a.d,a.p1),flash,age,target:a.target});
  }

  // камера (статичная)
  const BR=BOUND, ang=0.18;
  const rox=Math.sin(ang)*4.6, roy=1.35, roz=-Math.cos(ang)*4.6;
  const fl=len3(-rox,-0.1-roy,-roz);
  const fx=-rox/fl, fy=(-0.1-roy)/fl, fz=-roz/fl;
  const rl=Math.sqrt(fz*fz+fx*fx)||1;
  const rtx=fz/rl, rty=0, rtz=-fx/rl;
  const upx=fy*rtz-fz*rty, upy=fz*rtx-fx*rtz, upz=fx*rty-fy*rtx;
  const L1=len3(-0.5,0.85,0.4), l1x=-0.5/L1,l1y=0.85/L1,l1z=0.4/L1;
  const L2=len3(0.7,-0.3,0.55), l2x=0.7/L2,l2y=-0.3/L2,l2z=0.55/L2;
  const roDot=rox*rox+roy*roy+roz*roz;
  const cys=1-ay*2;
  const dustT=Math.floor(t*1.5);

  const maskAt=(ex,ey)=>(1-smoothstep(V_SOFT,V_HARD,Math.abs(ey-ay)))*(1-smoothstep(H_EDGE,1.0,Math.abs(ex-ax)));
  const proj=(P)=>{
    const rx=P[0]-rox, ry=P[1]-roy, rz=P[2]-roz;
    const beta=(rx*fx+ry*fy+rz*fz)/focal; if(beta<=0.2) return null;
    const uu=(rx*rtx+ry*rty+rz*rtz)/beta, vv=(rx*upx+ry*upy+rz*upz)/beta;
    return {sx:(uu/(ar*0.9)+1)*w*0.5, sy:(1-vv-cys)*h*0.5, dist:Math.sqrt(rx*rx+ry*ry+rz*rz), beta};
  };

  const lumB=new Float32Array(w*h), hotB=new Float32Array(w*h), maskB=new Float32Array(w*h);
  const depthB=new Float32Array(w*h).fill(Infinity);
  const ids=new Uint8Array(w*h);

  const world=(x,y,z)=>Math.min(sd(st[0],x,y,z),sd(st[1],x,y,z));

  // ── 1) маршинг кристаллов ──
  for(let j=0;j<h;j++){
    const v=(1.0-(2.0*(j+0.5))/h)-cys;
    const ey=(j+0.5)/h;
    for(let i=0;i<w;i++){
      const ex=(i+0.5)/w;
      const mask=maskAt(ex,ey);
      if(mask<=0.01) continue;
      maskB[j*w+i]=mask;
      const u=(2.0*ex-1.0)*ar*0.9;
      let rx=rtx*u+upx*v+fx*focal, ry=rty*u+upy*v+fy*focal, rz=rtz*u+upz*v+fz*focal;
      const rn=len3(rx,ry,rz); rx/=rn;ry/=rn;rz/=rn;
      const b=rox*rx+roy*ry+roz*rz, cc=roDot-BR*BR, disc=b*b-cc;
      let lum=0,hot=0,hit=false,dist=0;
      if(disc>=0&&b<0){
        let d0=-b-Math.sqrt(disc); if(d0<0)d0=0; dist=d0;
        for(let s=0;s<64;s++){
          const d=world(rox+rx*dist,roy+ry*dist,roz+rz*dist);
          if(d<0.0015){hit=true;break;} dist+=d; if(dist>d0+BR*2)break;
        }
      }
      const k=j*w+i;
      if(hit){
        const px=rox+rx*dist, py=roy+ry*dist, pz=roz+rz*dist;
        const tgt=(sd(st[0],px,py,pz)<sd(st[1],px,py,pz))?0:1;
        depthB[k]=dist;
        // id грани = кристалл + октант в его локальной системе
        const S=st[tgt]; const [lx,ly,lz]=rot(px-S.c[0],py-S.c[1],pz-S.c[2],S.yaw,S.pitch);
        ids[k]=1+tgt*8+((lx>0?1:0)|(ly>0?2:0)|(lz>0?4:0));

        const e=0.0015;
        const wa=world(px+e,py-e,pz-e),wb=world(px-e,py-e,pz+e),wc=world(px-e,py+e,pz-e),wd=world(px+e,py+e,pz+e);
        let nx=wa-wb-wc+wd,ny=-wa-wb+wc+wd,nz=-wa+wb-wc+wd; const nl=len3(nx,ny,nz); nx/=nl;ny/=nl;nz/=nl;
        // точечный ключевой свет: даёт плавный градиент ВНУТРИ плоской грани, а не одну яркость на грань
        let kx=-2.6-px, ky=3.2-py, kz=-2.4-pz; const kl=len3(kx,ky,kz); kx/=kl;ky/=kl;kz/=kl;
        const att=clamp(1.2-kl*0.11,0.35,1);
        const diff=Math.max(nx*kx+ny*ky+nz*kz,0)*att*0.95 + Math.max(nx*l2x+ny*l2y+nz*l2z,0)*0.22;
        let hx=kx-rx,hy=ky-ry,hz=kz-rz; const hl=len3(hx,hy,hz); hx/=hl;hy/=hl;hz/=hl;
        const spec=Math.pow(Math.max(nx*hx+ny*hy+nz*hz,0),48)*0.9;
        const ndv=Math.max(-(nx*rx+ny*ry+nz*rz),0);
        const rim=Math.pow(1-ndv,3)*0.16;                          // мягкая подсветка к краям
        const grad=0.5+0.5*clamp(ly/CRY,-1,1);                      // вертикальный градиент: низ тёмный, верх светлее
        const base=0.04+0.20*grad;
        lum=clamp(base+diff*0.80+spec+rim,0,1);

        for(const sp of sparks){ if(sp.target!==tgt||sp.flash<=0.01)continue;
          const dx=px-sp.impact[0],dy=py-sp.impact[1],dz=pz-sp.impact[2];
          const d2=dx*dx+dy*dy+dz*dz, d=Math.sqrt(d2);
          const rr=0.12+0.75*sp.age;                         // ударное кольцо
          const ring=Math.exp(-(d-rr)*(d-rr)/0.012)*(1-sp.age)*0.7;
          hot+=sp.flash*(Math.exp(-d2/0.035)+ring);
        }
        hot=clamp(hot,0,1);
        lum=clamp(lum+hot*0.5,0,1);
      } else if(hash(i,j,dustT)>0.996){
        lum=0.16;
      }
      lumB[k]=lum*mask; hotB[k]=hot*mask;
    }
  }

  // ── 2) рёбра: граница между гранями = светлая линия, силуэт = ярче ──
  for(let j=0;j<h;j++)for(let i=0;i<w;i++){
    const k=j*w+i, id=ids[k]; if(!id)continue;
    let e=0;
    if(i+1<w&&ids[k+1]!==id) e=Math.max(e,ids[k+1]?0.7:1.0);
    if(i>0  &&ids[k-1]!==id) e=Math.max(e,ids[k-1]?0.7:1.0);
    if(j+1<h&&ids[k+w]!==id) e=Math.max(e,ids[k+w]?0.7:1.0);
    if(j>0  &&ids[k-w]!==id) e=Math.max(e,ids[k-w]?0.7:1.0);
    if(e) lumB[k]=Math.min(1.2,lumB[k]+(0.45+0.35*e)*maskB[k]);
  }

  // ── 3) файрболы: голова + хвост, с тестом глубины ──
  const TAIL=9, DS=0.025;
  for(const a of arcs){
    if(a.phi>=FLY) continue;
    const q=a.phi/FLY;
    const p=a.p0+(a.p1-a.p0)*Math.pow(q,1.25);
    for(let js=0;js<TAIL;js++){
      const pp=p-js*DS; if(pp<a.p0)continue;
      const pr=proj(bez(a.s,a.ctrl,a.d,pp)); if(!pr)continue;
      const head=js===0;
      const bright=(head?1.0:Math.exp(-js*0.42))*clamp(2.2/pr.beta,0.2,1.2);
      const rad=head?5:(js<3?2:1), sig=head?1.1:0.9;
      const xr=Math.ceil(rad/CA);
      const x0=Math.max(0,(pr.sx-xr)|0),x1=Math.min(w-1,(pr.sx+xr+1)|0),y0=Math.max(0,(pr.sy-rad)|0),y1=Math.min(h-1,(pr.sy+rad+1)|0);
      for(let yy=y0;yy<=y1;yy++)for(let xx=x0;xx<=x1;xx++){
        const idx=yy*w+xx;
        if(depthB[idx]<pr.dist-0.12) continue;               // за кристаллом
        const ddx=(xx-pr.sx)*CA,ddy=yy-pr.sy,r2=ddx*ddx+ddy*ddy,gc=Math.exp(-r2/(2*sig*sig));
        const g=head?gc+0.35*Math.exp(-r2/(2*2.4*2.4)):gc;      // ядро + мягкое гало
        const m=maskAt((xx+0.5)/w,(yy+0.5)/h);
        lumB[idx]=Math.min(1.2,lumB[idx]+bright*g*0.95*m);
        if(js<1) hotB[idx]=Math.min(1,hotB[idx]+FIRE_HEAT*gc*m);
      }
    }
  }

  // ── 4) bloom удара в экранном пространстве ──
  for(const sp of sparks){
    if(sp.flash<=0.03)continue;
    const pr=proj(sp.impact); if(!pr)continue;
    const ix=clamp(pr.sx|0,0,w-1), iy=clamp(pr.sy|0,0,h-1);
    if(depthB[iy*w+ix]<pr.dist-0.2) continue;                // удар на обратной стороне
    const rad=4, xr=Math.ceil(rad/CA), sig=1.6;
    const x0=Math.max(0,(pr.sx-xr)|0),x1=Math.min(w-1,(pr.sx+xr+1)|0),y0=Math.max(0,(pr.sy-rad)|0),y1=Math.min(h-1,(pr.sy+rad+1)|0);
    for(let yy=y0;yy<=y1;yy++)for(let xx=x0;xx<=x1;xx++){
      const ddx=(xx-pr.sx)*CA,ddy=yy-pr.sy,g=Math.exp(-(ddx*ddx+ddy*ddy)/(2*sig*sig));
      const m=maskAt((xx+0.5)/w,(yy+0.5)/h), idx=yy*w+xx;
      hotB[idx]=Math.min(1,hotB[idx]+sp.flash*g*0.55*m);
      lumB[idx]=Math.min(1.2,lumB[idx]+sp.flash*g*0.5*m);
    }
  }

  // ── 5) упаковка ──
  const out=new Uint8Array(w*h);
  for(let i=0;i<out.length;i++){
    const lv=Math.min(LEVELS-1,Math.floor(Math.pow(Math.min(lumB[i],0.999),0.85)*LEVELS));
    const ht=Math.min(15,Math.round(Math.min(hotB[i],0.999)*15));
    out[i]=(lv<<4)|ht;
  }
  self.postMessage({w,h,buf:out.buffer},[out.buffer]);
};