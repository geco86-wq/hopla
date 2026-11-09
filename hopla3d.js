/* ============================================================================
   HOPLA 3D — wspólny moduł graficzny dla gier Hopla (Three.js r128, jeden plik)
   ----------------------------------------------------------------------------
   Cel: grafika "jak z konsoli" — realistyczna, stonowana paleta, miękkie światło
   i cień, głębia. Zero plików zewnętrznych, zero znaków firmowych.

   Wczytanie w HTML:
     <script src="https://cdnjs.cloudflare.com/ajax/libs/three.js/r128/three.min.js"></script>
     <script src="hopla3d.js"></script>

   API (window.Hopla3D):
     createRenderer(canvas, opts)      ACESFilmic, sRGB, PCFSoft, pixelRatio<=2,
                                       automatyczne obniżanie jakości poniżej 48 fps
     createSky(scene, preset)          gradient + słońce + gwiazdy + mgławica + mgła
     createLights(scene, preset)       hemisphere + directional z cieniami
     addPostFX(renderer, scene, camera) bloom + winieta + ziarno (fallback CSS)
     makeHumanoid(opts)                dorosła, neutralna postać z brył
     poseHumanoid(h, mode, t, k)       animacja (bieg, tuck, lot, telemark...)
     particles(scene)                  kurz / iskry / konfetti (instancjonowane)
     hud(css)                          szklane panele, komunikaty, FPS
     createFX()                        shake / hitstop / slowmo
     input(opts)                       klawiatura + pad + dotyk + pochylenie telefonu
     createChase(camera, opts)         płynne śledzenie + FOV rosnące z prędkością
     progress(key, max)                postęp w localStorage

   TODO-KIMI: rozbudowa (więcej presetów pogody, więcej trybów poseHumanoid,
              własny composer bloom bez plików zewnętrznych, animacje twarzy).
   TODO-CODEX: szlif (kalibracja bloom/exposure per scena, LOD, testy 60 fps
              na słabszych laptopach, dopieszczenie modeli i tekstur).
   ============================================================================ */
(function (global) {
  'use strict';

  if (!global.THREE) {
    global.Hopla3D = { ok: false, error: 'Brak Three.js — wczytaj three.min.js przed hopla3d.js' };
    if (global.console) console.error('[Hopla3D] ' + global.Hopla3D.error);
    return;
  }
  const THREE = global.THREE;

  const TAU = Math.PI * 2, DEG = Math.PI / 180, UP = new THREE.Vector3(0, 1, 0);

  /* ---------- matematyka pomocnicza (te same nazwy co w grach 3D Hopla) ----- */
  const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));
  const lerp = (a, b, t) => a + (b - a) * t;
  /* damp = wygładzanie niezależne od klatkażu (60/120/144 Hz dają ten sam efekt) */
  const damp = (a, b, l, dt) => lerp(a, b, 1 - Math.exp(-l * dt));
  const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a || 1e-6), 0, 1); return t * t * (3 - 2 * t); };
  const sgn = v => (v < 0 ? -1 : (v > 0 ? 1 : 0));
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = arr => arr[(Math.random() * arr.length) | 0];
  /* deterministyczny RNG — ten sam przebieg na każdym urządzeniu */
  function mulberry(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const fmtTime = t => {
    t = Math.max(0, t || 0);
    const m = Math.floor(t / 60), s = t - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
  };

  /* ---------- PALETA HOPLA (stonowana, "konsolowa") ----------------------- */
  const PAL = {
    navy: 0x14123a, navyDeep: 0x0a0820, anthracite: 0x22242c, graphite: 0x33364a,
    steel: 0x8e9bb0, orange: 0xff8a3d, orangeDeep: 0xc9601f, gold: 0xffd23f,
    turquoise: 0x2aa3d6, turquoiseDeep: 0x14607f, ice: 0xdfe9f5, snow: 0xeef4fb,
    cream: 0xf6efdf, skin: 0xd8a273, skinDark: 0x9a6a44, hair: 0x241a15
  };
  const PAL_CSS = {
    navy: '#14123a', anthracite: '#22242c', orange: '#ff8a3d', gold: '#ffd23f',
    turquoise: '#2aa3d6', ice: '#dfe9f5', text: '#eef2f8', dim: 'rgba(238,242,248,.62)'
  };
  /* kolory z rozjaśnianiem/przyciemnianiem (k>0 → jaśniej, k<0 → ciemniej) */
  function shade(hex, k) {
    const c = new THREE.Color(hex);
    if (k >= 0) c.lerp(new THREE.Color(0xffffff), k); else c.lerp(new THREE.Color(0x000000), -k);
    return c.getHex();
  }
  /* Three r128 traktuje kolor materiału jako LINIOWY, a palety zapisujemy w sRGB.
     Bez tej konwersji barwy wychodzą wyprane/pastelowe — a my chcemy głębi. */
  function srgb(hex) {
    const c = new THREE.Color(hex);
    if (c.convertSRGBToLinear) return c.convertSRGBToLinear();
    return c;
  }
  const srgbHex = hex => srgb(hex).getHex();

  /* ---------- lokalny postęp gracza -------------------------------------- */
  /* const P = Hopla3D.progress('hoplaK3D', 9); P.unlock(2); P.setBest(1, 420); */
  function progress(key, maxLevel) {
    const max = maxLevel || 9;
    let data = { unlocked: 1, best: {}, cfg: {} };
    try {
      const raw = localStorage.getItem(key);
      if (raw) {
        const o = JSON.parse(raw);
        if (o && typeof o === 'object' && !Array.isArray(o)) {
          data = { unlocked: o.unlocked, best: o.best || {}, cfg: o.cfg || {} };
        } else if (!isNaN(+raw)) { data.unlocked = +raw; }
      }
    } catch (e) { /* tryb prywatny — gramy bez zapisu */ }
    data.unlocked = clamp(Math.round(+data.unlocked || 1), 1, max);
    if (!data.best || typeof data.best !== 'object' || Array.isArray(data.best)) data.best = {};
    for (const n in data.best) if (!Number.isFinite(data.best[n])) delete data.best[n];
    if (!data.cfg || typeof data.cfg !== 'object' || Array.isArray(data.cfg)) data.cfg = {};
    const api = {
      key: key, data: data,
      save() { try { localStorage.setItem(key, JSON.stringify(data)); } catch (e) { } },
      isUnlocked(n) { return Number.isInteger(n) && n >= 1 && n <= data.unlocked; },
      unlock(n) {
        if (!Number.isFinite(n)) return false;
        n = clamp(Math.round(n), 1, max);
        if (n > data.unlocked) { data.unlocked = n; api.save(); return true; }
        return false;
      },
      best(n) { const b = data.best[n]; return (b == null ? null : b); },
      setBest(n, v) {
        if (!Number.isFinite(v)) return false;
        const prev = data.best[n];
        if (prev == null || v > prev) { data.best[n] = v; api.save(); return true; }
        return false;
      },
      cfg(k, v) {
        if (v === undefined) return data.cfg[k];
        data.cfg[k] = v; api.save(); return v;
      },
      reset() { data.unlocked = 1; data.best = {}; api.save(); }
    };
    return api;
  }

  /* ==========================================================================
     STYLE HUD (szklane panele, jedna czcionka system-ui, bez emoji)
     ========================================================================== */
  const BASE_CSS = `
  .h3d-ui,.h3d-ui *{font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
  .h3d-box{position:absolute;pointer-events:none;color:#eef2f8;
    background:linear-gradient(180deg,rgba(20,18,58,.76),rgba(9,8,24,.7));
    border:1px solid rgba(255,255,255,.13);border-radius:14px;padding:9px 13px;
    backdrop-filter:blur(9px) saturate(125%);-webkit-backdrop-filter:blur(9px) saturate(125%);
    box-shadow:0 12px 34px rgba(0,0,0,.42),inset 0 1px 0 rgba(255,255,255,.09);
    font-weight:650;letter-spacing:.01em;text-shadow:0 2px 10px rgba(0,0,0,.55)}
  .h3d-box .k{display:block;font-size:10px;letter-spacing:.18em;text-transform:uppercase;
    opacity:.55;font-weight:700;margin-bottom:3px}
  .h3d-num{font-variant-numeric:tabular-nums}
  .h3d-bar{display:block;height:7px;border-radius:5px;background:rgba(0,0,0,.5);
    overflow:hidden;border:1px solid rgba(255,255,255,.1);margin-top:6px}
  .h3d-bar>b{display:block;height:100%;width:0;border-radius:4px;
    background:linear-gradient(90deg,#2aa3d6,#ffd23f 58%,#ff8a3d);transition:width .12s linear}
  .h3d-bar.warm>b{background:linear-gradient(90deg,#ff8a3d,#ffd23f)}
  .h3d-bar.cool>b{background:linear-gradient(90deg,#14607f,#2aa3d6)}
  #h3d-msg{position:fixed;left:0;right:0;top:20%;text-align:center;pointer-events:none;
    font-size:clamp(30px,6vw,64px);font-weight:900;letter-spacing:.05em;color:#ffd23f;
    opacity:0;transition:opacity .2s ease;text-shadow:0 6px 34px rgba(0,0,0,.85),0 2px 4px rgba(0,0,0,.9);z-index:4}
  #h3d-msg.on{opacity:1}
  #h3d-sub{position:fixed;left:0;right:0;top:35%;text-align:center;pointer-events:none;
    font-size:clamp(13px,2.1vw,22px);font-weight:700;color:#e8eef7;opacity:0;
    transition:opacity .2s ease;text-shadow:0 2px 12px rgba(0,0,0,.9);padding:0 14px;z-index:4}
  #h3d-sub.on{opacity:.96}
  #h3d-hint{position:fixed;left:0;right:0;bottom:10px;text-align:center;pointer-events:none;
    font-size:clamp(11px,1.6vw,15px);font-weight:600;color:rgba(238,242,248,.82);
    text-shadow:0 2px 9px #000;padding:0 10px;z-index:4}
  #h3d-fps{position:fixed;right:12px;bottom:10px;font-size:11px;font-weight:600;opacity:.5;
    color:#fff;pointer-events:none;font-variant-numeric:tabular-nums;z-index:4}
  .h3d-postfx{position:fixed;inset:0;pointer-events:none;z-index:1;overflow:hidden}
  .h3d-postfx .vig{position:absolute;inset:0;
    background:radial-gradient(ellipse at 50% 47%,transparent 40%,rgba(0,0,0,.28) 76%,rgba(0,0,0,.62) 100%)}
  .h3d-postfx .grain{position:absolute;inset:0;opacity:.05;mix-blend-mode:overlay;
    background-image:url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='180' height='180'><filter id='n'><feTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/></filter><rect width='180' height='180' filter='url(%23n)' opacity='0.55'/></svg>");
    background-repeat:repeat}
  @keyframes h3d-grain{
    0%{transform:translate3d(0,0,0)}25%{transform:translate3d(-1.5%,1%,0)}
    50%{transform:translate3d(1%,-1.5%,0)}75%{transform:translate3d(-1%,-1%,0)}
    100%{transform:translate3d(1.5%,1%,0)}}
  @media (prefers-reduced-motion:reduce){.h3d-postfx .grain{animation:none}}
  `;
  let _styleDone = false;
  function injectStyle(extra) {
    if (typeof document === 'undefined') return;
    if (!_styleDone) {
      _styleDone = true;
      const st = document.createElement('style');
      st.id = 'hopla3d-style';
      st.textContent = BASE_CSS;
      document.head.appendChild(st);
    }
    if (extra) {
      const st2 = document.createElement('style');
      st2.textContent = extra;
      document.head.appendChild(st2);
    }
  }

  /* ==========================================================================
     RENDERER + AUTOMATYCZNA JAKOŚĆ
     ========================================================================== */
  /* światła cieniujące zarejestrowane przez createLights — auto-jakość może
     zmniejszyć ich mapy cienia, gdy komputer nie wyrabia 60 fps */
  const shadowLights = [];

  function setShadowSize(size) {
    for (const l of shadowLights) {
      if (!l || !l.shadow) continue;
      if (l.shadow.map) { l.shadow.map.dispose(); l.shadow.map = null; }
      l.shadow.mapSize.set(size, size);
    }
  }

  /* Pomiar fps niezależny od liczby przejść post-processingu:
     tickQuality wywołujemy raz na klatkę animacji (renderer.render lub composer.render) */
  function tickQuality(R) {
    const q = R && R.hopla;
    if (!q) return;
    if (q.paused || document.hidden) { q.t0 = null; q.n = 0; return; }
    const now = (global.performance && global.performance.now) ? global.performance.now() : Date.now();
    if (q.t0 == null) { q.t0 = now; q.n = 0; return; }
    q.n++;
    const dt = (now - q.t0) / 1000;
    if (dt >= 1.2) {
      q.fps = q.n / dt; q.n = 0; q.t0 = now;
      if (q.fpsEl) q.fpsEl.textContent = Math.round(q.fps) + ' FPS';
      if (q.onFps) q.onFps(q.fps);
      /* <48 fps → schodzimy z jakością (najpierw pixelRatio, potem cień) */
      if (q.fps < 48 && q.level < 3) {
        q.level++;
        if (q.level === 1) {
          if (R.getPixelRatio() > 1.25) R.setPixelRatio(1.25); else setShadowSize(1024);
        } else {
          R.setPixelRatio(q.level === 3 ? 0.85 : Math.min(1, R.getPixelRatio()));
          setShadowSize(q.level === 3 ? 512 : 1024);
        }
        if (q.onDrop) q.onDrop(q.level, q.fps);
      }
    }
  }

  function createRenderer(canvas, opts) {
    opts = opts || {};
    const R = new THREE.WebGLRenderer({
      canvas: canvas, antialias: opts.antialias !== false,
      powerPreference: 'high-performance', alpha: false, stencil: false
    });
    R.setPixelRatio(Math.min(2, opts.maxPixelRatio || 2, global.devicePixelRatio || 1));
    R.setSize(global.innerWidth || 800, global.innerHeight || 600, false);
    R.outputEncoding = THREE.sRGBEncoding;
    R.toneMapping = THREE.ACESFilmicToneMapping;
    R.toneMappingExposure = opts.exposure != null ? opts.exposure : 1.05;
    R.shadowMap.enabled = opts.shadows !== false;
    R.shadowMap.type = THREE.PCFSoftShadowMap;
    R.setClearColor(opts.clear != null ? opts.clear : PAL.navyDeep, 1);

    /* stan jakości — gry mogą czytać R.hopla.fps / ustawić fpsEl */
    R.hopla = { fps: 60, n: 0, t0: null, level: 0, composed: false, paused: false, fpsEl: null, onFps: null, onDrop: null };

    const draw = R.render.bind(R);
    R.render = function (scene, camera) {
      /* gdy działa composer, o klatkę dba composer.render (patrz addPostFX) */
      if (!R.hopla.composed) tickQuality(R);
      draw(scene, camera);
    };

    R.domElement.addEventListener('webglcontextlost', function (e) {
      e.preventDefault();
      if (typeof opts.onLost === 'function') opts.onLost();
    }, false);

    return R;
  }

  /* ==========================================================================
     NIEBO: gradient + słońce + gwiazdy + mgławica + mgła
     ========================================================================== */
  const SKY_PRESETS = {
    dzien: {
      top: 0x2c6da8, hor: 0xcfe2ee, sunC: 0xfff1d6, night: 0, neb: 0,
      fog: 0xc6dbe9, fogNear: 150, fogFar: 950, sunDir: [0.38, 0.62, 0.34], size: 900
    },
    zmierzch: {
      top: 0x1a2450, hor: 0xe8a271, sunC: 0xffcb8a, night: 0, neb: 0,
      fog: 0xd6b49b, fogNear: 130, fogFar: 820, sunDir: [-0.55, 0.28, 0.5], size: 900
    },
    noc: {
      top: 0x04081a, hor: 0x162544, sunC: 0xbcd2ff, night: 1, neb: 0.05,
      fog: 0x0d1526, fogNear: 120, fogFar: 760, sunDir: [0.3, 0.45, 0.4], size: 900
    },
    gory: {
      top: 0x1d4f85, hor: 0xc8dced, sunC: 0xfff4e0, night: 0, neb: 0,
      fog: 0xc2d8e8, fogNear: 380, fogFar: 2100, sunDir: [-0.42, 0.55, 0.55], size: 2400
    },
    goryNoc: {
      top: 0x050b1c, hor: 0x182a48, sunC: 0xd8e6ff, night: 1, neb: 0.12,
      fog: 0x0e1830, fogNear: 300, fogFar: 1900, sunDir: [-0.4, 0.5, 0.5], size: 2400
    },
    kosmos: {
      top: 0x05020e, hor: 0x141033, sunC: 0xffffff, night: 1, neb: 0.55,
      fog: 0x0a0820, fogNear: 260, fogFar: 1500, sunDir: [0.25, 0.4, -0.88], size: 1600
    },
    kosmosMgla: {
      top: 0x08030f, hor: 0x241534, sunC: 0xffe4c4, night: 1, neb: 1.0,
      fog: 0x120a24, fogNear: 240, fogFar: 1500, sunDir: [0.5, 0.35, -0.8], size: 1600
    }
  };

  function resolvePreset(name, table) {
    const base = Object.assign({}, table.dzien);
    if (!name) return base;
    if (typeof name === 'string') return Object.assign(base, table[name] || {});
    return Object.assign(base, name);
  }

  const SKY_VERT = `
    varying vec3 vD;
    void main(){ vD=normalize(position); gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }
  `;
  const SKY_FRAG = `
    uniform vec3 top; uniform vec3 hor; uniform vec3 sunC; uniform vec3 sunD;
    uniform float night; uniform float neb;
    varying vec3 vD;
    float h21(vec2 p){ return fract(sin(dot(p,vec2(127.1,311.7)))*43758.5453123); }
    float h31(vec3 p){ return fract(sin(dot(p,vec3(127.1,311.7,74.7)))*43758.5453123); }
    float vnoise(vec2 p){
      vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
      float a=h21(i), b=h21(i+vec2(1.0,0.0)), c=h21(i+vec2(0.0,1.0)), d=h21(i+vec2(1.0,1.0));
      return mix(mix(a,b,f.x),mix(c,d,f.x),f.y);
    }
    float fbm(vec2 p){
      float s=0.0, a=0.5;
      for(int i=0;i<4;i++){ s+=a*vnoise(p); p*=2.03; a*=0.5; }
      return s;
    }
    /* gwiazdy na siatce 3D — brak zniekształceń przy biegunach sfery */
    float starLayer(vec3 dir, float scale, float thresh, float radius){
      vec3 p = dir*scale;
      vec3 id = floor(p);
      vec3 f = fract(p)-0.5;
      float h = h31(id);
      if(h < thresh) return 0.0;
      vec3 o = vec3(h31(id+3.1), h31(id+7.7), h31(id+11.3)) - 0.5;
      float d2 = length(f - o*0.55);
      float core = smoothstep(radius, 0.0, d2);
      return core*core*(0.45+0.75*h31(id+19.1));
    }
    void main(){
      float h=vD.y;
      vec3 c=mix(hor,top,pow(clamp(h,0.0,1.0),0.45));
      if(h<0.0) c=hor;
      float s=max(dot(vD,normalize(sunD)),0.0);
      /* słońce: ciasna tarcza + subtelna aureola (bez prześwietlania kadru) */
      c+=sunC*(pow(s,1200.0)*2.2+pow(s,16.0)*0.10);
      if(night>0.5){
        vec3 d=normalize(vD);
        /* trzy warstwy gwiazd o różnej gęstości i wielkości */
        float st = starLayer(d, 96.0, 0.985, 0.055)
                 + starLayer(d, 150.0, 0.990, 0.045)*0.8
                 + starLayer(d, 230.0, 0.994, 0.035)*0.6;
        st *= smoothstep(-0.02, 0.22, h);
        c += vec3(0.86,0.91,1.0)*st*2.2;
      }
      if(neb>0.001){
        vec2 uv=vD.xz/(abs(vD.y)+0.35)*1.5;
        float n=fbm(uv*1.35);
        float n2=fbm(uv*3.2+7.0);
        vec3 nebC=mix(vec3(0.20,0.10,0.44),vec3(0.09,0.34,0.52),n2);
        c+=nebC*pow(n,3.0)*neb*smoothstep(-0.15,0.55,h)*1.7;
      }
      gl_FragColor=vec4(c,1.0);
    }
  `;

  function createSky(scene, preset) {
    const P = resolvePreset(preset, SKY_PRESETS);
    const sunDir = new THREE.Vector3().fromArray(P.sunDir).normalize();
    const u = {
      top: { value: new THREE.Color(P.top) }, hor: { value: new THREE.Color(P.hor) },
      sunC: { value: new THREE.Color(P.sunC) }, sunD: { value: sunDir.clone() },
      night: { value: P.night ? 1 : 0 }, neb: { value: P.neb || 0 }
    };
    const mesh = new THREE.Mesh(
      new THREE.SphereGeometry(P.size, 32, 20),
      new THREE.ShaderMaterial({
        uniforms: u, side: THREE.BackSide, depthWrite: false, fog: false,
        vertexShader: SKY_VERT, fragmentShader: SKY_FRAG
      })
    );
    mesh.frustumCulled = false;
    mesh.renderOrder = -1000;
    scene.add(mesh);
    const fog = new THREE.Fog(P.fog, P.fogNear, P.fogFar);
    scene.fog = fog;

    const api = {
      mesh: mesh, uniforms: u, fog: fog, preset: P,
      setSunDir(v) { u.sunD.value.copy(v).normalize(); },
      apply(name) {
        const Q = resolvePreset(name, SKY_PRESETS);
        api.preset = Q;
        u.top.value.set(Q.top); u.hor.value.set(Q.hor); u.sunC.value.set(Q.sunC);
        u.night.value = Q.night ? 1 : 0; u.neb.value = Q.neb || 0;
        api.setSunDir(new THREE.Vector3().fromArray(Q.sunDir));
        fog.color.set(Q.fog); fog.near = Q.fogNear; fog.far = Q.fogFar;
        return api;
      },
      dispose() { scene.remove(mesh); mesh.geometry.dispose(); mesh.material.dispose(); }
    };
    return api;
  }

  /* ==========================================================================
     ŚWIATŁO: hemisphere + directional (miękkie cienie)
     Preset: { hemiSky, hemiGround, hemiInt, sun, sunInt, sunDir, shadows,
               shadowSize, shadowExtent, shadowFar, sunDist, ambient }
     ========================================================================== */
  const LIGHT_PRESETS = {
    dzien: {
      hemiSky: 0xcfe4ff, hemiGround: 0x4a5240, hemiInt: 0.55,
      sun: 0xfff4de, sunInt: 1.65, sunDir: [0.38, 0.62, 0.34],
      shadowSize: 2048, shadowExtent: 60, shadowFar: 320, sunDist: 110, ambient: 0.02
    },
    zmierzch: {
      hemiSky: 0xffd7b0, hemiGround: 0x3a3228, hemiInt: 0.5,
      sun: 0xffc38a, sunInt: 1.6, sunDir: [-0.55, 0.32, 0.5],
      shadowSize: 2048, shadowExtent: 70, shadowFar: 320, sunDist: 110, ambient: 0.06
    },
    noc: {
      hemiSky: 0x3c5480, hemiGround: 0x11131a, hemiInt: 0.4,
      sun: 0xa9c6ff, sunInt: 1.0, sunDir: [0.3, 0.55, 0.4],
      shadowSize: 1024, shadowExtent: 70, shadowFar: 320, sunDist: 110, ambient: 0.08
    },
    kosmos: {
      hemiSky: 0x323f66, hemiGround: 0x0b0b12, hemiInt: 0.35,
      sun: 0xdfe9ff, sunInt: 1.3, sunDir: [0.3, 0.5, -0.8],
      shadows: false, ambient: 0.05
    }
  };

  function createLights(scene, preset) {
    const P = Object.assign({}, LIGHT_PRESETS.dzien, typeof preset === 'string' ? (LIGHT_PRESETS[preset] || {}) : (preset || {}));
    const hemi = new THREE.HemisphereLight(P.hemiSky, P.hemiGround, P.hemiInt);
    scene.add(hemi);

    const amb = new THREE.AmbientLight(0xffffff, P.ambient || 0);
    scene.add(amb);

    const sun = new THREE.DirectionalLight(P.sun, P.sunInt);
    sun.castShadow = P.shadows !== false;
    if (sun.castShadow) {
      const size = P.shadowSize || 2048, ext = P.shadowExtent || 60;
      sun.shadow.mapSize.set(size, size);
      Object.assign(sun.shadow.camera, {
        left: -ext, right: ext, top: ext, bottom: -ext,
        near: 1, far: P.shadowFar || 320
      });
      sun.shadow.bias = -0.0006;
      sun.shadow.normalBias = 0.05;
      sun.shadow.camera.updateProjectionMatrix();
      shadowLights.push(sun);
    }
    const dir = new THREE.Vector3().fromArray(P.sunDir || [0.4, 0.8, 0.35]).normalize();
    const dist = P.sunDist || 110;
    sun.position.copy(dir).multiplyScalar(dist);
    scene.add(sun, sun.target);

    const api = {
      hemi: hemi, sun: sun, amb: amb, dir: dir, dist: dist, preset: P,
      /* cień podąża za bohaterem — ostry, ale miękki na krawędziach */
      follow(x, y, z) {
        sun.position.set(x + dir.x * dist, y + dir.y * dist, z + dir.z * dist);
        sun.target.position.set(x, y, z);
        sun.target.updateMatrixWorld();
      },
      apply(name) {
        const Q = Object.assign({}, LIGHT_PRESETS.dzien, typeof name === 'string' ? (LIGHT_PRESETS[name] || {}) : (name || {}));
        api.preset = Q;
        hemi.color.set(Q.hemiSky); hemi.groundColor.set(Q.hemiGround); hemi.intensity = Q.hemiInt;
        sun.color.set(Q.sun); sun.intensity = Q.sunInt; amb.intensity = Q.ambient || 0;
        dir.fromArray(Q.sunDir || [0.4, 0.8, 0.35]).normalize();
        return api;
      },
      dispose() {
        scene.remove(hemi, amb, sun, sun.target);
        const i = shadowLights.indexOf(sun); if (i >= 0) shadowLights.splice(i, 1);
        if (sun.shadow.map) sun.shadow.map.dispose();
      }
    };
    return api;
  }
/* ==========================================================================
     POST-PROCESSING: bloom + winieta + ziarno
     Gdy EffectComposer/UnrealBloomPass są niedostępne (a w Hopla ładowany jest
     tylko three.min.js), wchodzi lekki fallback CSS — winieta i ziarno bez
     dodatkowych przejść renderu, więc 60 fps zostaje.
     API: { mode, render(dt), setSize(w,h), setEnabled(b), setStrength(v), dispose }
     ========================================================================== */
  const POST_VERT = `
    varying vec2 vUv;
    void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0); }
  `;
  const POST_FRAG = `
    uniform sampler2D tDiffuse; uniform float time; uniform float vig;
    uniform float grain; uniform float bloomMix;
    varying vec2 vUv;
    float rnd(vec2 p){ return fract(sin(dot(p,vec2(12.9898,78.233)))*43758.5453); }
    void main(){
      vec4 c=texture2D(tDiffuse,vUv);
      vec2 d=vUv-0.5;
      float v=1.0-dot(d,d)*vig*2.6;
      c.rgb*=clamp(v,0.0,1.0);
      float g=(rnd(vUv*vec2(1024.0,768.0)+time)-0.5)*grain;
      c.rgb+=g;
      c.rgb=mix(c.rgb,c.rgb*vec3(1.02,1.0,0.98),0.5*bloomMix);
      gl_FragColor=vec4(c.rgb,1.0);
    }
  `;

  function addPostFX(R, scene, camera, opts) {
    opts = opts || {};
    injectStyle();
    const strength = opts.strength != null ? opts.strength : 1;
    const api = { mode: 'css', composer: null, enabled: true, strength: strength };

    const hasComposer = typeof THREE.EffectComposer === 'function' &&
      typeof THREE.RenderPass === 'function' && typeof THREE.ShaderPass === 'function';

    if (hasComposer) {
      try {
        const composer = new THREE.EffectComposer(R);
        composer.addPass(new THREE.RenderPass(scene, camera));
        let bloom = null;
        if (typeof THREE.UnrealBloomPass === 'function') {
          bloom = new THREE.UnrealBloomPass(
            new THREE.Vector2(global.innerWidth || 800, global.innerHeight || 600),
            0.55 * strength, 0.72, 0.86
          );
          composer.addPass(bloom);
        }
        const grade = new THREE.ShaderPass({
          uniforms: {
            tDiffuse: { value: null }, time: { value: 0 },
            vig: { value: 0.5 * strength }, grain: { value: 0.05 * strength },
            bloomMix: { value: 1 }
          },
          vertexShader: POST_VERT, fragmentShader: POST_FRAG
        });
        grade.renderToScreen = true;
        composer.addPass(grade);

        let pixelRatio = R.getPixelRatio();
        const orig = composer.render.bind(composer);
        composer.render = function (dt) {
          tickQuality(R);
          if (pixelRatio !== R.getPixelRatio()) { pixelRatio = R.getPixelRatio(); composer.setPixelRatio(pixelRatio); }
          if (bloom) bloom.enabled = R.hopla.level < 3;
          grade.uniforms.time.value += (dt || 0.016) * 6.0;
          orig(dt);
        };
        R.hopla.composed = true;

        api.mode = 'composer';
        api.composer = composer;
        api.bloom = bloom;
        api.setSize = function (w, h) { composer.setSize(w, h); };
        api.setStrength = function (v) {
          api.strength = v;
          if (bloom) bloom.strength = 0.55 * v;
          grade.uniforms.vig.value = 0.5 * v;
          grade.uniforms.grain.value = 0.05 * v;
        };
        api.setEnabled = function (b) { api.enabled = !!b; };
        api.render = function (dt) {
          if (api.enabled) composer.render(dt);
          else { tickQuality(R); R.render(scene, camera); }
        };
        api.dispose = function () {
          R.hopla.composed = false;
          composer.renderTarget1.dispose(); composer.renderTarget2.dispose();
          composer.passes.forEach(p => { if (p.dispose) p.dispose(); else if (p.material) p.material.dispose(); });
        };
        return api;
      } catch (e) {
        /* composer jest, ale coś nie zagrało — lecimy na fallbacku CSS */
        if (global.console) console.warn('[Hopla3D] composer nieaktywny:', e && e.message);
        R.hopla.composed = false;
      }
    }

    /* --- fallback CSS: winieta + ziarno (jedna warstwa, zero kosztu GPU) --- */
    const ov = document.createElement('div');
    ov.className = 'h3d-postfx';
    ov.innerHTML = '<i class="vig"></i><i class="grain"></i>';
    const noise = document.createElement('canvas'); noise.width = noise.height = 96;
    const ng = noise.getContext('2d'), pixels = ng.createImageData(96, 96);
    for (let i = 0; i < pixels.data.length; i += 4) {
      const v = Math.random() * 255; pixels.data[i] = pixels.data[i+1] = pixels.data[i+2] = v; pixels.data[i+3] = 255;
    }
    ng.putImageData(pixels, 0, 0);
    ov.querySelector('.grain').style.backgroundImage = 'url(' + noise.toDataURL() + ')';
    document.body.appendChild(ov);
    api.overlay = ov;
    api.render = function () { /* nic — obraz idzie prosto z renderera */ };
    api.setSize = function () { };
    api.setStrength = function (v) {
      api.strength = v;
      const vig = ov.querySelector('.vig'), grain = ov.querySelector('.grain');
      if (vig) vig.style.opacity = String(clamp(v, 0, 1.5));
      if (grain) grain.style.opacity = String(0.05 * clamp(v, 0, 2));
    };
    api.setEnabled = function (b) { api.enabled = !!b; ov.style.display = b ? '' : 'none'; };
    api.dispose = function () { if (ov.parentNode) ov.parentNode.removeChild(ov); };
    api.setEnabled(true);
    api.setStrength(strength);
    return api;
  }
/* ==========================================================================
     TEKSTURY PROCEDURALNE (canvas — bez plików zewnętrznych)
     ========================================================================== */
  function canvasTexture(w, h, draw, repeat) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    draw(c.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(c);
    t.encoding = THREE.sRGBEncoding;
    if (repeat !== false) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 8;
    return t;
  }
  const _texCache = {};
  function tex(key, make) { if (!_texCache[key]) _texCache[key] = make(); return _texCache[key]; }

  /* miękka kropka światła — do cząstek, poświat i gwiazd */
  function glowTexture() {
    return tex('glow', () => canvasTexture(128, 128, (g, w, h) => {
      const rg = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      rg.addColorStop(0, 'rgba(255,255,255,1)');
      rg.addColorStop(0.25, 'rgba(255,255,255,.72)');
      rg.addColorStop(0.55, 'rgba(255,255,255,.22)');
      rg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = rg; g.fillRect(0, 0, w, h);
    }, false));
  }
  function dotTexture() {
    return tex('dot', () => canvasTexture(64, 64, (g, w, h) => {
      const rg = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      rg.addColorStop(0, 'rgba(255,255,255,1)');
      rg.addColorStop(0.5, 'rgba(255,255,255,.6)');
      rg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = rg; g.fillRect(0, 0, w, h);
    }, false));
  }

  /* śnieg: drobne ziarno + delikatne smugi po nartach */
  function snowTexture() {
    return tex('snow', () => canvasTexture(256, 256, (g, w, h) => {
      g.fillStyle = '#eef4fb'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 4200; i++) {
        const x = Math.random() * w, y = Math.random() * h;
        const v = Math.random();
        g.fillStyle = v < 0.55 ? 'rgba(255,255,255,.5)' : 'rgba(150,175,205,.16)';
        g.fillRect(x, y, 1.4, 1.4);
      }
      for (let i = 0; i < 14; i++) {
        g.strokeStyle = 'rgba(170,193,220,.10)';
        g.lineWidth = 5 + Math.random() * 12;
        g.beginPath();
        const x = Math.random() * w;
        g.moveTo(x, 0); g.bezierCurveTo(x + 18, h * 0.4, x - 22, h * 0.7, x + 6, h);
        g.stroke();
      }
    }));
  }

  /* skała/asteroida: JAŚNIEJSZA mapa — kolor bazowy materiału działa jak
     przyciemniający tint (color × map), więc mapa nie może być ciemna */
  function rockTexture() {
    return tex('rock', () => canvasTexture(256, 256, (g, w, h) => {
      g.fillStyle = '#c6c2cc'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 3200; i++) {
        const x = Math.random() * w, y = Math.random() * h, s = 1 + Math.random() * 4;
        const v = Math.random();
        g.fillStyle = v < 0.5 ? 'rgba(58,54,66,.30)' : 'rgba(255,255,255,.22)';
        g.fillRect(x, y, s, s);
      }
      /* kratery — czytelna skala geologiczna */
      for (let i = 0; i < 22; i++) {
        const x = Math.random() * w, y = Math.random() * h, r = 4 + Math.random() * 16;
        const grd = g.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
        grd.addColorStop(0, 'rgba(52,48,60,.42)');
        grd.addColorStop(0.7, 'rgba(96,92,104,.24)');
        grd.addColorStop(1, 'rgba(255,255,255,.10)');
        g.fillStyle = grd;
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
      }
      for (let i = 0; i < 18; i++) {
        g.strokeStyle = 'rgba(46,42,54,.34)';
        g.lineWidth = 1 + Math.random() * 2.5;
        g.beginPath();
        let x = Math.random() * w, y = Math.random() * h;
        g.moveTo(x, y);
        for (let k = 0; k < 4; k++) { x += rand(-42, 42); y += rand(-42, 42); g.lineTo(x, y); }
        g.stroke();
      }
    }));
  }

  /* poszycie techniczne (stacje, bramy) — antracyt + pomarańczowe pasy */
  function panelTexture() {
    return tex('panel', () => canvasTexture(256, 256, (g, w, h) => {
      g.fillStyle = '#2b2f3d'; g.fillRect(0, 0, w, h);
      for (let y = 0; y < h; y += 32) {
        g.fillStyle = 'rgba(0,0,0,.28)'; g.fillRect(0, y, w, 2);
        for (let x = 0; x < w; x += 32) {
          g.fillStyle = Math.random() < 0.5 ? 'rgba(255,255,255,.035)' : 'rgba(0,0,0,.09)';
          g.fillRect(x + 2, y + 2, 28, 28);
        }
      }
      g.fillStyle = 'rgba(255,138,61,.85)';
      g.fillRect(0, h * 0.46, w, 5);
      g.fillStyle = 'rgba(190,210,235,.14)';
      g.fillRect(0, h * 0.52, w, 2);
    }));
  }

  /* numer startowy (jak w prawdziwych zawodach, bez znaków firmowych) */
  function bibTexture(num, bg, fg) {
    const key = 'bib' + num + (bg || '') + (fg || '');
    return tex(key, () => canvasTexture(128, 128, (g, w, h) => {
      g.fillStyle = bg || '#f6efdf'; g.fillRect(0, 0, w, h);
      g.strokeStyle = 'rgba(0,0,0,.25)'; g.lineWidth = 6; g.strokeRect(3, 3, w - 6, h - 6);
      g.fillStyle = fg || '#14123a';
      g.font = 'bold 74px system-ui,sans-serif';
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(String(num), w / 2, h / 2 + 4);
    }, false));
  }
/* ==========================================================================
     POSTAĆ Z BRYŁ — dorosła, neutralna sylwetka 1,78 m, animowana pozycjami
     makeHumanoid({ kit, kitAlt, skin, hair, boot, glove, helmet, bib, skis, height })
     ========================================================================== */
  function makeHumanoid(opts) {
    opts = opts || {};
    const kit = opts.kit != null ? opts.kit : PAL.turquoise;
    const kitAlt = opts.kitAlt != null ? opts.kitAlt : PAL.navy;
    const skin = opts.skin != null ? opts.skin : PAL.skin;
    const hair = opts.hair != null ? opts.hair : PAL.hair;
    const boot = opts.boot != null ? opts.boot : PAL.anthracite;
    const glove = opts.glove != null ? opts.glove : PAL.anthracite;

    const M = (c, r, mt) => new THREE.MeshStandardMaterial({ color: srgb(c), roughness: r != null ? r : 0.72, metalness: mt || 0.04 });
    const mKit = M(kit, 0.66), mKitAlt = M(kitAlt, 0.7), mSkin = M(skin, 0.84, 0),
      mHair = M(hair, 0.92, 0), mBoot = M(boot, 0.45, 0.12), mGlove = M(glove, 0.62, 0.06);
    const mats = [mKit, mKitAlt, mSkin, mHair, mBoot, mGlove];

    const cyl = (rt, rb, hh, m, seg) => new THREE.Mesh(new THREE.CylinderGeometry(rt, rb, hh, seg || 12), m);
    const sph = (r, m, ws, hs) => new THREE.Mesh(new THREE.SphereGeometry(r, ws || 16, hs || 12), m);
    const box = (w, hh, d, m) => new THREE.Mesh(new THREE.BoxGeometry(w, hh, d), m);

    const grp = new THREE.Group();          /* stopy na y = 0 */
    const hip = new THREE.Group(); hip.position.y = 0.95; grp.add(hip);

    /* --- miednica + tułów (kurtka lekko zwężona ku dołowi) --- */
    const pelvis = box(0.30, 0.20, 0.20, mKitAlt); pelvis.position.y = 0.02; hip.add(pelvis);
    const torso = cyl(0.205, 0.165, 0.48, mKit, 14);
    torso.position.y = 0.34; torso.scale.z = 0.74; hip.add(torso);
    /* kołnierz i barki — sylwetka dorosła, nie "bajkowa" */
    const collar = cyl(0.085, 0.10, 0.09, mKitAlt, 12); collar.position.y = 0.585; hip.add(collar);
    const shoulderL = sph(0.085, mKit); shoulderL.position.set(-0.195, 0.52, 0); shoulderL.scale.set(1, 0.85, 0.9); hip.add(shoulderL);
    const shoulderR = sph(0.085, mKit); shoulderR.position.set(0.195, 0.52, 0); shoulderR.scale.set(1, 0.85, 0.9); hip.add(shoulderR);
    /* zamek kurtki i pasek — drobny detal, który daje "konsolowy" realizm */
    const zip = box(0.018, 0.44, 0.02, mKitAlt); zip.position.set(0, 0.34, 0.148); hip.add(zip);
    const belt = box(0.29, 0.045, 0.19, mBoot); belt.position.y = 0.10; hip.add(belt);

    /* --- szyja, głowa, włosy, kask/gogle --- */
    const neck = new THREE.Group(); neck.position.y = 0.63; hip.add(neck);
    const nape = cyl(0.055, 0.062, 0.10, mSkin, 10); nape.position.y = 0.03; neck.add(nape);
    const head = sph(0.106, mSkin, 18, 14); head.position.y = 0.175; head.scale.set(0.96, 1.12, 1.0); neck.add(head);
    const jaw = box(0.10, 0.07, 0.09, mSkin); jaw.position.set(0, 0.12, 0.035); neck.add(jaw);
    const hairCap = sph(0.112, mHair, 16, 12);
    hairCap.position.set(0, 0.198, -0.012); hairCap.scale.set(1.0, 0.86, 1.05); neck.add(hairCap);

    let helmet = null, goggles = null;
    if (opts.helmet != null && opts.helmet !== false) {
      helmet = sph(0.122, M(opts.helmet, 0.28, 0.22), 18, 14);
      helmet.position.set(0, 0.19, -0.004); helmet.scale.set(1, 1.02, 1.06); neck.add(helmet);
      goggles = box(0.185, 0.062, 0.05, M(0x161a24, 0.25, 0.5));
      goggles.position.set(0, 0.176, 0.088); neck.add(goggles);
      const lens = box(0.15, 0.042, 0.02, new THREE.MeshStandardMaterial({
        color: srgb(PAL.turquoiseDeep), roughness: 0.12, metalness: 0.7,
        emissive: srgb(PAL.turquoise), emissiveIntensity: 0.25
      }));
      lens.position.set(0, 0.176, 0.112); neck.add(lens);
    }

    /* --- numer startowy na piersi --- */
    if (opts.bib != null) {
      const bibMat = new THREE.MeshStandardMaterial({
        map: bibTexture(opts.bib, opts.bibBg || '#f6efdf', opts.bibFg || '#14123a'),
        roughness: 0.85, metalness: 0
      });
      mats.push(bibMat);
      const bib = new THREE.Mesh(new THREE.PlaneGeometry(0.18, 0.18), bibMat);
      bib.position.set(0, 0.32, 0.157); hip.add(bib);
    }
/* --- ramiona: bark → ramię → łokieć → przedramię → dłoń --- */
    function arm(sx) {
      const sh = new THREE.Group(); sh.position.set(sx * 0.205, 0.50, 0); hip.add(sh);
      const cap = sph(0.072, mKit); cap.scale.set(1, 0.9, 0.95); sh.add(cap);
      const up = cyl(0.055, 0.047, 0.29, mKit, 10); up.position.y = -0.16; sh.add(up);
      const el = new THREE.Group(); el.position.y = -0.31; sh.add(el);
      const fore = cyl(0.046, 0.04, 0.27, mSkin, 10); fore.position.y = -0.135; el.add(fore);
      const hand = sph(0.049, mGlove, 12, 9); hand.position.y = -0.285; hand.scale.set(0.9, 1.1, 1.0); el.add(hand);
      return { sh: sh, el: el, hand: hand };
    }
    const armL = arm(-1), armR = arm(1);

    /* --- nogi: biodro → udo → kolano → podudzie → but --- */
    function leg(sx) {
      const hp = new THREE.Group(); hp.position.set(sx * 0.095, 0.0, 0); hip.add(hp);
      const thigh = cyl(0.088, 0.072, 0.44, mKitAlt, 12); thigh.position.y = -0.22; hp.add(thigh);
      const kn = new THREE.Group(); kn.position.y = -0.44; hp.add(kn);
      const shin = cyl(0.07, 0.055, 0.42, mKitAlt, 12); shin.position.y = -0.21; kn.add(shin);
      /* but: pięta cofnięta, czub do przodu (v = -Z lokalnie → boot patrzy w +Z) */
      const ft = box(0.108, 0.085, 0.26, mBoot); ft.position.set(0, -0.425, 0.055); kn.add(ft);
      const sole = box(0.10, 0.022, 0.24, mBoot); sole.position.set(0, -0.465, 0.06); kn.add(sole);
      return { hp: hp, kn: kn, ft: ft };
    }
    const legL = leg(-1), legR = leg(1);

    /* --- narty (opcjonalnie) — przypięte do korzenia, żeby nie "pływały"
       razem z kolanem; pozycja ustawiana w poseHumanoid --- */
    let ski = null;
    if (opts.skis) {
      const so = typeof opts.skis === 'object' ? opts.skis : {};
      const len = so.length || 2.45, wid = so.width || 0.105;
      const skiMat = M(so.color != null ? so.color : PAL.orange, 0.35, 0.25);
      const edgeMat = M(PAL.anthracite, 0.5, 0.3);
      mats.push(skiMat, edgeMat);
      const mkSki = () => {
        const g = new THREE.Group();
        /* czub narty ~1,3 m przed wiązaniem, pięta ~1,1 m za nim */
        const body = box(wid, 0.025, len, skiMat); body.position.z = len * 0.12; g.add(body);
        const edge = box(wid * 1.06, 0.008, len * 0.97, edgeMat); edge.position.set(0, -0.014, len * 0.12); g.add(edge);
        const tip = box(wid, 0.025, 0.34, skiMat);
        tip.position.set(0, 0.045, len * 0.63); tip.rotation.x = -0.36; g.add(tip);
        const bind = box(0.10, 0.055, 0.24, edgeMat); bind.position.set(0, 0.035, 0.0); g.add(bind);
        return g;
      };
      ski = { L: mkSki(), R: mkSki(), len: len };
      ski.L.position.set(-0.105, 0.02, 0);
      ski.R.position.set(0.105, 0.02, 0);
      grp.add(ski.L, ski.R);
    }

    grp.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });

    const scale = opts.height ? opts.height / 1.78 : (opts.scale || 1);
    if (scale !== 1) grp.scale.setScalar(scale);

    const h = {
      grp: grp, hip: hip, torso: torso, neck: neck, head: head,
      armL: armL, armR: armR, legL: legL, legR: legR,
      ski: ski, helmet: helmet, goggles: goggles,
      baseHipY: 0.95, mats: mats,
      animate(mode, t, k) { poseHumanoid(h, mode, t, k); return h; },
      dispose() {
        const materials = new Set(mats);
        grp.traverse(o => { if (o.isMesh) { o.geometry.dispose(); materials.add(o.material); } });
        materials.forEach(m => m.dispose());
      }
    };
    return h;
  }
/* ==========================================================================
     POZY POSTACI
     mode: 'idle' | 'walk' | 'run' | 'ski' | 'tuck' | 'air' | 'telemark' |
           'land' | 'fall' | 'wave' | 'cheer' | 'sit'
     t: czas w sekundach (faza cyklu) · k: { speed, lean, rate }
     ========================================================================== */
  const footInverse = new THREE.Matrix4(), footL = new THREE.Vector3(), footR = new THREE.Vector3();
  function poseHumanoid(h, mode, t, k) {
    if (!h) return;
    k = k || {};
    const T = t || 0;
    const A = h.armL, B = h.armR, L = h.legL, R = h.legR, sk = h.ski;
    const reset = o => { o.rotation.set(0, 0, 0); };

    reset(h.hip); h.hip.position.set(0, h.baseHipY, 0);
    reset(h.torso); reset(h.neck); reset(h.head);
    [A.sh, A.el, B.sh, B.el, L.hp, L.kn, R.hp, R.kn].forEach(reset);
    A.sh.rotation.z = 0.07; B.sh.rotation.z = -0.07;   /* ręce minimalnie odsunięte */
    if (sk) {
      reset(sk.L); reset(sk.R);
      sk.L.position.set(-0.105, 0.02, 0); sk.R.position.set(0.105, 0.02, 0);
    }

    if (mode === 'run' || mode === 'walk') {
      const sp = clamp(k.speed != null ? k.speed : 1, 0, 1.5);
      const amp = (mode === 'run' ? 0.55 + 0.5 * sp : 0.42);
      const p = T * (k.rate || (mode === 'run' ? 9 : 5.2));
      const s = Math.sin(p);
      L.hp.rotation.x = -amp * s;                 /* ujemny = noga w przód */
      R.hp.rotation.x = amp * s;
      L.kn.rotation.x = 0.18 + (mode === 'run' ? 1.45 : 0.75) * Math.max(0, Math.sin(p + 2.4));
      R.kn.rotation.x = 0.18 + (mode === 'run' ? 1.45 : 0.75) * Math.max(0, Math.sin(p + 2.4 + Math.PI));
      A.sh.rotation.x = 0.72 * amp * s;
      B.sh.rotation.x = -0.72 * amp * s;
      A.el.rotation.x = mode === 'run' ? -1.15 : -0.42;
      B.el.rotation.x = mode === 'run' ? -1.15 : -0.42;
      h.hip.rotation.x = (mode === 'run' ? 0.16 : 0.05) * sp;
      h.hip.rotation.y = -0.09 * sp * s;
      h.neck.rotation.x = -0.12 * sp;
      h.hip.position.y = h.baseHipY + 0.035 * Math.abs(s) * sp - (mode === 'walk' ? 0.01 : 0);
    } else if (mode === 'ski') {                  /* rozbieg: kucnięcie na nartach */
      h.hip.rotation.x = 0.50;
      L.hp.rotation.x = -0.50; R.hp.rotation.x = -0.47;
      L.kn.rotation.x = 1.00; R.kn.rotation.x = 0.96;
      A.sh.rotation.x = -1.05; B.sh.rotation.x = -1.05;
      A.sh.rotation.z = 0.24; B.sh.rotation.z = -0.24;
      A.el.rotation.x = -0.62; B.el.rotation.x = -0.62;
      h.neck.rotation.x = -0.38;
      h.hip.position.y = h.baseHipY - 0.20;
      if (sk) { sk.L.rotation.y = -0.02; sk.R.rotation.y = 0.02; }
    } else if (mode === 'tuck') {                 /* pełne "jajko" — minimalny opór */
      h.hip.rotation.x = 0.95;
      L.hp.rotation.x = -1.02; R.hp.rotation.x = -0.98;
      L.kn.rotation.x = 1.95; R.kn.rotation.x = 1.9;
      A.sh.rotation.x = 0.85; B.sh.rotation.x = 0.85;
      A.sh.rotation.z = 0.30; B.sh.rotation.z = -0.30;
      A.el.rotation.x = -0.30; B.el.rotation.x = -0.30;
      h.neck.rotation.x = -0.62;
      h.hip.position.y = h.baseHipY - 0.30;
      if (sk) { sk.L.rotation.y = -0.02; sk.R.rotation.y = 0.02; }
    } else if (mode === 'air') {                  /* lot: ciało poziomo, narty w V */
      const lean = clamp(k.lean != null ? k.lean : 0, -1, 1);
      h.hip.rotation.x = 1.28 - lean * 0.12;
      L.hp.rotation.x = 0.10; R.hp.rotation.x = 0.08;
      L.kn.rotation.x = 0.16; R.kn.rotation.x = 0.22;
      A.sh.rotation.x = 0.55; B.sh.rotation.x = 0.52;
      A.sh.rotation.z = 0.95; B.sh.rotation.z = -0.95;
      A.el.rotation.x = -0.18; B.el.rotation.x = -0.18;
      h.neck.rotation.x = -0.92;
      h.hip.position.y = h.baseHipY - 0.05;
      if (sk) {
        sk.L.rotation.y = -0.20; sk.R.rotation.y = 0.20;
        sk.L.rotation.z = 0.16; sk.R.rotation.z = -0.16;
        sk.L.rotation.x = -0.16; sk.R.rotation.x = -0.16;
      }
    } else if (mode === 'telemark') {             /* lądowanie: noga w wykroku */
      h.hip.rotation.x = 0.30;
      L.hp.rotation.x = -0.92; L.kn.rotation.x = 1.05;
      R.hp.rotation.x = -0.05; R.kn.rotation.x = 1.42;
      A.sh.rotation.x = -0.28; A.sh.rotation.z = 1.02;
      B.sh.rotation.x = -0.28; B.sh.rotation.z = -1.02;
      A.el.rotation.x = -0.34; B.el.rotation.x = -0.34;
      h.neck.rotation.x = -0.16;
      h.hip.position.y = h.baseHipY - 0.23;
      if (sk) {                                     /* wykrok: narta tylna cofnięta */
        sk.L.position.z = 0.30; sk.R.position.z = -0.34;
        sk.L.rotation.y = -0.05; sk.R.rotation.y = 0.05;
        sk.R.rotation.x = -0.26;
      }
    } else if (mode === 'land') {                 /* amortyzacja po lądowaniu */
      h.hip.rotation.x = 0.42;
      L.hp.rotation.x = -0.62; R.hp.rotation.x = -0.6;
      L.kn.rotation.x = 1.4; R.kn.rotation.x = 1.36;
      A.sh.rotation.x = -0.55; B.sh.rotation.x = -0.55;
      A.sh.rotation.z = 0.55; B.sh.rotation.z = -0.55;
      A.el.rotation.x = -0.5; B.el.rotation.x = -0.5;
      h.neck.rotation.x = -0.22;
      h.hip.position.y = h.baseHipY - 0.26;
    } else if (mode === 'fall') {                 /* upadek — chaotyczne machanie */
      h.hip.rotation.x = 0.75 + 0.45 * Math.sin(T * 9);
      h.hip.rotation.z = 0.35 * Math.sin(T * 6);
      A.sh.rotation.x = -1.3 + Math.sin(T * 13) * 0.9; A.sh.rotation.z = 1.1;
      B.sh.rotation.x = -1.2 + Math.cos(T * 11) * 0.9; B.sh.rotation.z = -1.1;
      A.el.rotation.x = -0.6; B.el.rotation.x = -0.6;
      L.hp.rotation.x = -1.0 + Math.sin(T * 10) * 0.7;
      R.hp.rotation.x = -0.3 + Math.cos(T * 10) * 0.7;
      L.kn.rotation.x = 1.2; R.kn.rotation.x = 1.35;
      h.neck.rotation.x = -0.35;
      h.hip.position.y = h.baseHipY - 0.2;
    } else if (mode === 'wave') {                 /* pozdrowienie / prezentacja */
      A.sh.rotation.x = -0.2; B.sh.rotation.x = -2.35;
      A.sh.rotation.z = 0.35; B.sh.rotation.z = -0.55;
      A.el.rotation.x = -0.3; B.el.rotation.x = -0.4 + 0.28 * Math.sin(T * 6);
      L.hp.rotation.x = 0.02; R.hp.rotation.x = -0.02;
      L.kn.rotation.x = 0.06; R.kn.rotation.x = 0.06;
      h.neck.rotation.y = 0.12 * Math.sin(T * 1.7);
    } else if (mode === 'cheer') {                /* radość po udanym skoku */
      A.sh.rotation.x = -2.6 + 0.15 * Math.sin(T * 7); A.sh.rotation.z = 0.5;
      B.sh.rotation.x = -2.6 + 0.15 * Math.cos(T * 7); B.sh.rotation.z = -0.5;
      A.el.rotation.x = -0.25; B.el.rotation.x = -0.25;
      h.hip.position.y = h.baseHipY + 0.03 * Math.abs(Math.sin(T * 3.4));
      h.hip.rotation.x = 0.05 * Math.sin(T * 3.4);
    } else if (mode === 'sit') {                  /* miejsce pilota / sędziego */
      h.hip.rotation.x = 0.12;
      L.hp.rotation.x = -1.35; R.hp.rotation.x = -1.35;
      L.kn.rotation.x = 1.35; R.kn.rotation.x = 1.35;
      A.sh.rotation.x = -1.15; B.sh.rotation.x = -1.15;
      A.el.rotation.x = -0.75; B.el.rotation.x = -0.75;
      h.hip.position.y = h.baseHipY - 0.30;
    } else {                                      /* idle / menu */
      const b = Math.sin(T * 1.6) * 0.02;
      h.hip.position.y = h.baseHipY + b * 0.4;
      A.sh.rotation.x = -0.05 + b; B.sh.rotation.x = -0.05 - b;
      A.el.rotation.x = -0.18; B.el.rotation.x = -0.18;
      L.hp.rotation.x = -0.03; R.hp.rotation.x = 0.03;
      L.kn.rotation.x = 0.05; R.kn.rotation.x = 0.05;
      h.neck.rotation.x = 0.02 + b * 0.3;
    }
    if (sk) {
      /* Wiązania podążają za butami także przy pochyleniu miednicy w locie.
         Utrzymujemy najniższą nartę na poziomie korzenia postaci. */
      h.grp.updateMatrixWorld(true);
      footInverse.copy(h.grp.matrixWorld).invert();
      footL.set(0, -0.478, 0.055).applyMatrix4(L.kn.matrixWorld).applyMatrix4(footInverse);
      footR.set(0, -0.478, 0.055).applyMatrix4(R.kn.matrixWorld).applyMatrix4(footInverse);
      const offset = 0.06 - Math.min(footL.y, footR.y);
      h.hip.position.y += offset;
      sk.L.position.copy(footL); sk.R.position.copy(footR);
      sk.L.position.y += offset - 0.04; sk.R.position.y += offset - 0.04;
    }
  }

  /* ==========================================================================
     CZĄSTKI: kurz / śnieg (Points), iskry i konfetti (InstancedMesh)
     Ich liczba jest stała (pule), więc nie alokujemy w trakcie gry.
     ========================================================================== */
  function particles(scene) {
    const sys = { scene: scene, dusts: [], pools: [] };
    const dot = dotTexture();
    const dummy = new THREE.Object3D();

    /* --- KURZ / ŚNIEG / PYŁ --- */
    function makeDust(o) {
      o = o || {};
      const n = o.count || 250;
      const area = o.area || new THREE.Vector3(80, 40, 80);
      const pos = new Float32Array(n * 3), vel = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) {
        const i3 = i * 3;
        pos[i3] = rand(-area.x / 2, area.x / 2);
        pos[i3 + 1] = rand(-area.y / 2, area.y / 2);
        pos[i3 + 2] = rand(-area.z / 2, area.z / 2);
        vel[i3] = rand(-1, 1) * (o.drift != null ? o.drift : 0.35);
        vel[i3 + 1] = (o.fall != null ? o.fall : -0.18) + rand(-0.25, 0.25);
        vel[i3 + 2] = rand(-1, 1) * (o.drift != null ? o.drift : 0.35);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      const mat = new THREE.PointsMaterial({
        size: o.size || 0.35, map: dot, transparent: true,
        opacity: o.opacity != null ? o.opacity : 0.5,
        color: srgb(o.color != null ? o.color : 0xffffff),
        depthWrite: false, sizeAttenuation: true,
        blending: o.additive ? THREE.AdditiveBlending : THREE.NormalBlending
      });
      const pts = new THREE.Points(geo, mat);
      pts.frustumCulled = false;
      scene.add(pts);
      const em = {
        points: pts, geo: geo, mat: mat, area: area,
        update(dt, focus) {
          const p = geo.attributes.position.array;
          const fx = focus ? focus.x : 0, fy = focus ? focus.y : 0, fz = focus ? focus.z : 0;
          for (let i = 0; i < n; i++) {
            const i3 = i * 3;
            p[i3] += vel[i3] * dt; p[i3 + 1] += vel[i3 + 1] * dt; p[i3 + 2] += vel[i3 + 2] * dt;
            /* zawijanie chmury wokół obserwatora — nieskończony śnieg/kurz */
            p[i3] -= Math.floor((p[i3] - fx + area.x / 2) / area.x) * area.x;
            p[i3 + 1] -= Math.floor((p[i3 + 1] - fy + area.y / 2) / area.y) * area.y;
            p[i3 + 2] -= Math.floor((p[i3 + 2] - fz + area.z / 2) / area.z) * area.z;
          }
          geo.attributes.position.needsUpdate = true;
        },
        dispose() { scene.remove(pts); geo.dispose(); mat.dispose(); }
      };
      sys.dusts.push(em);
      return em;
    }
/* --- pula instancjonowanych drobin (iskry / konfetti) --- */
    function makePool(o) {
      o = o || {};
      const cap = o.count || 260;
      const geo = o.geo || new THREE.BoxGeometry(0.06, 0.06, 0.28);
      const mat = o.mat || new THREE.MeshBasicMaterial({
        color: srgb(o.color != null ? o.color : PAL.gold),
        transparent: true, opacity: 1, depthWrite: false, toneMapped: false,
        blending: o.blending != null ? o.blending : THREE.AdditiveBlending,
        side: o.doubleSide ? THREE.DoubleSide : THREE.FrontSide
      });
      const mesh = new THREE.InstancedMesh(geo, mat, cap);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.frustumCulled = false;
      mesh.renderOrder = 4;
      scene.add(mesh);

      const P = {
        mesh: mesh, cap: cap, head: 0,
        pos: new Float32Array(cap * 3), vel: new Float32Array(cap * 3),
        life: new Float32Array(cap), max: new Float32Array(cap),
        size: new Float32Array(cap), rot: new Float32Array(cap), spin: new Float32Array(cap),
        hidden: new Uint8Array(cap),
        grav: o.gravity != null ? o.gravity : 4.5,
        drag: o.drag != null ? o.drag : 1.1,
        align: !!o.align, flutter: !!o.flutter
      };
      /* startowo wszystko ukryte */
      dummy.position.set(0, -9999, 0); dummy.rotation.set(0, 0, 0);
      dummy.scale.setScalar(0.0001);
      dummy.updateMatrix();
      for (let i = 0; i < cap; i++) { mesh.setMatrixAt(i, dummy.matrix); P.hidden[i] = 1; }
      mesh.instanceMatrix.needsUpdate = true;

      P.spawn = function (x, y, z, vx, vy, vz, life, size) {
        const i = P.head; P.head = (P.head + 1) % cap;
        const i3 = i * 3;
        P.pos[i3] = x; P.pos[i3 + 1] = y; P.pos[i3 + 2] = z;
        P.vel[i3] = vx; P.vel[i3 + 1] = vy; P.vel[i3 + 2] = vz;
        P.life[i] = life; P.max[i] = life;
        P.size[i] = size;
        P.rot[i] = Math.random() * TAU;
        P.spin[i] = rand(-7, 7);
        P.hidden[i] = 0;
      };
      P.burst = function (p, n, opt) {
        opt = opt || {};
        const speed = opt.speed != null ? opt.speed : 6;
        const spread = opt.spread != null ? opt.spread : 1;
        for (let k = 0; k < n; k++) {
          const th = Math.random() * TAU, ph = Math.acos(rand(-1, 1)), s = speed * rand(0.35, 1);
          P.spawn(
            p.x + rand(-0.2, 0.2), p.y + rand(-0.2, 0.2), p.z + rand(-0.2, 0.2),
            Math.sin(ph) * Math.cos(th) * s * spread,
            Math.cos(ph) * s * spread,
            Math.sin(ph) * Math.sin(th) * s * spread,
            opt.life != null ? opt.life : rand(0.35, 0.85),
            opt.size != null ? opt.size : rand(0.05, 0.14)
          );
        }
      };
      P.update = function (dt) {
        let any = false;
        for (let i = 0; i < cap; i++) {
          if (P.life[i] <= 0) {
            /* koniec życia → zeruj macierz, inaczej "martwe" drobiny wiszą w scenie */
            if (!P.hidden[i]) {
              P.hidden[i] = 1;
              dummy.position.set(0, -9999, 0);
              dummy.rotation.set(0, 0, 0);
              dummy.scale.setScalar(0.0001);
              dummy.updateMatrix();
              mesh.setMatrixAt(i, dummy.matrix);
              any = true;
            }
            continue;
          }
          any = true;
          const i3 = i * 3;
          P.life[i] -= dt;
          const f = Math.max(0, P.life[i] / P.max[i]);
          P.vel[i3 + 1] -= P.grav * dt;
          const df = Math.max(0, 1 - P.drag * dt);
          P.vel[i3] *= df; P.vel[i3 + 1] *= df; P.vel[i3 + 2] *= df;
          if (P.flutter) {
            P.vel[i3] += Math.sin(P.rot[i] * 3.1 + P.life[i] * 7) * 1.6 * dt;
            P.vel[i3 + 2] += Math.cos(P.rot[i] * 2.7 + P.life[i] * 6) * 1.6 * dt;
            P.rot[i] += P.spin[i] * dt;
          }
          P.pos[i3] += P.vel[i3] * dt;
          P.pos[i3 + 1] += P.vel[i3 + 1] * dt;
          P.pos[i3 + 2] += P.vel[i3 + 2] * dt;
          /* pozycja dummy musi być czysta — align/rotacja ustawiane od zera każdej klatki */
          dummy.position.set(P.pos[i3], P.pos[i3 + 1], P.pos[i3 + 2]);
          const sc = Math.max(0.0001, P.size[i] * 10 * (0.35 + 0.65 * f));
          if (P.align) {
            dummy.rotation.set(0, 0, 0);
            dummy.lookAt(P.pos[i3] + P.vel[i3], P.pos[i3 + 1] + P.vel[i3 + 1], P.pos[i3 + 2] + P.vel[i3 + 2]);
            dummy.scale.setScalar(sc);
          } else {
            dummy.rotation.set(P.rot[i], P.rot[i] * 1.7, P.rot[i] * 0.6);
            dummy.scale.set(sc, sc, sc * 2.2);
          }
          dummy.updateMatrix();
          mesh.setMatrixAt(i, dummy.matrix);
        }
        if (any) mesh.instanceMatrix.needsUpdate = true;
      };
      P.clear = function () {
        P.life.fill(0);
        dummy.position.set(0, -9999, 0); dummy.rotation.set(0, 0, 0);
        dummy.scale.setScalar(0.0001); dummy.updateMatrix();
        for (let i = 0; i < cap; i++) { mesh.setMatrixAt(i, dummy.matrix); P.hidden[i] = 1; }
        mesh.instanceMatrix.needsUpdate = true;
      };
      P.dispose = function () { scene.remove(mesh); if (mesh.dispose) mesh.dispose(); mat.dispose(); geo.dispose(); };
      sys.pools.push(P);
      return P;
    }
let sparkPool = null, confettiPools = null;
    sys.dust = function (o) { return makeDust(o); };
    sys.pool = function (o) { return makePool(o); };
    /* iskry: domyślna pula (pomarańcz, additive, wydłużone drobiny) */
    sys.sparks = function (pos, count, opt) {
      if (!sparkPool) {
        sparkPool = makePool({
          count: opt && opt.pool ? opt.pool : 320, color: opt && opt.color != null ? opt.color : PAL.orange,
          gravity: 3.2, drag: 0.85, align: true,
          geo: new THREE.BoxGeometry(0.05, 0.05, 0.34)
        });
      }
      sparkPool.burst(pos, count || 12, opt);
      return sparkPool;
    };
    /* konfetti: trzy kolory z palety (osobne pule — bez instanceColor) */
    sys.confetti = function (pos, count, opt) {
      if (!confettiPools) {
        confettiPools = [PAL.orange, PAL.gold, PAL.turquoise].map(function (c) {
          return makePool({
            count: 120, color: c, gravity: 6.5, drag: 0.55, flutter: true, doubleSide: true,
            geo: new THREE.PlaneGeometry(0.15, 0.065),
            mat: new THREE.MeshBasicMaterial({
              color: c, transparent: true, opacity: 1, depthWrite: false,
              side: THREE.DoubleSide, toneMapped: false
            })
          });
        });
      }
      const n = Math.max(1, count | 0), per = Math.max(1, Math.round(n / 3));
      confettiPools.forEach(function (p) { p.burst(pos, per, opt); });
      return confettiPools;
    };
    sys.config = function (o) {
      /* opcjonalna zmiana ziarna/rozmiaru istniejących chmur (np. gęstszy śnieg) */
      if (!o) return;
      if (o.dustScale) sys.dusts.forEach(function (d) { d.mat.size *= o.dustScale; });
    };
    sys.update = function (dt, focus) {
      for (let i = 0; i < sys.dusts.length; i++) sys.dusts[i].update(dt, focus);
      for (let i = 0; i < sys.pools.length; i++) sys.pools[i].update(dt);
    };
    sys.clear = function () {
      for (let i = 0; i < sys.pools.length; i++) sys.pools[i].clear();
    };
    sys.dispose = function () {
      sys.dusts.forEach(function (d) { d.dispose(); });
      sys.pools.forEach(function (p) { p.dispose(); });
      sys.dusts.length = 0; sys.pools.length = 0;
    };
    return sys;
  }

  /* ==========================================================================
     HUD: wstrzykuje style i daje komunikaty / FPS / podpowiedzi
     Użycie: const H=Hopla3D.hud('dodatkowe css');
             H.msg('Gotów', 'Naciśnij A', 1400); H.hint('...'); H.fps(true);
     ========================================================================== */
  function hud(css) {
    injectStyle(css);
    if (!document.getElementById('h3d-ui-root')) {
      const root = document.createElement('div');
      root.id = 'h3d-ui-root';
      root.innerHTML =
        '<div id="h3d-msg"></div><div id="h3d-sub"></div>' +
        '<div id="h3d-hint"></div><div id="h3d-fps">60 FPS</div>';
      document.body.appendChild(root);
    }
    const msgEl = document.getElementById('h3d-msg');
    const subEl = document.getElementById('h3d-sub');
    const hintEl = document.getElementById('h3d-hint');
    const fpsEl = document.getElementById('h3d-fps');
    let msgTimer = 0;
    const api = {
      msgEl: msgEl, subEl: subEl, hintEl: hintEl, fpsEl: fpsEl,
      /* duży komunikat na środku ekranu (np. "Start", "Meta") */
      msg(text, sub, ms) {
        msgEl.textContent = text || '';
        msgEl.classList.toggle('on', !!text);
        subEl.textContent = sub || '';
        subEl.classList.toggle('on', !!sub);
        msgTimer = ms != null ? ms : 0;
      },
      clear() {
        msgEl.textContent = ''; msgEl.classList.remove('on');
        subEl.textContent = ''; subEl.classList.remove('on');
        msgTimer = 0;
      },
      hint(text) { hintEl.textContent = text || ''; },
      fps(on) {
        fpsEl.style.display = on === false ? 'none' : '';
        return fpsEl;
      },
      flash(el) {
        if (!el) return;
        el.classList.add('on');
        setTimeout(function () { el.classList.remove('on'); }, 130);
      },
      set(id, text) { const e = document.getElementById(id); if (e) e.textContent = text; },
      tick(dt) {
        if (msgTimer > 0) {
          msgTimer -= dt;
          if (msgTimer <= 0) { msgEl.classList.remove('on'); subEl.classList.remove('on'); }
        }
      },
      dispose() {
        const r = document.getElementById('h3d-ui-root');
        if (r && r.parentNode) r.parentNode.removeChild(r);
      }
    };
    return api;
  }
/* ==========================================================================
     FX: wstrząs kamery / hitstop / slow motion (wspólne dla gier)
     const fx = Hopla3D.createFX();
     dt = fx.update(dt);                 // zwraca przeskalowany czas (0 = hitstop)
     fx.shake(0.6, 0.35);                // amplituda, czas
     fx.hitstop(0.09);
     fx.slowmo(0.45, 1.2);
     fx.apply(CAM); ... render ... fx.restore(CAM);
     ========================================================================== */
  function createFX() {
    const fx = {
      timeScale: 1, freeze: 0, shakeAmp: 0, shakeDur: 0.0001, shakeT: 0,
      offset: new THREE.Vector3(), slowT: 0
    };
    fx.shake = function (amp, dur) {
      fx.shakeAmp = Math.max(fx.shakeAmp, amp);
      fx.shakeDur = Math.max(dur || 0.3, 0.001);
      fx.shakeT = fx.shakeDur;
    };
    fx.hitstop = function (sec) { fx.freeze = Math.max(fx.freeze, sec || 0.08); };
    fx.slowmo = function (scale, dur) {
      fx.timeScale = clamp(scale, 0.05, 1);
      fx.slowT = Math.max(fx.slowT, dur || 1);
    };
    fx.update = function (dt) {
      if (fx.freeze > 0) {
        fx.freeze -= dt;
        return 0;
      }
      /* wygaszanie wstrząsu */
      if (fx.shakeT > 0) {
        fx.shakeT -= dt;
        const k = clamp(fx.shakeT / fx.shakeDur, 0, 1);
        const a = fx.shakeAmp * k * k;
        fx.offset.set(rand(-a, a), rand(-a, a) * 0.7, rand(-a, a));
        if (fx.shakeT <= 0) { fx.shakeAmp = 0; fx.offset.set(0, 0, 0); }
      } else {
        fx.offset.set(0, 0, 0);
      }
      if (fx.slowT > 0) {
        fx.slowT -= dt;
        if (fx.slowT <= 0) fx.timeScale = 1;
      }
      return dt * fx.timeScale;
    };
    fx.apply = function (camera) { if (camera) camera.position.add(fx.offset); };
    fx.restore = function (camera) { if (camera) camera.position.sub(fx.offset); };
    fx.reset = function () {
      fx.timeScale = 1; fx.freeze = 0; fx.shakeAmp = 0; fx.shakeT = 0;
      fx.slowT = 0; fx.offset.set(0, 0, 0);
    };
    return fx;
  }
/* ==========================================================================
     STEROWANIE: klawiatura + pad (Gamepad API) + dotyk + pochylenie telefonu
     const IN = Hopla3D.input();
     IN.poll();  IN.ax.x, IN.ax.y (analog -1..1), IN.held.left, IN.tap('action')
     IN.bindTouch(el, 'action')  — przycisk ekranowy
     IN.enableTilt()             — żyroskop (iOS pyta o zgodę)
     ========================================================================== */
  const DEFAULT_MAP = {
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right',
    ArrowUp: 'up', KeyW: 'up',
    ArrowDown: 'down', KeyS: 'down',
    Space: 'action', Enter: 'action',
    ShiftLeft: 'boost', ShiftRight: 'boost',
    Escape: 'pause', KeyP: 'pause',
    KeyC: 'camera', KeyR: 'restart'
  };
  /* klawiszy, których nie chcemy przewijać/przełączać w przeglądarce */
  const PREVENT = { ArrowLeft: 1, ArrowRight: 1, ArrowUp: 1, ArrowDown: 1, Space: 1, Enter: 1 };

  function input(opts) {
    opts = opts || {};
    const map = Object.assign({}, DEFAULT_MAP, opts.map || {});
    const keys = Object.create(null);       /* surowe kody klawiszy */
    const virtual = Object.create(null);    /* przyciski dotykowe */
    const taps = Object.create(null);       /* licznik naciśnięć do zużycia */
    const tapTime = Object.create(null);
    const held = Object.create(null);
    const padPrev = Object.create(null);
    const padHeld = Object.create(null);
    const padAx = { x: 0, y: 0 };
    const ax = { x: 0, y: 0 };
    let padActive = false;
    const tilt = { ok: false, x: 0, y: 0, base: null, enabled: false, invertX: false, invertY: false };

    function press(action) { taps[action] = 1; tapTime[action] = performance.now(); }

    function onKeyDown(e) {
      if ((e.code === 'Enter' || e.code === 'Space') && e.target && e.target.closest && e.target.closest('button,a')) return;
      if (PREVENT[e.code]) e.preventDefault();
      if (!e.repeat && map[e.code]) press(map[e.code]);
      keys[e.code] = true;
    }
    function onKeyUp(e) { keys[e.code] = false; }
    function onBlur() {
      for (const k in keys) keys[k] = false;
      for (const k in virtual) virtual[k] = false;
      for (const k in taps) taps[k] = 0;
      for (const k in held) held[k] = false;
      ax.x = ax.y = 0;
    }
    addEventListener('keydown', onKeyDown, { passive: false });
    addEventListener('keyup', onKeyUp);
    addEventListener('blur', onBlur);

    function readPad() {
      let pads = [];
      try { pads = navigator.getGamepads ? navigator.getGamepads() : []; } catch (e) { }
      let gp = null;
      for (let i = 0; i < pads.length; i++) { if (pads[i] && pads[i].connected) { gp = pads[i]; break; } }
      if (!gp) {
        padActive = false; padAx.x = padAx.y = 0;
        for (const k in padHeld) padHeld[k] = false;
        for (const k in padPrev) padPrev[k] = false;
        return;
      }
      padActive = true;
      const ax0 = gp.axes[0] || 0, ax1 = gp.axes[1] || 0;
      const dz = 0.22;
      const stickX = Math.abs(ax0) > dz ? ax0 : 0;
      const stickY = Math.abs(ax1) > dz ? -ax1 : 0;   /* pad: drążek w górę = +1 */
      const b = gp.buttons || [];
      const btn = i => !!(b[i] && b[i].pressed);

      padHeld.left = btn(14) || stickX < -dz;
      padHeld.right = btn(15) || stickX > dz;
      padHeld.up = btn(12) || stickY > dz;
      padHeld.down = btn(13) || stickY < -dz;
      padHeld.action = btn(0) || btn(1);
      padHeld.boost = btn(7) || btn(5);
      padHeld.brake = btn(6);
      padHeld.pause = btn(9);
      padHeld.camera = btn(3);
      padHeld.restart = btn(8);
      padAx.x = stickX; padAx.y = stickY;

      padAx.x = btn(14) ? -1 : btn(15) ? 1 : stickX;
      padAx.y = btn(12) ? 1 : btn(13) ? -1 : stickY;
      const edge = (name, val) => {
        if (val && !padPrev[name]) press(name);
        padPrev[name] = val;
      };
      edge('left', padHeld.left); edge('right', padHeld.right);
      edge('up', padHeld.up); edge('down', padHeld.down);
      edge('action', btn(0) || btn(1));
      edge('pause', btn(9));
      edge('camera', btn(3));
      edge('restart', btn(8));
    }
function poll() {
      readPad();
      const out = Object.create(null);
      for (const code in keys) {
        const a = map[code];
        if (a && keys[code]) out[a] = true;
      }
      if (padActive) for (const a in padHeld) if (padHeld[a]) out[a] = true;
      for (const a in virtual) if (virtual[a]) out[a] = true;

      held.left = !!out.left; held.right = !!out.right;
      held.up = !!out.up; held.down = !!out.down;
      held.action = !!out.action; held.boost = !!out.boost;
      held.brake = !!out.brake;
      held.pause = !!out.pause; held.camera = !!out.camera; held.restart = !!out.restart;

      const keyHeld = a => Object.keys(keys).some(code => keys[code] && map[code] === a) || virtual[a];
      let x = (keyHeld('right') ? 1 : 0) - (keyHeld('left') ? 1 : 0);
      let y = (keyHeld('up') ? 1 : 0) - (keyHeld('down') ? 1 : 0);
      if (padActive) {
        if (Math.abs(padAx.x) > Math.abs(x)) x = padAx.x;
        if (Math.abs(padAx.y) > Math.abs(y)) y = padAx.y;
      }
      ax.x = clamp(x, -1, 1); ax.y = clamp(y, -1, 1);
      return { ax: ax, held: held };
    }

    function bindTouch(el, action) {
      if (!el) return;
      const down = e => {
        if (e.preventDefault) e.preventDefault();
        el.classList.add('on');
        virtual[action] = true;
        if (!el._h3dDown) { el._h3dDown = true; press(action); }
        if (el.setPointerCapture && e.pointerId != null) {
          try { el.setPointerCapture(e.pointerId); } catch (err) { }
        }
      };
      const up = () => { el.classList.remove('on'); virtual[action] = false; el._h3dDown = false; };
      el.addEventListener('pointerdown', down);
      el.addEventListener('pointerup', up);
      el.addEventListener('pointercancel', up);
      el.addEventListener('lostpointercapture', up);
      el.addEventListener('contextmenu', e => e.preventDefault());
    }

    function onTilt(e) {
      if (e.beta == null && e.gamma == null) return;
      const b = e.beta || 0, g = e.gamma || 0;
      if (!tilt.base) tilt.base = { b: b, g: g };
      /* w orientacji poziomej osie telefonu się zamieniają — korygujemy kątem ekranu */
      const ang = ((global.screen && global.screen.orientation && global.screen.orientation.angle) || global.orientation || 0) * Math.PI / 180;
      const dx = g - tilt.base.g, dy = b - tilt.base.b;
      const cx = Math.cos(ang), sx = Math.sin(ang);
      const gx = dx * cx + dy * sx, gy = -dx * sx + dy * cx;
      tilt.x = clamp((tilt.invertX ? -gx : gx) / 30, -1, 1);
      tilt.y = clamp((tilt.invertY ? gy : -gy) / 30, -1, 1);
      tilt.ok = true;
    }

    function enableTilt() {
      if (tilt.enabled) return Promise.resolve(tilt.ok);
      tilt.enabled = true;
      const D = global.DeviceOrientationEvent;
      if (!D) { tilt.enabled = false; return Promise.resolve(false); }
      const attach = () => {
        addEventListener('deviceorientation', onTilt, true);
        return new Promise(res => setTimeout(() => res(tilt.ok), 500));
      };
      if (typeof D.requestPermission === 'function') {
        return D.requestPermission().then(s => { if (s === 'granted') return attach(); tilt.enabled = false; return false; }).catch(() => { tilt.enabled = false; return false; });
      }
      return attach();
    }

    return {
      keys: keys, held: held, ax: ax, tilt: tilt, pad: () => padActive,
      poll: poll, bindTouch: bindTouch, enableTilt: enableTilt,
      calibrateTilt() { tilt.base = null; },
      /* zużywa jedno naciśnięcie (np. skok, start, pauza) */
      tap(action) { const fresh = taps[action] > 0 && performance.now() - tapTime[action] < 300; taps[action] = 0; return fresh; },
      /* podgląd bez zużywania */
      peek(action) { return !!taps[action]; },
      reset() {
        for (const k in keys) keys[k] = false;
        for (const k in virtual) virtual[k] = false;
        for (const k in taps) taps[k] = 0;
        for (const k in held) held[k] = false;
        ax.x = ax.y = 0;
      },
      dispose() {
        removeEventListener('keydown', onKeyDown);
        removeEventListener('keyup', onKeyUp);
        removeEventListener('blur', onBlur);
        removeEventListener('deviceorientation', onTilt, true);
      }
    };
  }
/* ==========================================================================
     KAMERA: płynne śledzenie (lerp/damp) + FOV rosnące z prędkością
     const cam = Hopla3D.createChase(CAM, { dist:9, height:3, fovBase:60, fovGain:14 });
     cam.follow(pos, forwardUnit, speedNorm, dt);
     ========================================================================== */
  function createChase(camera, opts) {
    const cfg = Object.assign({
      dist: 9, height: 3.2, look: 10, lag: 7, lagLook: 10,
      fovBase: 60, fovGain: 14
    }, opts || {});
    const want = new THREE.Vector3(), wantLook = new THREE.Vector3();
    const lookAt = new THREE.Vector3(), tmp = new THREE.Vector3();
    let init = false;

    const api = {
      cfg: cfg,
      follow(pos, forward, speedN, dt) {
        if (forward) tmp.copy(forward); else tmp.set(0, 0, -1);
        if (tmp.lengthSq() < 1e-6) tmp.set(0, 0, -1);
        tmp.normalize();
        want.copy(pos).addScaledVector(tmp, -cfg.dist);
        want.y += cfg.height;
        wantLook.copy(pos).addScaledVector(tmp, cfg.look);
        if (!init) {
          camera.position.copy(want);
          lookAt.copy(wantLook);
          init = true;
        } else {
          camera.position.lerp(want, 1 - Math.exp(-cfg.lag * dt));
          lookAt.lerp(wantLook, 1 - Math.exp(-cfg.lagLook * dt));
        }
        camera.lookAt(lookAt);
        api.setFov(cfg.fovBase + cfg.fovGain * clamp(speedN || 0, 0, 1.8), dt);
      },
      /* ustawienie kamery "na sztywno" (np. powtórka, wynik) */
      place(pos, target, dt, fov) {
        if (!init) { camera.position.copy(pos); lookAt.copy(target); init = true; camera.lookAt(lookAt); }
        else {
          camera.position.lerp(pos, 1 - Math.exp(-8 * (dt || 0.016)));
          lookAt.lerp(target, 1 - Math.exp(-cfg.lagLook * (dt || 0.016)));
          camera.lookAt(lookAt);
        }
        if (fov) api.setFov(fov, dt);
      },
      setFov(target, dt) {
        const f = dt ? damp(camera.fov, target, 6, dt) : target;
        if (Math.abs(camera.fov - f) > 0.02) { camera.fov = f; camera.updateProjectionMatrix(); }
      },
      snap() { init = false; },
      /* żeby po zmianie sceny kamera nie "przeleciała" przez całą mapę */
      teleport(pos, lookTarget) {
        camera.position.copy(pos);
        lookAt.copy(lookTarget);
        init = true;
        camera.lookAt(lookAt);
      }
    };
    return api;
  }

  /* kamera menu: powolny obrót wokół obiektu (prezentacja sceny) */
  function orbitCamera(camera, target, angle, radius, height, lookY) {
    camera.position.set(
      target.x + Math.sin(angle) * radius,
      target.y + height,
      target.z + Math.cos(angle) * radius
    );
    camera.lookAt(target.x, target.y + (lookY || 0), target.z);
  }

  /* świetlna poświata (sprite additive) — tani "bloom" dla silników, gwiazd, oczu */
  function glowSprite(color, size, opacity) {
    const mat = new THREE.SpriteMaterial({
      map: glowTexture(), color: srgb(color != null ? color : PAL.gold),
      transparent: true, opacity: opacity != null ? opacity : 0.9,
      blending: THREE.AdditiveBlending, depthWrite: false,
      toneMapped: false
    });
    const sp = new THREE.Sprite(mat);
    sp.scale.set(size || 2, size || 2, 1);
    return sp;
  }

  /* ==========================================================================
     EKSPORT
     ========================================================================== */
  const Hopla3D = {
    ok: true,
    version: '1.0.0',
    THREE: THREE,
    PAL: PAL, PAL_CSS: PAL_CSS, shade: shade, srgb: srgb, srgbHex: srgbHex,
    clamp: clamp, lerp: lerp, damp: damp, smoothstep: smoothstep,
    sgn: sgn, rand: rand, pick: pick, mulberry: mulberry, fmtTime: fmtTime,
    progress: progress,
    canvasTexture: canvasTexture,
    tex: tex,
    textures: {
      glow: glowTexture, dot: dotTexture, snow: snowTexture,
      rock: rockTexture, panel: panelTexture, bib: bibTexture
    },
    glowSprite: glowSprite,
    createRenderer: createRenderer,
    setShadowSize: setShadowSize,
    SKY_PRESETS: SKY_PRESETS,
    LIGHT_PRESETS: LIGHT_PRESETS,
    createSky: createSky,
    createLights: createLights,
    addPostFX: addPostFX,
    makeHumanoid: makeHumanoid,
    poseHumanoid: poseHumanoid,
    particles: particles,
    hud: hud,
    createFX: createFX,
    input: input,
    createChase: createChase,
    orbitCamera: orbitCamera
  };
  /* TODO-KIMI: kolejne presety (świt, burza, zamieć), warianty sylwetek,
     własny composer bloom (bez plików z cdnjs), animacje tłumu. */
  /* TODO-CODEX: kalibracja ekspozycji pod ACES, LOD modeli, profilowanie
     na Intel Iris / M1, dopracowanie cieni przy niskim słońcu. */
  global.Hopla3D = Hopla3D;
})(typeof window !== 'undefined' ? window : this);
