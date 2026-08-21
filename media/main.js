const vscode = acquireVsCodeApi();

let state = { devices: [], emulators: [], projects: [], sessions: [], builds: [], roots: [], busy: false, favorites: [], recording: [] };
let selectedProject = null;   // dir de la app elegida en la barra izquierda
let deviceTab = 'active';     // 'active' | 'fav' | 'inactive'
let draggingProject = null;   // dir de la app que se esta arrastrando
let activeLogTab = null;
let appFilter = '';
let logFilter = '';
const logsByKey = new Map();

const $ = (id) => document.getElementById(id);

// ─────────────────────────────────────────── helpers

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function button(label, cls, onClick, disabled) {
  const b = el('button', cls, label);
  b.disabled = !!disabled;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

let toastTimer = null;
function toast(message, isError) {
  const t = $('toast');
  t.textContent = message;
  t.className = 'toast show' + (isError ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.className = 'toast'; }, isError ? 9000 : 4000);
}

function appIcon(p, running) {
  if (p && p.iconUri) {
    const img = el('img', 'appicon' + (running ? ' on' : ''));
    img.src = p.iconUri;
    img.alt = '';
    // Un icono roto no debe dejar un hueco: caemos al cuadrito.
    img.addEventListener('error', () => img.replaceWith(el('span', 'sq' + (running ? ' on' : ''))));
    return img;
  }
  return el('span', 'sq' + (running ? ' on' : ''));
}

function projectByDir(dir) {
  return state.projects.find((p) => p.dir === dir) || null;
}

function shortName(name) {
  return name.length > 18 ? name.slice(0, 17) + '…' : name;
}

function statusLabel(s) {
  return {
    starting: 'arrancando…',
    running: 'corriendo',
    reloading: 'hot reload…',
    restarting: 'restart…',
    stopping: 'deteniendo…',
  }[s] || s;
}

function project() {
  return state.projects.find((p) => p.dir === selectedProject) || null;
}

function buildOn(dir) {
  return (state.builds || []).find((b) => b.projectDir === dir);
}

// Las compilaciones comparten el panel de logs con las apps corriendo.
function logStreams() {
  return [
    ...state.sessions.map((s) => ({ key: s.key, label: `${s.projectName} · ${shortName(s.deviceName)}` })),
    ...(state.builds || []).map((b) => ({ key: b.key, label: `${b.projectName} · ${b.targetLabel}`, build: true })),
  ];
}

function sessionOn(deviceId) {
  return state.sessions.find((s) => s.deviceId === deviceId && s.projectDir === selectedProject);
}

function offlineEmulators() {
  // emulatorId lo da el propio daemon: mas fiable que comparar nombres.
  return state.emulators.filter(
    (e) => !state.devices.some(
      (d) => d.emulator && (d.id === e.id || d.emulatorId === e.id || d.name === e.name)
    )
  );
}

// Un emulador tiene dos identidades: la del AVD/simulador apagado y la que le
// da el daemon al arrancar. Guardamos la del AVD para que el favorito no se
// pierda entre arranques.
function favKey(x) {
  return x.emulatorId || x.id;
}

function isFav(x) {
  const favs = state.favorites || [];
  return favs.includes(x.id) || (!!x.emulatorId && favs.includes(x.emulatorId));
}

function favDevices() {
  return state.devices.filter(isFav);
}

function favEmulators() {
  return offlineEmulators().filter(isFav);
}

function favButton(x) {
  const on = isFav(x);
  const b = button(on ? '\u2605' : '\u2606', 'btn ghost icon fav' + (on ? ' on' : ''), () =>
    vscode.postMessage({ type: 'toggleFavorite', id: favKey(x) }));
  b.title = on ? 'Quitar de favoritos' : 'Marcar como favorito';
  return b;
}

function send(type, key) {
  vscode.postMessage({ type, key });
}

// ─────────────────────────────────────────── render

function render() {
  renderSummary();
  renderProjects();
  renderDeviceTabs();
  renderDevices();
  renderLogTabs();
}

function renderSummary() {
  const running = state.sessions.length;
  const parts = [`${state.devices.length} activos`, `${state.projects.length} apps`];
  if (running) parts.push(`${running} corriendo`);
  if (state.busy) parts.push('buscando…');
  $('summary').textContent = parts.join(' · ');
  $('refresh').disabled = state.busy;
}

// ── columna izquierda: apps

function renderProjects() {
  const box = $('projects');
  box.textContent = '';

  if (!state.projects.length) {
    if (!state.roots || !state.roots.length) {
      box.appendChild(el('div', 'empty',
        'No hay ninguna carpeta abierta en esta ventana, asi que no hay donde buscar apps.'));
      box.appendChild(button('Abrir carpeta…', 'btn', () => vscode.postMessage({ type: 'openFolder' })));
      return;
    }
    const box2 = el('div', 'empty');
    box2.appendChild(el('div', null, 'No se encontraron apps Flutter (pubspec.yaml + lib/main.dart) en:'));
    for (const r of state.roots) box2.appendChild(el('div', 'path', r));
    box.appendChild(box2);
    return;
  }

  if (selectedProject && !state.projects.some((p) => p.dir === selectedProject)) selectedProject = null;
  if (!selectedProject) selectedProject = state.projects[0].dir;

  const needle = appFilter.trim().toLowerCase();
  const shown = needle
    ? state.projects.filter((p) => (p.name + ' ' + p.rel).toLowerCase().includes(needle))
    : state.projects;

  if (!shown.length) {
    box.appendChild(el('div', 'empty', `Ninguna app coincide con "${appFilter}".`));
    return;
  }

  for (const p of shown) {
    const mine = state.sessions.filter((s) => s.projectDir === p.dir);
    const row = el('div', 'appitem' + (p.dir === selectedProject ? ' sel' : ''));
    row.tabIndex = 0;
    row.setAttribute('role', 'button');
    row.draggable = true;
    row.appendChild(appIcon(p, mine.length > 0));

    const bld = buildOn(p.dir);
    const body = el('span', 'body');
    body.appendChild(el('span', 'title', p.name));
    const sub = bld
      ? `${bld.targetLabel}…`
      : mine.length
        ? `${mine.length} corriendo${p.profile ? ` · ${p.profile}` : ''}`
        : p.profile || p.rel;
    body.appendChild(el('span', 'sub', sub));
    row.appendChild(body);

    const build = button(bld ? '■' : '\u2692', 'btn ghost icon buildbtn' + (bld ? ' on' : ''), () => {
      if (bld) vscode.postMessage({ type: 'cancelBuild', key: bld.key });
      else vscode.postMessage({ type: 'build', dir: p.dir });
    });
    build.title = bld ? 'Cancelar la tarea en curso' : 'Acciones: correr, compilar, mantenimiento…';
    row.appendChild(build);

    row.addEventListener('click', () => {
      selectedProject = p.dir;
      render();
    });
    row.addEventListener('dblclick', () => vscode.postMessage({ type: 'openProject', dir: p.dir }));
    row.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        selectedProject = p.dir;
        render();
      }
    });

    row.addEventListener('dragstart', (e) => {
      draggingProject = p.dir;
      // Seleccionamos al arrastrar: si sueltas fuera, el estado sigue siendo coherente.
      selectedProject = p.dir;
      e.dataTransfer.effectAllowed = 'copy';
      e.dataTransfer.setData('text/plain', p.name);
      row.classList.add('dragging');
      document.body.classList.add('dragmode');
      // Favoritos tambien acepta drops; solo salimos de "Inactivos".
      if (deviceTab === 'inactive') {
        deviceTab = 'active';
        renderDeviceTabs();
      }
      renderDevices();
    });
    row.addEventListener('dragend', () => {
      draggingProject = null;
      row.classList.remove('dragging');
      document.body.classList.remove('dragmode');
      render();
    });

    box.appendChild(row);
  }
}

// ── panel derecho: tabs de dispositivos

function renderDeviceTabs() {
  const box = $('devTabs');
  box.textContent = '';

  const tabs = [
    ['active', `Dispositivos activos (${state.devices.length})`],
    ['fav', `Favoritos (${favDevices().length + favEmulators().length})`],
    ['inactive', `Inactivos (${offlineEmulators().length})`],
  ];

  for (const [id, label] of tabs) {
    const t = el('button', 'tab' + (deviceTab === id ? ' active' : ''), label);
    t.addEventListener('click', () => {
      deviceTab = id;
      renderDeviceTabs();
      renderDevices();
    });
    box.appendChild(t);
  }

  box.appendChild(el('span', 'tab-spacer'));
  if (state.projects.length && state.devices.length) {
    box.appendChild(el('span', 'hint', 'Arrastra una app a un dispositivo'));
  }
  const wifi = button('WiFi…', 'tab', () => vscode.postMessage({ type: 'wifiConnect' }));
  wifi.title = 'Conectar un dispositivo Android por red (adb connect)';
  box.appendChild(wifi);
}

function renderDevices() {
  const box = $('devices');
  box.textContent = '';

  if (deviceTab === 'fav') {
    // Los fisicos solo existen aqui mientras esten conectados; los emuladores
    // apagados si se listan, para arrancarlos de un click.
    const groups = [
      ['Conectados', favDevices(), activeCard],
      ['Sin arrancar', favEmulators(), inactiveCard],
    ];
    if (!groups.some(([, list]) => list.length)) {
      box.appendChild(el('div', 'empty',
        (state.favorites || []).length
          ? 'Ningun favorito conectado ahora mismo.'
          : 'Marca dispositivos con \u2606 para tenerlos a la mano aqui.'));
      return;
    }
    for (const [title, list, card] of groups) {
      if (!list.length) continue;
      const head = el('div', 'groupheader');
      head.appendChild(el('span', null, title));
      head.appendChild(el('span', 'groupcount', String(list.length)));
      box.appendChild(head);
      for (const x of list) box.appendChild(card(x));
    }
    return;
  }

  if (deviceTab === 'inactive') {
    const off = offlineEmulators();
    if (!off.length) {
      box.appendChild(el('div', 'empty',
        state.emulators.length ? 'Todos los emuladores ya estan corriendo.' : 'Sin emuladores configurados en este equipo.'));
      return;
    }
    const byGroup = new Map();
    for (const e of off) {
      const g = e.group || 'Otros';
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(e);
    }

    // Android primero; los runtimes de iOS de mas nuevo a mas viejo.
    const names = [...byGroup.keys()].sort((a, b) => {
      if (a === 'Android') return -1;
      if (b === 'Android') return 1;
      return b.localeCompare(a, undefined, { numeric: true });
    });

    for (const g of names) {
      const list = byGroup.get(g);
      const head = el('div', 'groupheader');
      head.appendChild(el('span', null, g));
      head.appendChild(el('span', 'groupcount', String(list.length)));
      box.appendChild(head);
      for (const e of list) box.appendChild(inactiveCard(e));
    }
    return;
  }

  if (!state.devices.length) {
    box.appendChild(el('div', 'empty',
      state.busy
        ? 'Buscando dispositivos…'
        : 'Ningun dispositivo conectado. Arranca un emulador desde la pestaña "Inactivos" o conecta un telefono por USB.'));
    return;
  }

  const groups = [
    ['Fisicos', state.devices.filter((d) => !d.emulator && d.category === 'mobile')],
    ['Emuladores y simuladores', state.devices.filter((d) => d.emulator)],
    ['Escritorio y web', state.devices.filter((d) => !d.emulator && d.category !== 'mobile')],
  ];

  for (const [title, list] of groups) {
    if (!list.length) continue;
    const head = el('div', 'groupheader');
    head.appendChild(el('span', null, title));
    head.appendChild(el('span', 'groupcount', String(list.length)));
    box.appendChild(head);
    for (const d of list) box.appendChild(activeCard(d));
  }
}

function activeCard(d) {
  const mine = state.sessions.filter((x) => x.deviceId === d.id);
  const here = mine.find((x) => x.projectDir === selectedProject);
  const p = project();

  const card = el('div', 'dev' + (mine.length ? ' live' : ''));

  const head = el('div', 'devhead');
  head.appendChild(el('span', 'sq' + (mine.length ? ' on' : '')));

  const headRight = el('div', 'headright');
  if (mine.length) {
    headRight.appendChild(el('span', 'pill on', `${mine.length} app${mine.length === 1 ? '' : 's'}`));
  }
  headRight.appendChild(favButton(d));
  if ((state.recording || []).includes(d.id)) {
    headRight.appendChild(el('span', 'pill rec', 'REC'));
  }
  const fix = button('⋯', 'btn ghost icon', () =>
    vscode.postMessage({ type: 'deviceMenu', deviceId: d.id }));
  fix.title = 'Captura, video, instalar APK, ADB por WiFi y reparaciones';
  headRight.appendChild(fix);
  head.appendChild(headRight);
  card.appendChild(head);

  card.appendChild(el('div', 'devname', d.name));
  card.appendChild(el('div', 'devsub', [d.platform, d.sdk].filter(Boolean).join(' · ')));

  const st = el('div', 'devstate');
  st.appendChild(el('span', 'dot' + (d.supported ? '' : ' off')));
  st.appendChild(el('span', null, d.supported ? 'ACTIVO' : 'NO SOPORTADO'));
  card.appendChild(st);

  // Todo lo que corre aqui, sea o no la app seleccionada: cambiar de app en la
  // barra lateral no debe esconder lo que ya esta corriendo en el dispositivo.
  if (mine.length) {
    const list = el('div', 'runlist');
    for (const s of mine) list.appendChild(sessionRow(s));
    card.appendChild(list);
  }

  if (!here) {
    const actions = el('div', 'devactions');
    actions.appendChild(button(
      p ? `▶ Correr ${shortName(p.name)}` : 'Elige una app',
      'btn',
      () => vscode.postMessage({ type: 'run', dir: selectedProject, deviceId: d.id }),
      !p || !d.supported
    ));
    card.appendChild(actions);

    if (p && d.supported) {
      card.classList.add('click');
      card.addEventListener('click', () =>
        vscode.postMessage({ type: 'run', dir: selectedProject, deviceId: d.id }));
    }
  }

  if (d.supported) {
    card.classList.add('target');
    card.addEventListener('dragover', (e) => {
      if (!draggingProject) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      card.classList.add('drop');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drop'));
    card.addEventListener('drop', (e) => {
      e.preventDefault();
      card.classList.remove('drop');
      if (!draggingProject) return;
      vscode.postMessage({ type: 'run', dir: draggingProject, deviceId: d.id });
      draggingProject = null;
      document.body.classList.remove('dragmode');
    });
  }

  return card;
}

function sessionRow(s) {
  const row = el('div', 'runrow' + (s.projectDir === selectedProject ? ' sel' : ''));

  row.appendChild(appIcon(projectByDir(s.projectDir), true));

  const info = el('div', 'runinfo');
  info.appendChild(el('span', 'runname', s.projectName));
  info.appendChild(el('span', 'runstate', statusLabel(s.status)));
  row.appendChild(info);

  const live = s.status === 'running';
  const acts = el('div', 'runacts');
  const dev = button('◈', 'btn ghost icon', () => vscode.postMessage({ type: 'devtools', key: s.key }), !s.devtools);
  dev.title = s.devtools ? 'Abrir DevTools' : 'DevTools: esperando la URI del depurador';
  acts.appendChild(dev);
  acts.appendChild(button('⚡', 'btn ghost icon', () => send('reload', s.key), !live));
  acts.appendChild(button('⟳', 'btn ghost icon', () => send('restart', s.key), !live));
  acts.appendChild(button('■', 'btn danger icon', () => send('stop', s.key)));
  row.appendChild(acts);

  // Ver los logs de esa instancia sin buscarla en las pestañas de abajo.
  row.addEventListener('click', (e) => {
    e.stopPropagation();
    activeLogTab = s.key;
    renderLogTabs();
  });

  return row;
}

function inactiveCard(e) {
  const card = el('div', 'dev off');

  const head = el('div', 'devhead');
  head.appendChild(el('span', 'sq'));
  const headRight = el('div', 'headright');
  headRight.appendChild(favButton(e));
  head.appendChild(headRight);
  card.appendChild(head);

  card.appendChild(el('div', 'devname', e.name));
  card.appendChild(el('div', 'devsub', e.platform || 'emulador'));

  const st = el('div', 'devstate');
  st.appendChild(el('span', 'dot off'));
  st.appendChild(el('span', null, 'INACTIVO'));
  card.appendChild(st);

  const actions = el('div', 'devactions');
  actions.appendChild(button('Arrancar', 'btn ghost', () =>
    vscode.postMessage({ type: 'launchEmulator', id: e.id })));

  if (e.platform === 'android') {
    const cold = button('En frio', 'btn ghost', () =>
      vscode.postMessage({ type: 'launchEmulator', id: e.id, cold: true }));
    cold.title = 'Arranca descartando el snapshot (emulator -no-snapshot-load)';
    actions.appendChild(cold);
  }
  card.appendChild(actions);

  return card;
}

// ─────────────────────────────────────────── logs

function renderLogTabs() {
  const box = $('tabs');
  box.textContent = '';

  const streams = logStreams();
  const keys = streams.map((s) => s.key);
  for (const k of [...logsByKey.keys()]) {
    if (!keys.includes(k)) logsByKey.delete(k);
  }

  if (!streams.length) {
    activeLogTab = null;
    $('log').textContent = '';
    box.appendChild(el('span', 'empty', 'Los logs de las apps que corras aparecen aqui.'));
    return;
  }

  if (!activeLogTab || !keys.includes(activeLogTab)) activeLogTab = keys[0];

  for (const s of streams) {
    const t = el('button', 'tab' + (s.key === activeLogTab ? ' active' : '') + (s.build ? ' build' : ''), s.label);
    t.addEventListener('click', () => {
      activeLogTab = s.key;
      renderLogTabs();
      paintLog();
    });
    box.appendChild(t);
  }

  box.appendChild(el('span', 'tab-spacer'));

  const find = el('input', 'filter logfilter');
  find.type = 'text';
  find.placeholder = 'Filtrar…';
  find.value = logFilter;
  find.setAttribute('aria-label', 'Filtrar el log');
  find.addEventListener('input', () => {
    logFilter = find.value;
    paintLog();
  });
  box.appendChild(find);

  box.appendChild(button('Guardar', 'tab', () => {
    const lines = (logsByKey.get(activeLogTab) || []).map((l) => l.text);
    const tab = streams.find((x) => x.key === activeLogTab);
    vscode.postMessage({
      type: 'saveLog',
      name: (tab ? tab.label : 'log').replace(/\W+/g, '-'),
      text: lines.join('\n'),
    });
  }));

  box.appendChild(button('Limpiar', 'tab', () => {
    if (activeLogTab) vscode.postMessage({ type: 'clearLogs', key: activeLogTab });
  }));

  paintLog();
}

function matchesFilter(line) {
  if (!logFilter) return true;
  return line.text.toLowerCase().includes(logFilter.toLowerCase());
}

function paintLog() {
  const pre = $('log');
  pre.textContent = '';
  for (const line of logsByKey.get(activeLogTab) || []) {
    if (matchesFilter(line)) pre.appendChild(lineNode(line));
  }
  pre.scrollTop = pre.scrollHeight;
}

function lineNode(line) {
  return el('span', line.level, line.text + '\n');
}

function appendLog(key, line) {
  if (!logsByKey.has(key)) logsByKey.set(key, []);
  const arr = logsByKey.get(key);
  arr.push(line);
  if (arr.length > 1500) arr.splice(0, arr.length - 1500);

  if (key !== activeLogTab || !matchesFilter(line)) return;
  const pre = $('log');
  const atBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 40;
  pre.appendChild(lineNode(line));
  if (atBottom) pre.scrollTop = pre.scrollHeight;
}

// ─────────────────────────────────────────── mensajes

window.addEventListener('message', (event) => {
  const msg = event.data;
  switch (msg.type) {
    case 'state':
      state = msg;
      render();
      break;
    case 'log':
      appendLog(msg.key, msg.line);
      break;
    case 'logs':
      logsByKey.set(msg.key, msg.lines.slice());
      if (msg.key === activeLogTab) paintLog();
      break;
    case 'toast':
      toast(msg.message, false);
      break;
    case 'error':
      toast(msg.message, true);
      break;
  }
});

// ─────────────────────────────────────────── divisores arrastrables

const LIMITS = {
  sidebar: { min: 150, max: 480 },
  logs: { min: 60 },
};

function applyLayout(l) {
  const root = document.documentElement;
  if (l.sidebar) root.style.setProperty('--sidebar-w', l.sidebar + 'px');
  if (l.logs) root.style.setProperty('--logs-h', l.logs + 'px');
}

function saveLayout(patch) {
  const prev = vscode.getState() || {};
  const next = { ...prev, ...patch };
  vscode.setState(next);
  applyLayout(next);
}

function makeSplitter(node, axis) {
  node.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    node.setPointerCapture(e.pointerId);
    node.classList.add('dragging');
    document.body.classList.add(axis === 'x' ? 'resizing-x' : 'resizing-y');

    const move = (ev) => {
      if (axis === 'x') {
        const w = Math.min(LIMITS.sidebar.max, Math.max(LIMITS.sidebar.min, ev.clientX));
        saveLayout({ sidebar: Math.round(w) });
      } else {
        // El alto se mide desde abajo: el divisor sube, los logs crecen.
        const h = window.innerHeight - ev.clientY;
        const max = Math.round(window.innerHeight * 0.8);
        saveLayout({ logs: Math.round(Math.min(max, Math.max(LIMITS.logs.min, h))) });
      }
    };

    const up = () => {
      node.classList.remove('dragging');
      document.body.classList.remove('resizing-x', 'resizing-y');
      node.removeEventListener('pointermove', move);
      node.removeEventListener('pointerup', up);
    };

    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', up);
  });

  // Doble click devuelve el tamaño por defecto.
  node.addEventListener('dblclick', () => {
    const root = document.documentElement;
    if (axis === 'x') {
      root.style.removeProperty('--sidebar-w');
      saveLayout({ sidebar: null });
    } else {
      root.style.removeProperty('--logs-h');
      saveLayout({ logs: null });
    }
  });
}

makeSplitter($('vsplit'), 'x');
makeSplitter($('hsplit'), 'y');
applyLayout(vscode.getState() || {});

$('appfilter').addEventListener('input', (e) => {
  appFilter = e.target.value;
  renderProjects();
});

$('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));
$('settings').addEventListener('click', () => vscode.postMessage({ type: 'openSettings' }));

vscode.postMessage({ type: 'ready' });
