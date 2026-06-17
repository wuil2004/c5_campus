const CAMARAS = {
  'PASILLO': 'http://192.168.2.161:8080', // IP de la cámara del pasillo
  'Cancha':  'http://192.168.2.192:8080', // IP de la cámara de la cancha
  'default': 'http://192.168.2.192:8080'  // Cámara de respaldo
};
function getCamURL(id) { return CAMARAS[id] || CAMARAS['default']; }

const WS_URL  = 'ws://localhost:3004';
const API_URL = 'http://localhost:3005';

const KEYWORDS_DANGER  = ['ayuda','auxilio','socorro','robo','disparo','disparos','fuego','incendio','secuestro','violencia','navaja','cuchillo','pistola','arma','sangre','herido','herida','golpe','acoso','amenaza','ladrón'];
const KEYWORDS_NEUTRAL = ['emergencia','alerta','accidente','policía','ambulancia','bomberos','guardia','seguridad'];

const pinesMapa    = {};
let alertaEnModal  = null;
let tarjetaEnModal = null;
const colaAlertas  = [];
let modalOcupado   = false;
const transcsPend  = {};
let tabActual      = 'live';
let filtros        = { priority: '', status: '' };
let liveCount      = 0;

// ── Tabs ──────────────────────────────────────────────
function cambiarTab(tab) {
  tabActual = tab;
  document.getElementById('tab-live').classList.toggle('active', tab === 'live');
  document.getElementById('tab-history').classList.toggle('active', tab === 'history');
  document.getElementById('filter-panel').classList.toggle('visible', tab === 'history');
  document.getElementById('alerts-list').innerHTML = '';
  if (tab === 'live') {
    document.getElementById('filter-result-info').classList.remove('visible');
    cargarHistorial();
  } else {
    aplicarFiltros();
  }
}

// ── Chips — autoaplicar al seleccionar ───────────────
function setChip(el, group, value) {
  el.closest('.chips').querySelectorAll('.chip').forEach(c => c.classList.remove('active-chip'));
  el.classList.add('active-chip');
  filtros[group] = value;
  aplicarFiltros();
}

// ── Filtros automáticos ───────────────────────────────
async function aplicarFiltros() {
  const day      = document.getElementById('f-day').value;
  const month    = document.getElementById('f-month').value;
  const device   = document.getElementById('f-device').value; 
  const priority = filtros.priority;
  const status   = filtros.status;

  const params = new URLSearchParams({ limit: 50 });
  const year   = new Date().getFullYear();

  if (month && day) {
    const fecha = `${year}-${month}-${day}`;
    params.append('from', `${fecha}T00:00:00`);
    params.append('to',   `${fecha}T23:59:59`);
  } else if (month && !day) {
    const lastDay = new Date(year, parseInt(month), 0).getDate();
    params.append('from', `${year}-${month}-01T00:00:00`);
    params.append('to',   `${year}-${month}-${String(lastDay).padStart(2,'0')}T23:59:59`);
  }

  if (device)   params.append('device_id', device); 
  if (priority) params.append('priority', priority);
  if (status)   params.append('status', status);

  const lista = document.getElementById('alerts-list');
  lista.innerHTML = '<div class="spinner-msg">⏳ Buscando...</div>';

  try {
    const resp  = await fetch(`${API_URL}/alerts?${params}`);
    const datos = await resp.json();
    let alerts  = datos.alerts || [];

    if (day && !month) {
      alerts = alerts.filter(a =>
        String(new Date(a.timestamp).getDate()).padStart(2,'0') === day
      );
    }

    lista.innerHTML = '';

    const hayFiltro = !!(day || month || device || priority || status);
    const infoEl    = document.getElementById('filter-result-info');
    if (hayFiltro) {
      document.getElementById('filter-result-text').textContent = `${alerts.length} registro(s) encontrado(s)`;
      infoEl.classList.add('visible');
    } else {
      infoEl.classList.remove('visible');
    }

    if (!alerts.length) {
      lista.innerHTML = '<div class="spinner-msg">Sin resultados</div>';
      return;
    }
    alerts.forEach(a => renderAlert(a, 'filtrado'));
  } catch {
    lista.innerHTML = '<div class="spinner-msg" style="color:var(--critical)">Error al consultar historial</div>';
  }
}

function limpiarFiltros() {
  document.getElementById('f-day').value   = '';
  document.getElementById('f-month').value = '';
  document.getElementById('f-device').value = '';
  filtros = { priority: '', status: '' };
  document.querySelectorAll('.chip').forEach(c => c.classList.remove('active-chip'));
  document.querySelectorAll('.chips .chip:first-child').forEach(c => c.classList.add('active-chip'));
  document.getElementById('filter-result-info').classList.remove('visible');
  aplicarFiltros();
}

// ── Cola ──────────────────────────────────────────────
function actualizarBadgeCola() {
  const badge = document.getElementById('pending-badge');
  const count = document.getElementById('pending-count');
  colaAlertas.length > 0
    ? (count.textContent = colaAlertas.length, badge.classList.add('visible'))
    : badge.classList.remove('visible');
  const indicator = document.getElementById('modal-queue-indicator');
  colaAlertas.length > 0
    ? (indicator.textContent = `+${colaAlertas.length} en espera`, indicator.classList.add('visible'))
    : indicator.classList.remove('visible');
}

function procesarSiguienteEnCola() {
  if (!colaAlertas.length || modalOcupado) return;
  const sig = colaAlertas.shift();
  sig.card.classList.remove('en-cola');
  actualizarBadgeCola();
  abrirModal(sig.alert, sig.card);
}

// ── Mapa ──────────────────────────────────────────────
const map = L.map('map').setView([19.9127, -99.5786], 17);
const capaHibrida = L.tileLayer('http://{s}.google.com/vt/lyrs=y&x={x}&y={y}&z={z}', {
  maxZoom: 20, subdomains: ['mt0','mt1','mt2','mt3']
});
capaHibrida.addTo(map);
L.control.layers({
  "Satélite híbrido": capaHibrida,
  "Satélite": L.tileLayer('http://{s}.google.com/vt/lyrs=s&x={x}&y={y}&z={z}', { maxZoom: 20, subdomains: ['mt0','mt1','mt2','mt3'] }),
  "Calles":   L.tileLayer('http://{s}.google.com/vt/lyrs=m&x={x}&y={y}&z={z}', { maxZoom: 20, subdomains: ['mt0','mt1','mt2','mt3'] }),
  "Oscuro":   L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', { maxZoom: 20 })
}).addTo(map);

function makeIcon(color, glow) {
  const shadow = glow ? `box-shadow:0 0 14px ${color};` : '';
  return L.divIcon({
    className: '',
    html: `<div class="map-totem-icon" style="background:${color};${shadow}">📍</div>`,
    iconSize: [28, 28], iconAnchor: [14, 14]
  });
}
const icons = {
  critical: makeIcon('#FF3B3B', true),
  high:     makeIcon('#FF8C00', false),
  medium:   makeIcon('#F5C518', false),
  ok:       makeIcon('#1AD68A', false),
};

// ── Transcripción ─────────────────────────────────────
function resaltarKeywords(texto) {
  let r = texto;
  KEYWORDS_DANGER .forEach(w => r = r.replace(new RegExp(`\\b${w}\\b`,'gi'), `<span class="kw-danger">${w}</span>`));
  KEYWORDS_NEUTRAL.forEach(w => r = r.replace(new RegExp(`\\b${w}\\b`,'gi'), `<span class="kw-neutral">${w}</span>`));
  return r;
}

function mostrarTranscripcion(data) {
  if (data.alert_id) transcsPend[data.alert_id] = data;
  if (!alertaEnModal) return;
  if (data.alert_id && alertaEnModal.alert_id && data.alert_id !== alertaEnModal.alert_id) return;
  _renderTrans(data);
  if (data.alert_id) delete transcsPend[data.alert_id];
}

function _renderTrans(data) {
  document.getElementById('trans-dot').className = 'trans-dot done';
  document.getElementById('trans-status').textContent = `Transcrito — ${new Date(data.timestamp).toLocaleTimeString('es-MX')}`;
  const el = document.getElementById('trans-text');
  el.className = '';
  el.innerHTML = resaltarKeywords(data.text);
  const peligro = KEYWORDS_DANGER.some(w => data.text.toLowerCase().includes(w));
  document.getElementById('kw-alert').classList.toggle('visible', peligro);
}

function resetTrans() {
  document.getElementById('trans-dot').className = 'trans-dot listening';
  document.getElementById('trans-status').textContent = 'Capturando audio...';
  const el = document.getElementById('trans-text');
  el.className = 'empty';
  el.textContent = 'El sistema está capturando y analizando el audio del lugar...';
  document.getElementById('kw-alert').classList.remove('visible');
}

function noDisponibleTrans() {
  document.getElementById('trans-dot').className = 'trans-dot';
  document.getElementById('trans-status').textContent = 'No disponible';
  const el = document.getElementById('trans-text');
  el.className = 'empty';
  el.textContent = 'Transcripción no disponible para este incidente.';
  document.getElementById('kw-alert').classList.remove('visible');
}

// ── Modal ─────────────────────────────────────────────
function colorPriority(p) {
  if (p === 'critical') return 'var(--critical)';
  if (p === 'high')     return 'var(--high)';
  if (p === 'medium')   return 'var(--medium)';
  return 'var(--text-dim)';
}

function labelPriority(p) {
  if (p === 'critical') return '🔴 CRÍTICO';
  if (p === 'high')     return '🟠 ALTO';
  if (p === 'medium')   return '🟡 MEDIO';
  return p?.toUpperCase() || '—';
}

function abrirModal(alert, card) {
  modalOcupado   = true;
  alertaEnModal  = alert;
  tarjetaEnModal = card || null;

  const color = colorPriority(alert.priority);
  document.getElementById('modal-dot').style.background = color;
  document.getElementById('modal-dot').style.boxShadow  = `0 0 8px ${color}`;
  document.getElementById('modal-title').textContent =
    (alert.emergency_type || 'Emergencia').replace(/_/g,' ').toUpperCase();

  document.getElementById('mi-device').textContent   = alert.device_id || '—';
  document.getElementById('mi-type').textContent     = (alert.emergency_type||'—').replace(/_/g,' ').toUpperCase();
  document.getElementById('mi-priority').textContent = labelPriority(alert.priority);
  document.getElementById('mi-zone').textContent     = alert.location_name
    ? `${alert.location_name} · ${alert.zone || ''}`
    : (alert.zone || `${parseFloat(alert.latitude).toFixed(5)}, ${parseFloat(alert.longitude).toFixed(5)}`);
  document.getElementById('mi-time').textContent     = new Date(alert.timestamp).toLocaleTimeString('es-MX');
 document.getElementById('mi-guard').textContent    = `Punto de alerta: ${alert.location_name || alert.device_id}`;

  const yaResuelta = alert.status === 'confirmed' || alert.status === 'false_alarm';
  const resultDiv  = document.getElementById('modal-result');
  const btns       = document.getElementById('modal-btns');

  if (yaResuelta) {
    btns.style.display    = 'none';
    resultDiv.style.display = 'block';
    resultDiv.className   = alert.status === 'confirmed' ? 'confirmed' : 'false-alarm';
    resultDiv.textContent = alert.status === 'confirmed' ? '✅ Emergencia ya confirmada' : '❌ Ya marcada como falsa alarma';
  } else {
    resultDiv.className = ''; resultDiv.textContent = ''; resultDiv.style.display = 'none';
    document.getElementById('btn-confirm').disabled = false;
    document.getElementById('btn-discard').disabled = false;
    btns.style.display = 'grid';
  }

  const camURL  = getCamURL(alert.device_id);
  const liveImg = document.getElementById('cam-live');
  liveImg.style.display = 'block';
  document.getElementById('cam-live-err').style.display = 'none';
  liveImg.src = `${camURL}/video?t=${Date.now()}`;

  const snapImg   = document.getElementById('snapshot-img');
  const snapBadge = document.getElementById('snap-saved-badge');
  snapImg.style.display = 'block';
  document.getElementById('snap-err').style.display = 'none';

  if (alert.snapshot_url) {
    snapImg.src = alert.snapshot_url;
    snapBadge.classList.add('visible');
  } else {
    snapImg.src = `${camURL}/shot.jpg?t=${Date.now()}`;
    snapBadge.classList.remove('visible');
    if (alert.alert_id) {
      setTimeout(async () => {
        try {
          const r = await fetch(`${API_URL}/alerts/${alert.alert_id}`);
          const d = await r.json();
          if (d.snapshot_url && alertaEnModal?.alert_id === alert.alert_id) {
            snapImg.src = d.snapshot_url;
            snapBadge.classList.add('visible');
            alert.snapshot_url = d.snapshot_url;
          }
        } catch {}
      }, 4000);
    }
  }

  const trans = transcsPend[alert.alert_id];
  if (trans)                    { _renderTrans(trans); delete transcsPend[alert.alert_id]; }
  else if (alert.transcription) { _renderTrans({ alert_id: alert.alert_id, text: alert.transcription, timestamp: alert.timestamp }); }
  else if (alert.snapshot_url)  { noDisponibleTrans(); }
  else                          { resetTrans(); }

  if (alert.alert_id && !yaResuelta) {
    fetch(`${API_URL}/alerts/${alert.alert_id}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: 'reviewing', device_id: alert.device_id })
    }).catch(() => {});
  }

  actualizarBadgeCola();
  document.getElementById('modal-overlay').classList.add('active');
}

function cerrarModal() {
  document.getElementById('cam-live').src = '';
  document.getElementById('modal-overlay').classList.remove('active');
  alertaEnModal = null; tarjetaEnModal = null; modalOcupado = false;
  setTimeout(procesarSiguienteEnCola, 400);
}

async function verificarAlerta(decision) {
  if (!alertaEnModal) return;
  const alertId = alertaEnModal.alert_id;
  document.getElementById('btn-confirm').disabled = true;
  document.getElementById('btn-discard').disabled = true;

  try {
    if (alertId) await fetch(`${API_URL}/alerts/${alertId}/status`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: decision, device_id: alertaEnModal.device_id })
    });
  } catch {}

  alertaEnModal.status = decision;

  const resultDiv = document.getElementById('modal-result');
  resultDiv.style.display = 'block';
  if (decision === 'confirmed') {
    resultDiv.className   = 'confirmed';
    resultDiv.textContent = '✅ Guardia despachado — incidente confirmado';
    if (tarjetaEnModal) liveCount = Math.max(0, liveCount - 1);
    document.getElementById('live-count').textContent = liveCount;
  } else {
    resultDiv.className   = 'false-alarm';
    resultDiv.textContent = '❌ Marcado como falsa alarma';
  }

  if (tarjetaEnModal) actualizarTarjeta(tarjetaEnModal, decision);
  setTimeout(cerrarModal, 1600);
}

function actualizarTarjeta(card, decision) {
  card.classList.remove('critical','high','medium','nueva','en-cola');
  card.classList.add(decision === 'confirmed' ? 'confirmed' : 'false-alarm');
  const badge = card.querySelector('.priority-badge');
  if (badge) {
    badge.className   = `priority-badge ${decision === 'confirmed' ? 'bg-ok' : 'bg-false'}`;
    badge.textContent = decision === 'confirmed' ? '✅ GUARDIA DESPACHADO' : '❌ FALSA ALARMA';
  }
}

document.getElementById('modal-overlay').addEventListener('click', e => {
  if (e.target.id === 'modal-overlay') cerrarModal();
});

// ── Renderizar tarjeta ────────────────────────────────
function renderAlert(alert, type) {
  const emptyEl = document.getElementById('empty-state');
  if (emptyEl) emptyEl.remove();

  const feed         = document.getElementById('alerts-list');
  const timeStr      = new Date(alert.timestamp).toLocaleTimeString('es-MX', { hour12: false });
  const dateStr      = new Date(alert.timestamp).toLocaleDateString('es-MX', { day:'2-digit', month:'short' });
  const pclass       = alert.priority === 'critical' ? 'critical' : alert.priority === 'high' ? 'high' : 'medium';
  const badgeClass   = alert.status === 'confirmed' ? 'bg-ok' : alert.status === 'false_alarm' ? 'bg-false' : `bg-${pclass}`;
  const badgeText    = alert.status === 'confirmed'  ? '✅ GUARDIA DESPACHADO'
                     : alert.status === 'false_alarm' ? '❌ FALSA ALARMA'
                     : labelPriority(alert.priority);

  let tagHtml = '';
  if (type === 'pending')                        tagHtml = '<span class="tag-extra tag-pend">RECUPERADA</span>';
  if (type === 'history' || type === 'filtrado') tagHtml = '<span class="tag-extra tag-hist">HISTORIAL</span>';

  let statusHtml = '';
  if (alert.status === 'confirmed')   statusHtml = '<span class="status-chip status-confirmed">CONF.</span>';
  if (alert.status === 'false_alarm') statusHtml = '<span class="status-chip status-false">FALSA</span>';

  const hasSnap        = alert.snapshot_url ? '📷 ' : '';
  const emergencyLabel = (alert.emergency_type || '').replace(/_/g, ' ');
  const locationLabel  = alert.location_name || alert.zone
    || `${parseFloat(alert.latitude||0).toFixed(4)}, ${parseFloat(alert.longitude||0).toFixed(4)}`;

  const card = document.createElement('div');
  card.className = `alert-card ${pclass}${type === 'realtime' ? ' nueva' : ''}`;
  if (alert.status === 'confirmed')   card.classList.add('confirmed');
  if (alert.status === 'false_alarm') card.classList.add('false-alarm');

  card.innerHTML = `
    <div class="card-top">
      <span class="card-device">${alert.device_id || 'TOTEM'}${tagHtml}${statusHtml}</span>
      <span class="card-time">${type === 'filtrado' ? dateStr + ' ' : ''}${timeStr}</span>
    </div>
    <div class="card-type">${hasSnap}${emergencyLabel}</div>
    <div class="card-location">📍 ${locationLabel}</div>
    ${alert.zone_description ? `<div class="card-zone">${alert.zone_description}</div>` : ''}
    <div class="card-footer">
      <span class="priority-badge ${badgeClass}">${badgeText}</span>
     
    </div>
  `;

  feed.prepend(card);

  if (alert.latitude && alert.longitude) {
    const icon   = icons[pclass] || icons.medium;
    const marker = L.marker([alert.latitude, alert.longitude], { icon }).addTo(map);
    marker.bindPopup(`<b>${emergencyLabel.toUpperCase()}</b><br>${locationLabel}<br>${alert.guard_post || ''}`);
    const uid = alert.alert_id || Date.now() + '' + Math.random();
    pinesMapa[uid] = marker;

    card.onclick = () => {
      map.flyTo([alert.latitude, alert.longitude], 19, { animate: true, duration: 1.2 });
      pinesMapa[uid].openPopup();
      if (!modalOcupado) abrirModal(alert, card);
    };

    if (type === 'realtime') {
      map.flyTo([alert.latitude, alert.longitude], 18, { animate: true, duration: 1 });
      marker.openPopup();
    }
  }

  if (type === 'realtime') {
    liveCount++;
    document.getElementById('live-count').textContent = liveCount;
    if (!modalOcupado) { setTimeout(() => abrirModal(alert, card), 300); }
    else               { card.classList.add('en-cola'); colaAlertas.push({ alert, card }); actualizarBadgeCola(); }
  }
}

// ── WebSocket ─────────────────────────────────────────
let ws;
function connectWS() {
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    const el = document.getElementById('ws-status');
    document.getElementById('ws-text').textContent = 'Sistema en línea';
    el.style.borderColor = 'var(--ok)';
    el.style.background  = 'var(--ok-dim)';
    el.style.color       = 'var(--ok)';
    document.getElementById('ws-dot').className = 'dot dot-ok';
  };
  ws.onmessage = (event) => {
    const payload = JSON.parse(event.data);
    if      (payload.type === 'alert')         renderAlert(payload.data, 'realtime');
    else if (payload.type === 'pending_alert')  renderAlert(payload.data, 'pending');
    else if (payload.type === 'transcription')  mostrarTranscripcion(payload.data);
  };
  ws.onclose = () => {
    const el = document.getElementById('ws-status');
    document.getElementById('ws-text').textContent = 'Reconectando...';
    el.style.borderColor = 'var(--critical)';
    el.style.background  = 'rgba(255,59,59,0.1)';
    el.style.color       = 'var(--critical)';
    document.getElementById('ws-dot').className = 'dot dot-crit';
    setTimeout(connectWS, 3000);
  };
}

// ── Historial inicial ─────────────────────────────────
async function cargarHistorial() {
  try {
    const resp  = await fetch(`${API_URL}/alerts?limit=10`);
    const datos = await resp.json();
    if (datos.alerts?.length) {
      datos.alerts.reverse().forEach(a => renderAlert(a, 'history'));
      document.getElementById('totems-count').textContent =
        [...new Set(datos.alerts.map(a => a.device_id))].length;
    }
  } catch {}
}

cargarHistorial();
connectWS();