/*
  ALERTA CERCA · SERVIDOR DEL CENTRO DE MONITOREO
  Flujo:  📱 index.html (celular)  →  🖥 este servidor (monitoreo)  →  📡 torre (Cell Broadcast)

  - Sin dependencias: solo Node.js (v16 o superior).
  - http://localhost:3000/         → centro de monitoreo (centro_monitoreo.html)
  - http://IP-DE-ESTA-PC:3000/app  → app del celular (index.html)
  - Cada alerta que llega se reenvía a la torre con el JSON ETWS y un message_id nuevo.
  - Sincroniza alertas entre todos los dispositivos con Server-Sent Events (SSE).
  - Guarda las alertas en alertas.json para que sobrevivan a un reinicio.

  Uso:  node server.js        (o PORT=8080 node server.js)
*/
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 3000;
const DIR = __dirname;

/* ======================================================================
   CONFIGURACIÓN EDITABLE (se guarda en config.json)
   La IP de la torre NO está fija en el código. Puedes cambiarla de 3 formas:
     1) Desde el monitoreo: 📱 Conectar celular → ⚙️ Torre → Guardar   (no hay que reiniciar)
     2) Al iniciar:          node server.js 192.168.3.200
     3) Editando config.json y reiniciando el servidor
   ====================================================================== */
const CONFIG_FILE = path.join(DIR, 'config.json');
const DEFAULT_CONFIG = {
  torreIp: '192.168.3.151',          /* valor inicial; después manda lo que diga config.json */
  torrePuerto: 8080,
  torreRuta: '/api/ecbe/v1/message',
  githubUrl: '',                     /* ej. https://usuario.github.io/hackaitlac/ */
  servidorPublico: ''                /* ej. https://algo.trycloudflare.com (túnel HTTPS) */
};
let CONFIG = { ...DEFAULT_CONFIG };
try { CONFIG = { ...DEFAULT_CONFIG, ...JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) }; } catch (e) { /* se crea abajo */ }
const HOST_RE = /^[a-zA-Z0-9.-]{1,253}$/;
if (process.argv[2]) {
  const [ip, port] = process.argv[2].split(':');
  if (HOST_RE.test(ip)) { CONFIG.torreIp = ip; if (port && +port > 0 && +port < 65536) CONFIG.torrePuerto = +port; }
  else console.log(`  ⚠️  "${process.argv[2]}" no parece una IP válida; se ignora.`);
}
if (process.env.TORRE_IP && HOST_RE.test(process.env.TORRE_IP)) CONFIG.torreIp = process.env.TORRE_IP;
if (process.env.TORRE_PUERTO) CONFIG.torrePuerto = +process.env.TORRE_PUERTO;
function saveConfig() { fs.writeFileSync(CONFIG_FILE, JSON.stringify(CONFIG, null, 2)); }
saveConfig();
function towerUrl() {
  return process.env.CBC_URL || `http://${CONFIG.torreIp}:${CONFIG.torrePuerto}${CONFIG.torreRuta}`;
}
/* Solo la computadora del monitoreo (localhost) puede cambiar la configuración o reiniciar la demo */
function isAdminReq(req) {
  const ip = req.socket.remoteAddress || '';
  const loop = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
  return loop && !req.headers['cf-connecting-ip'] && !req.headers['x-forwarded-for'];
}
const DB = path.join(DIR, 'alertas.json');
/* ======================================================================
   NIVELES DE ALERTAMIENTO (objetivo 3)
   Cada nivel define: radio inicial y crecimiento, velocidad de expansión,
   tipo de notificación en el celular y si puede escalar a Cell Broadcast.
   ====================================================================== */
const LEVELS = {
  info:       { n: 'Informativa', radios: [0.5, 1],      stepMin: 30, cbc: 'nunca' },
  precaucion: { n: 'Precaución',  radios: [1, 2, 3],     stepMin: 20, cbc: 'nunca' },
  urgente:    { n: 'Urgente',     radios: [1, 3, 5],     stepMin: 15, cbc: 'solo verificada' },
  critica:    { n: 'Crítica',     radios: [1, 3, 5, 10], stepMin: 10, cbc: 'verificada u oficial' }
};
/* CATÁLOGO COMPLETO (las 12 categorías del reto + robo a casa y botón de pánico)
   lvl = nivel por defecto · personal = contiene datos personales de terceros */
const CATS = {
  menor:        { n: 'Desaparicion o posible sustraccion de menor', lvl: 'critica', personal: true },
  desaparecida: { n: 'Persona desaparecida',                        lvl: 'urgente', personal: true },
  adulto:       { n: 'Adulto mayor o persona vulnerable extraviada', lvl: 'urgente', personal: true },
  vehiculo:     { n: 'Robo de vehiculo',                            lvl: 'urgente' },
  casa:         { n: 'Robo a casa o comercio',                      lvl: 'precaucion' },
  asalto:       { n: 'Asalto o situacion de riesgo',                lvl: 'urgente' },
  panico:       { n: 'Boton de panico activado',                    lvl: 'critica' },
  incendio:     { n: 'Incendio',                                    lvl: 'urgente' },
  inundacion:   { n: 'Inundacion',                                  lvl: 'urgente' },
  accidente:    { n: 'Accidente o emergencia relevante',            lvl: 'precaucion' },
  ambiental:    { n: 'Riesgo ambiental',                            lvl: 'precaucion' },
  evacuacion:   { n: 'Evacuacion',                                  lvl: 'critica' },
  fenomeno:     { n: 'Fenomeno natural',                            lvl: 'urgente' },
  otra:         { n: 'Otra situacion de riesgo',                    lvl: 'info' }
};
const CAT_KEYS = Object.keys(CATS);

/* ======================================================================
   ANTIABUSO Y CONFIABILIDAD (objetivos 7, 8 y 9)
   ====================================================================== */
const ANTI = {
  rateMax: +(process.env.RATE_MAX || 3),        /* reportes máximos por dispositivo… */
  rateMin: +(process.env.RATE_MIN || 10),       /* …cada N minutos */
  dupM: +(process.env.DUP_M || 300),            /* antiduplicados: misma categoría a menos de X metros… */
  dupMin: +(process.env.DUP_MIN || 30),         /* …y Y minutos */
  expireMin: +(process.env.EXPIRE_MIN || 20),   /* caducidad de reportes ciudadanos no confirmados */
  blockAfter: +(process.env.BLOCK_AFTER || 2),  /* bloquear dispositivo tras N reportes falsos… */
  blockHours: +(process.env.BLOCK_HOURS || 24)  /* …durante N horas */
};
let devices = {};   /* reputación por identificador anónimo de dispositivo (UUID) */
const SIM_OWNERS = ['', 'sim', 'monitor'];
function devOf(id) {
  id = String(id || '');
  if (SIM_OWNERS.includes(id)) return null;
  return devices[id] || (devices[id] = { id, first: Date.now(), reports: 0, good: 0, bad: 0, times: [], blockedUntil: 0 });
}
function devRep(d) { return d ? Math.max(-40, Math.min(20, d.good * 8 - d.bad * 20)) : 0; }
function devPublic(d) {
  if (!d) return null;
  return { id: d.id, reports: d.reports, good: d.good, bad: d.bad, rep: devRep(d), blocked: d.blockedUntil > Date.now(), blockedUntil: d.blockedUntil, first: d.first, attest: d.attest || 'no verificada' };
}
function distKm(a, b) {
  const R = 6371, t = Math.PI / 180, dl = (b.lat - a.lat) * t, dg = (b.lng - a.lng) * t;
  const h = Math.sin(dl / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dg / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
/* Índice de confiabilidad 0–100: confirmaciones, evidencia, historial del dispositivo y reportes de falsedad */
function computeTrust(a) {
  const parts = [];
  if (a.verified) parts.push(['Verificada por ' + (a.verifiedBy || 'autoridad'), 95]);
  else {
    parts.push(a.origin === 'monitor' ? ['Emitida por el centro de monitoreo', 60] : ['Reporte ciudadano (base)', 25]);
    if (a.conf) parts.push([`${a.conf} confirmación(es) "lo vi aquí"`, Math.min(a.conf, 4) * 12]);
    if (a.photo) parts.push(['Evidencia adjunta (foto)', 10]);
    if (a.desc && a.desc.length >= 30) parts.push(['Descripción detallada', 5]);
    const d = devices[a.owner];
    if (d) parts.push([`Historial del dispositivo (${d.good} confiables, ${d.bad} falsos)`, devRep(d)]);
    if (a.flags) parts.push([`${a.flags} reporte(s) de información falsa`, -15 * a.flags]);
  }
  a.trust = Math.max(0, Math.min(100, parts.reduce((s, x) => s + x[1], 0)));
  a.trustParts = parts;
  return a.trust;
}
/* Datos autorizados (objetivo 6): la foto y los datos de terceros (personas desaparecidas, menores)
   no se publican hasta que un operador confirma la autorización del familiar o tutor. */
function pub(a) {
  if (!a.restricted) return { ...a, hasPrivate: false };
  return { ...a, photo: null, hasPrivate: true,
    desc: 'Reporte de persona en revisión. La foto y los datos se publicarán cuando un operador confirme la autorización del familiar o tutor.' };
}
function emit(action, a) { computeTrust(a); broadcast({ type: 'upsert', action, alert: pub(a) }); }

/* ---------- datos ---------- */
let alerts = [];
let seq = 5000;
let cbcSeq = null; /* último message_id usado en la torre */
try {
  const d = JSON.parse(fs.readFileSync(DB, 'utf8'));
  alerts = d.alerts || [];
  seq = d.seq || 5000;
  cbcSeq = d.cbcSeq ?? null;
  devices = d.devices || {};
  alerts.forEach(a => { if (!LEVELS[a.level]) a.level = (CATS[a.cat] || {}).lvl || 'urgente'; });
  console.log(`Cargadas ${alerts.length} alertas de alertas.json`);
} catch (e) { /* primera ejecución */ }

let saveT = null;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => fs.writeFile(DB, JSON.stringify({ seq, cbcSeq, alerts, devices }), () => {}), 500);
}

/* ======================================================================
   TORRE CELULAR (Cell Broadcast / ETWS)
   Cada alerta nueva se envía a la API de la torre con un message_id distinto.
   Configuración con variables de entorno (o cambia los valores por defecto aquí):
     (la IP y el puerto de la torre se configuran arriba, en config.json)
    CBC_URL         URL completa de la torre (opcional, reemplaza a config.json)
     CBC_ENABLED     1 = enviar, 0 = no enviar
     CBC_MODE        nivel (por defecto: Crítica oficial/verificada y Urgente verificada) | todas
     CBC_FIRST_ID    primer message_id a usar (después se incrementa solo)
   ====================================================================== */
const CBC = {
  enabled: process.env.CBC_ENABLED !== '0',
  mode: process.env.CBC_MODE || 'nivel', /* nivel = según el nivel de la alerta · todas = enviar todo */
  firstId: +(process.env.CBC_FIRST_ID || 5371),
  cbeName: process.env.CBC_CBE_NAME || 'sistema-alertas-gob',
  repetition: +(process.env.CBC_REPETITION || 10),
  numBcast: +(process.env.CBC_NUM_BCAST || 100),
  serial: +(process.env.CBC_SERIAL || 4096),
  warningType: process.env.CBC_WARNING_TYPE || 'earthquake',
  stopOnClose: process.env.CBC_STOP === '1', /* 1 = pedir a la torre que deje de repetir al cerrar (DELETE) */
  timeoutMs: 5000
};
/* Las torres usan el alfabeto GSM: se quitan acentos, emojis y caracteres raros */
function gsmText(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/ñ/g, 'n').replace(/Ñ/g, 'N')
    .replace(/[^\x20-\x7E]/g, '').replace(/\s+/g, ' ').trim();
}
function cbcMessage(a) {
  let t = `ALERTA CERCA ${LEVELS[a.level || 'urgente'].n.toUpperCase()}: ${CATS[a.cat].n}.`;
  t += a.verified ? ' VERIFICADA.' : ' NO CONFIRMADA.';
  const d = String(pub(a).desc || '').trim();
  if (d) t += ' ' + d + (/[.!?]$/.test(d) ? '' : '.');
  t += ` Ubicacion: ${a.lat.toFixed(4)},${a.lng.toFixed(4)}.`;
  t = gsmText(t);
  return t.length > 300 ? t.slice(0, 297) + '...' : t;
}
function nextMessageId() {
  cbcSeq = cbcSeq == null ? CBC.firstId : cbcSeq + 1;
  if (cbcSeq > 65535) cbcSeq = CBC.firstId; /* message_id es de 16 bits */
  save();
  return cbcSeq;
}
function cbcPayload(a, messageId, warningType) {
  return {
    cbe_name: CBC.cbeName,
    repetition_period: CBC.repetition,
    num_of_bcast: CBC.numBcast,
    message_id: messageId,
    serial_nr: { serial_nr_encoded: CBC.serial },
    scope: { scope_plmn: [] },
    smscb_message: {
      message_id: messageId,
      serial_nr: { serial_nr_encoded: CBC.serial },
      payload: {
        payload_type: 'payload_etws',
        payload_etws: {
          warning_type: { warning_type_decoded: warningType },
          emergency_user_alert: true,
          popup_on_display: true,
          warning_sec_info: { warning_sec_info_decoded: { message: cbcMessage(a) } }
        }
      }
    }
  };
}
function httpRequest(method, url, data) {
  return new Promise(resolve => {
    let u;
    try { u = new URL(url); } catch (e) { return resolve({ ok: false, status: 0, text: 'URL inválida' }); }
    const lib = u.protocol === 'https:' ? https : http;
    const body = data ? JSON.stringify(data) : null;
    const req = lib.request(u, { method, headers: body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}, timeout: CBC.timeoutMs }, res => {
      let txt = ''; res.on('data', c => txt += c);
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: txt.slice(0, 300) }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, text: 'tiempo de espera agotado (¿la torre está encendida y en la misma red?)' }); });
    req.on('error', e => resolve({ ok: false, status: 0, text: e.code || e.message }));
    if (body) req.write(body);
    req.end();
  });
}
function shouldSendToTower(a) {
  if (!CBC.enabled || a.status !== 'activa' || (a.cbc && a.cbc.status === 'enviado')) return false;
  if (CBC.mode === 'todas') return true;
  /* Escalamiento por nivel: la torre llega a TODOS los celulares, por eso se reserva para información confiable */
  const oficial = a.verified || a.origin === 'monitor';
  if (a.level === 'critica') return oficial;
  if (a.level === 'urgente') return a.verified;
  return false; /* Informativa y Precaución nunca van a la torre */
}
async function sendToTower(a, force) {
  if (!force && !shouldSendToTower(a)) return;
  const messageId = nextMessageId();
  let payload = cbcPayload(a, messageId, CBC.warningType);
  a.cbc = { status: 'enviando', messageId, at: Date.now(), message: cbcMessage(a), payload };
  emit('cbc', a);
  console.log(`   📡 ${a.id} → torre ${towerUrl()} · message_id ${messageId}`);
  let r = await httpRequest('POST', towerUrl(), payload);
  /* si la torre no acepta el tipo de alerta, se reintenta con "earthquake" (el que funcionó en tu prueba con curl) */
  if (!r.ok && r.status >= 400 && r.status < 500 && CBC.warningType !== 'earthquake') {
    console.log(`   📡 la torre rechazó warning_type "${CBC.warningType}" (${r.status}); reintentando con "earthquake"`);
    payload = cbcPayload(a, messageId, 'earthquake');
    r = await httpRequest('POST', towerUrl(), payload);
  }
  a.cbc.payload = payload;
  a.cbc = { ...a.cbc, status: r.ok ? 'enviado' : 'error', httpStatus: r.status, error: r.ok ? null : r.text, at: Date.now() };
  console.log(r.ok ? `   📡 ${a.id} enviada a la torre · message_id ${messageId} · HTTP ${r.status}`
                   : `   ⚠️  ${a.id} NO llegó a la torre · message_id ${messageId} · ${r.status || ''} ${r.text}`);
  save();
  emit('cbc', a);
}
/* Al cerrar o retirar una alerta se pide a la torre que deje de repetirla (si la API lo permite) */
async function stopTowerBroadcast(a) {
  if (!CBC.stopOnClose || !a.cbc || a.cbc.status !== 'enviado') return;
  const r = await httpRequest('DELETE', `${towerUrl().replace(/\/$/, '')}/${a.cbc.messageId}`);
  a.cbc = { ...a.cbc, status: r.ok ? 'detenido' : 'enviado', stopAt: r.ok ? Date.now() : null };
  console.log(r.ok ? `   📡 ${a.id} difusión detenida en la torre (message_id ${a.cbc.messageId})`
                   : `   ℹ️  la torre no confirmó la cancelación de ${a.cbc.messageId} (${r.status || r.text}); se detendrá sola al terminar sus repeticiones`);
  save();
  emit('cbc', a);
}

/* ---------- reglas (idénticas en las dos páginas para el modo local) ---------- */
function makeAlert(b, id) {
  if (!CAT_KEYS.includes(b.cat)) throw new Error('categoría inválida');
  const lat = +b.lat, lng = +b.lng;
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) throw new Error('ubicación inválida');
  const now = Date.now(), ver = !!b.verified;
  return {
    id, cat: b.cat, lat, lng, t: now,
    speed: Math.min(500, Math.max(1, +b.speed || 1)),
    status: 'activa', verified: ver,
    level: LEVELS[b.level] ? b.level : CATS[b.cat].lvl,
    restricted: !!CATS[b.cat].personal && !b.authorization,
    authorization: b.authorization ? { tutor: String(b.authorization.tutor || '').slice(0, 80), parentesco: String(b.authorization.parentesco || '').slice(0, 40), by: String(b.authorization.by || 'Operador').slice(0, 60), at: now } : null,
    confBy: [], flagBy: [],
    expiresAt: !ver && b.cat !== 'panico' && b.origin !== 'monitor' ? now + ANTI.expireMin * 60000 : null,
    src: String(b.src || 'Reporte ciudadano').slice(0, 60),
    conf: 0, flags: 0,
    desc: String(b.desc || '').slice(0, 500),
    photo: typeof b.photo === 'string' && /^data:image\/(jpeg|png|webp);base64,/.test(b.photo) && b.photo.length < 1500000 ? b.photo : null,
    origin: String(b.origin || 'app').slice(0, 20),
    owner: String(b.owner || '').slice(0, 40),
    verifiedAt: ver ? now : null,
    verifiedBy: ver ? String(b.src || '').slice(0, 60) : null,
    closedAt: null,
    trail: b.cat === 'panico' ? [[lat, lng]] : null
  };
}
function applyAct(a, act, b) {
  b = b || {};
  const now = Date.now();
  a.confBy = a.confBy || []; a.flagBy = a.flagBy || [];
  if (a.status !== 'activa') return a;
  switch (act) {
    case 'confirm':
      if (b.owner) {
        if (b.owner === a.owner) throw new Error('No puedes confirmar tu propio reporte');
        if (a.confBy.includes(b.owner)) throw new Error('Ya confirmaste esta alerta');
        a.confBy.push(b.owner); if (a.confBy.length > 500) a.confBy.shift();
      }
      a.conf++;
      if (a.conf >= 2) a.expiresAt = null; /* con 2 confirmaciones ya no caduca */
      break;
    case 'flag':
      if (b.owner) {
        if (a.flagBy.includes(b.owner)) throw new Error('Ya reportaste esta alerta como falsa');
        a.flagBy.push(b.owner);
      }
      a.flags++; if (a.flags >= 3 && !a.verified) { a.status = 'retirada'; a.closedAt = now; } break;
    case 'verify': a.verified = true; a.verifiedAt = now; a.expiresAt = null; a.verifiedBy = String(b.by || 'Operador').slice(0, 60); break;
    case 'level':
      if (!LEVELS[b.level]) throw new Error('Nivel no válido');
      a.level = b.level; a.levelBy = String(b.by || 'Operador').slice(0, 60); break;
    case 'authorize':
      if (!b.tutor || !b.parentesco) throw new Error('Indica nombre y parentesco del familiar o tutor que autoriza');
      a.restricted = false;
      a.authorization = { tutor: String(b.tutor).slice(0, 80), parentesco: String(b.parentesco).slice(0, 40), by: String(b.by || 'Operador').slice(0, 60), at: now };
      break;
    case 'expire': a.status = 'caducada'; a.closedAt = now; break;
    case 'resolve': a.status = 'resuelta'; a.closedAt = now; break;
    case 'retire': a.status = 'retirada'; a.closedAt = now; break;
    case 'move': {
      const lat = +b.lat, lng = +b.lng;
      if (isFinite(lat) && isFinite(lng)) {
        a.lat = lat; a.lng = lng;
        if (a.trail) { a.trail.push([lat, lng]); if (a.trail.length > 300) a.trail.shift(); }
      }
      break;
    }
    default: throw new Error('acción inválida');
  }
  return a;
}

/* ---------- tiempo real (SSE) ---------- */
const clients = new Set();
function sse(res, obj) { res.write(`data: ${JSON.stringify(obj)}\n\n`); }
function broadcast(obj) { for (const c of clients) sse(c, obj); }
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 20000);

/* ---------- caducidad automática de reportes no confirmados ---------- */
setInterval(() => {
  const now = Date.now();
  alerts.forEach(a => {
    if (a.status === 'activa' && a.expiresAt && !a.verified && a.conf < 2 && now >= a.expiresAt) {
      applyAct(a, 'expire'); save(); emit('expire', a); stopTowerBroadcast(a);
      console.log(`   ⌛ ${a.id} caducó: nadie lo confirmó en ${ANTI.expireMin} min`);
    }
  });
}, 15000);

/* ---------- utilidades HTTP ---------- */
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' };
function json(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', ...CORS }); res.end(JSON.stringify(obj)); }
function body(req) {
  return new Promise((ok, ko) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 3e6) { ko(new Error('contenido demasiado grande')); req.destroy(); } });
    req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch (e) { ko(new Error('JSON inválido')); } });
  });
}
function lanIPs() {
  return Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
}

/* ---------- dirección que debe abrir el celular ---------- */
function appUrl(req) {
  const host = req.headers.host || `localhost:${PORT}`;
  const isLocal = /^(localhost|127\.)/.test(host);
  const ip = lanIPs()[0];
  const proto = req.headers['x-forwarded-proto'] || 'http';
  return (isLocal && ip ? `http://${ip}:${PORT}` : `${proto}://${host}`) + '/app';
}
/* ---------- página auxiliar /inicio con QR ---------- */
function landing(req) {
  const base = appUrl(req).replace(/\/app$/, '');
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ALERTA CERCA · Servidor</title>
<style>body{font-family:system-ui,sans-serif;background:#14161a;color:#fff;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px}
.c{background:#fff;color:#14161a;border-radius:20px;padding:28px;max-width:520px;width:100%;text-align:center}
h1{margin:0;font-size:26px}h1 span{color:#ff6b35}p{color:#6b7280}
a.b{display:block;margin:10px 0;padding:14px;border-radius:12px;background:#d62828;color:#fff;font-weight:700;text-decoration:none}
a.b.k{background:#14161a}#qr{display:flex;justify-content:center;margin:18px 0}
code{background:#f3f4f6;padding:3px 6px;border-radius:6px;font-size:13px}button{margin-top:14px;border:1.5px solid #e5e7eb;background:#fff;border-radius:10px;padding:8px 12px;cursor:pointer}</style></head>
<body><div class="c"><h1>ALERTA <span>CERCA</span></h1><p>Servidor de sincronización activo · ${clients.size} dispositivo(s) conectado(s) · ${alerts.length} alerta(s)</p>
<a class="b k" href="/">🖥 Abrir centro de monitoreo</a><a class="b" href="/app">📱 Abrir app móvil (index.html)</a>
<p style="font-size:13px">📡 Torre: ${CBC.enabled ? `<b>activa</b> · ${towerUrl()}<br>modo: ${CBC.mode} · último message_id: ${cbcSeq ?? '(ninguno)'}` : '<b>desactivada</b>'}</p>
${CBC.enabled ? `<button onclick="this.disabled=true;this.textContent='Enviando…';fetch('/api/cbc/test',{method:'POST'}).then(r=>r.json()).then(d=>{alert((d.ok?'✅ La torre respondió OK':'❌ La torre no respondió bien')+'\nmessage_id: '+d.messageId+'\nHTTP: '+d.status+'\n'+(d.respuesta||''));location.reload();})">📡 Probar torre</button>` : ''}
<p>Escanea con el celular (misma red Wi-Fi):</p><div id="qr"></div><code>${base}/app</code>
<div><button onclick="if(confirm('¿Borrar todas las alertas en vivo?'))fetch('/api/reset',{method:'POST'}).then(()=>location.reload())">↺ Reiniciar alertas de la demo</button></div></div>
<script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
<script>try{new QRCode(document.getElementById('qr'),{text:${JSON.stringify(base + '/app')},width:200,height:200});}catch(e){}</script></body></html>`;
}

/* ---------- rutas ---------- */
/* El centro de monitoreo puede llamarse centro_monitoreo.html o monitoreo.html */
const MONITOR_FILE = fs.existsSync(path.join(DIR, 'centro_monitoreo.html')) ? 'centro_monitoreo.html' : 'monitoreo.html';
const PAGES = {
  '/': MONITOR_FILE, '/monitor': MONITOR_FILE, '/monitoreo': MONITOR_FILE, '/monitoreo.html': MONITOR_FILE, '/centro_monitoreo.html': MONITOR_FILE,
  '/app': 'index.html', '/index.html': 'index.html'
};

const server = http.createServer(async (req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

    if (p === '/api/ping') return json(res, 200, { ok: true, anti: ANTI, levels: LEVELS, alerts: alerts.length, clients: clients.size, appUrl: appUrl(req), cbc: { enabled: CBC.enabled, url: towerUrl(), mode: CBC.mode, lastId: cbcSeq, nextId: cbcSeq == null ? CBC.firstId : cbcSeq + 1 }, config: CONFIG, admin: isAdminReq(req), fixedByEnv: !!process.env.CBC_URL });

    if (p === '/api/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no', ...CORS });
      res.write('retry: 2000\n\n');
      sse(res, { type: 'snapshot', alerts: alerts.map(a => { computeTrust(a); return pub(a); }) });
      clients.add(res);
      console.log(`+ dispositivo conectado (${clients.size})`);
      req.on('close', () => { clients.delete(res); console.log(`- dispositivo desconectado (${clients.size})`); });
      return;
    }

    if (req.method === 'GET' && p === '/api/alerts') return json(res, 200, alerts.map(pub));

    /* Detalle completo (incluye datos en resguardo y reputación del dispositivo): solo monitoreo */
    const full = p.match(/^\/api\/alerts\/([\w-]+)\/full$/);
    if (req.method === 'GET' && full) {
      if (!isAdminReq(req)) return json(res, 403, { error: 'Solo el centro de monitoreo puede ver los datos completos' });
      const a = alerts.find(x => x.id === full[1]);
      if (!a) return json(res, 404, { error: 'la alerta no existe' });
      computeTrust(a);
      return json(res, 200, { alert: a, device: devPublic(devices[a.owner]) });
    }

    /* Bloquear / desbloquear un dispositivo reincidente: solo monitoreo */
    const dv = p.match(/^\/api\/devices\/([\w-]+)\/(block|unblock)$/);
    if (req.method === 'POST' && dv) {
      if (!isAdminReq(req)) return json(res, 403, { error: 'Solo desde el centro de monitoreo' });
      const d = devices[dv[1]];
      if (!d) return json(res, 404, { error: 'dispositivo desconocido' });
      d.blockedUntil = dv[2] === 'block' ? Date.now() + ANTI.blockHours * 3600000 : 0;
      save();
      console.log(`   ${dv[2] === 'block' ? '🚫 bloqueado' : '✅ desbloqueado'} dispositivo ${d.id}`);
      alerts.filter(a => a.owner === d.id && a.status === 'activa').forEach(a => emit('device', a));
      return json(res, 200, { ok: true, device: devPublic(d) });
    }

    if (req.method === 'POST' && p === '/api/alerts') {
      const b = await body(req), admin = isAdminReq(req), now = Date.now();
      if (b.origin === 'monitor' && !admin) b.origin = 'app';          /* nadie se hace pasar por el monitoreo */
      if (b.verified && !(admin || b.owner === 'sim')) b.verified = false; /* solo un operador verifica */
      if (b.authorization && !admin) delete b.authorization;           /* solo un operador autoriza datos de terceros */
      if (!CAT_KEYS.includes(b.cat)) return json(res, 400, { error: 'categoría inválida' });
      const d = devOf(b.owner);
      if (d) {
        if (d.blockedUntil > now) return json(res, 403, { code: 'blocked', error: `Este dispositivo está bloqueado temporalmente por reportes falsos (hasta ${new Date(d.blockedUntil).toLocaleString('es-MX')}).` });
        d.times = d.times.filter(t => now - t < ANTI.rateMin * 60000);
        if (b.cat !== 'panico' && d.times.length >= ANTI.rateMax) return json(res, 429, { code: 'rate', error: `Límite alcanzado: máximo ${ANTI.rateMax} reportes cada ${ANTI.rateMin} minutos por dispositivo.` });
        d.attest = b.integ === 'web-demo' ? 'simulada (navegador)' : 'no verificada';
      }
      /* ANTIDUPLICADOS: misma categoría a menos de dupM metros y dupMin minutos → se suma como confirmación.
         En producción (PostgreSQL + PostGIS) esta búsqueda es:
           SELECT id FROM alertas
            WHERE estado = 'activa' AND categoria = $1
              AND creada > now() - make_interval(mins => $2)
              AND ST_DWithin(ubicacion::geography, ST_SetSRID(ST_MakePoint($lng, $lat), 4326)::geography, $3)
            ORDER BY ubicacion <-> ST_SetSRID(ST_MakePoint($lng, $lat), 4326) LIMIT 1; */
      if (b.cat !== 'panico' && b.origin !== 'monitor' && isFinite(+b.lat) && isFinite(+b.lng)) {
        const dup = alerts.filter(x => x.status === 'activa' && x.cat === b.cat && now - x.t <= ANTI.dupMin * 60000 && distKm(x, { lat: +b.lat, lng: +b.lng }) * 1000 <= ANTI.dupM)
          .sort((x, y) => distKm(x, b) - distKm(y, b))[0];
        if (dup) {
          if (dup.owner && dup.owner === b.owner) return json(res, 409, { code: 'own-dup', id: dup.id, error: `Ya reportaste este acontecimiento (está activo como ${dup.id}).` });
          try { applyAct(dup, 'confirm', { owner: b.owner }); } catch (e) { return json(res, 409, { id: dup.id, error: e.message }); }
          save(); emit('confirm', dup);
          console.log(`   ♻️  duplicado de ${dup.id} → sumado como confirmación (${dup.conf})`);
          return json(res, 200, { merged: true, id: dup.id, alert: pub(dup) });
        }
      }
      const a = makeAlert(b, 'A-' + (++seq));
      if (d) { d.reports++; d.times.push(now); }
      alerts.push(a); save();
      emit('create', a);
      sendToTower(a);
      console.log(`🔔 ${a.id} ${a.cat} · ${LEVELS[a.level].n} · ${a.origin} · ${a.src}${a.restricted ? ' · datos en resguardo' : ''}`);
      return json(res, 201, pub(a));
    }

    const m = p.match(/^\/api\/alerts\/([\w-]+)\/(\w+)$/);
    if (req.method === 'POST' && m) {
      const a = alerts.find(x => x.id === m[1]);
      if (!a) return json(res, 404, { error: 'la alerta no existe' });
      const b = await body(req), admin = isAdminReq(req);
      if (['verify', 'retire', 'level', 'authorize', 'cbc'].includes(m[2]) && !admin)
        return json(res, 403, { error: 'Esta acción solo la puede hacer un operador del centro de monitoreo' });
      if (m[2] === 'resolve' && !admin && !(b.owner && b.owner === a.owner))
        return json(res, 403, { error: 'Solo quien hizo el reporte o un operador pueden cerrarlo' });
      if (m[2] === 'move' && !(b.owner && b.owner === a.owner)) return json(res, 403, { error: 'No autorizado' });
      if (m[2] === 'expire') return json(res, 403, { error: 'No autorizado' });
      if (m[2] === 'cbc') { sendToTower(a, true); return json(res, 202, { ok: true }); }
      const before = { status: a.status, verified: a.verified };
      applyAct(a, m[2], b);
      /* reputación del dispositivo que hizo el reporte */
      const d = devices[a.owner];
      if (d) {
        if (!a._good && ((!before.verified && a.verified) || (admin && before.status === 'activa' && a.status === 'resuelta'))) { a._good = 1; d.good++; }
        if (!a._bad && before.status === 'activa' && a.status === 'retirada') {
          a._bad = 1; d.bad++;
          if (d.bad >= ANTI.blockAfter) { d.blockedUntil = Date.now() + ANTI.blockHours * 3600000; console.log(`   🚫 dispositivo ${d.id} bloqueado ${ANTI.blockHours} h (${d.bad} reportes falsos)`); }
        }
      }
      save();
      if (m[2] === 'verify' || m[2] === 'level') sendToTower(a);
      if (['resolve', 'retire', 'flag'].includes(m[2]) && a.status !== 'activa') stopTowerBroadcast(a);
      emit(m[2], a);
      if (m[2] !== 'move') console.log(`   ${a.id} → ${m[2]} (${a.status})`);
      return json(res, 200, a);
    }

    if (req.method === 'POST' && p === '/api/config') {
      if (!isAdminReq(req)) return json(res, 403, { error: 'Solo se puede cambiar desde la computadora del monitoreo (localhost).' });
      const b = await body(req);
      if (b.torreIp !== undefined) {
        const ip = String(b.torreIp).trim();
        if (!HOST_RE.test(ip)) return json(res, 400, { error: 'IP o nombre de la torre no válido' });
        CONFIG.torreIp = ip;
      }
      if (b.torrePuerto !== undefined) {
        const port = +b.torrePuerto;
        if (!(port > 0 && port < 65536)) return json(res, 400, { error: 'Puerto no válido' });
        CONFIG.torrePuerto = port;
      }
      if (b.githubUrl !== undefined) CONFIG.githubUrl = String(b.githubUrl).trim().slice(0, 300);
      if (b.servidorPublico !== undefined) CONFIG.servidorPublico = String(b.servidorPublico).trim().replace(/\/+$/, '').slice(0, 300);
      saveConfig();
      console.log(`  ⚙️  Configuración actualizada · torre: ${towerUrl()}`);
      return json(res, 200, { ok: true, config: CONFIG, url: towerUrl() });
    }

    if (req.method === 'POST' && p === '/api/cbc/test') {
      if (!isAdminReq(req)) return json(res, 403, { error: 'Solo desde la computadora del monitoreo' });
      const test = { id: 'PRUEBA', cat: 'accidente', lat: 17.9583, lng: -102.1944, verified: true, status: 'activa', desc: 'Mensaje de prueba del sistema, no requiere accion.' };
      const messageId = nextMessageId();
      const r = await httpRequest('POST', towerUrl(), cbcPayload(test, messageId, CBC.warningType));
      console.log(`   📡 prueba de torre · message_id ${messageId} · ${r.ok ? 'OK' : 'ERROR'} ${r.status || ''} ${r.ok ? '' : r.text}`);
      return json(res, r.ok ? 200 : 502, { ok: r.ok, messageId, status: r.status, respuesta: r.text, url: towerUrl() });
    }

    if (req.method === 'POST' && p === '/api/reset') {
      if (!isAdminReq(req)) return json(res, 403, { error: 'Solo desde la computadora del monitoreo' });
      alerts = []; devices = {}; save(); broadcast({ type: 'reset' });
      console.log('↺ alertas reiniciadas');
      return json(res, 200, { ok: true });
    }

    if (PAGES[p]) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(path.join(DIR, PAGES[p])).on('error', () => res.end('Archivo no encontrado')).pipe(res);
    }
    if (p === '/inicio') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); return res.end(landing(req)); }

    json(res, 404, { error: 'no encontrado' });
  } catch (e) {
    json(res, 400, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log('\n  ALERTA CERCA · servidor del centro de monitoreo\n');
  console.log(`  1) Monitoreo (esta PC):  http://localhost:${PORT}`);
  if (CONFIG.githubUrl && CONFIG.servidorPublico) console.log(`     App en GitHub Pages:  ${CONFIG.githubUrl}?server=${encodeURIComponent(CONFIG.servidorPublico)}`);
  lanIPs().forEach(ip => console.log(`  2) App del celular:      http://${ip}:${PORT}/app`));
  console.log(CBC.enabled
    ? `  Torre (Cell Broadcast): ${towerUrl()}\n                          modo "${CBC.mode}" · siguiente message_id ${cbcSeq == null ? CBC.firstId : cbcSeq + 1}\n`
    : '  Torre (Cell Broadcast): desactivada (CBC_ENABLED=0)\n');
  console.log(`  Antiabuso: ${ANTI.rateMax} reportes/${ANTI.rateMin} min · duplicados <${ANTI.dupM} m y <${ANTI.dupMin} min · caducidad ${ANTI.expireMin} min · bloqueo tras ${ANTI.blockAfter} falsos\n`);
});