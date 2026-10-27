const C='hopla-v4',F=['./','index.html','manifest.json','icon.png','dzungla.html','kart3d.html','odcinek.html','vocab.json'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>Promise.all(F.map(u=>c.add(u).catch(()=>{})))).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(k=>Promise.all(k.filter(n=>n!==C).map(n=>caches.delete(n)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{const r=e.request;if(r.method!=='GET'||r.headers.has('range'))return;const u=new URL(r.url);
 const same=u.origin===location.origin,lib=/cdn\.jsdelivr|cdnjs|unpkg|storage\.googleapis\.com\/mediapipe/.test(u.host+u.pathname);if(!same&&!lib)return;
 e.respondWith(fetch(r).then(res=>{if(res.status===200&&(same?!u.search:true)){const cp=res.clone();caches.open(C).then(c=>c.put(r,cp)).catch(()=>{})}return res}).catch(()=>caches.match(r,{ignoreSearch:true}).then(m=>m||(r.mode==='navigate'?caches.match('index.html'):Response.error()))))});
