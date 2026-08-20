const vscode = require('vscode');
const cp = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_LOG_LINES = 1500;
const SKIP_DIRS = new Set([
  'build', '.dart_tool', '.git', 'node_modules', '.symlinks',
  'ios', 'android', 'macos', 'windows', 'linux', 'web', 'Pods', '.fvm',
]);

/** key -> { key, project, device, proc, appId, status, logs, reqId } */
const sessions = new Map();

let panel = null;
let daemon = null;
let cache = { devices: [], emulators: [], projects: [], roots: [], busy: false };

const FAV_KEY = 'novasuiteRunner.favorites';
let store = null;              // globalState: los favoritos sobreviven al reinstalar
let favorites = new Set();

function activate(context) {
  store = context.globalState;
  favorites = new Set(store.get(FAV_KEY, []));
  context.subscriptions.push(
    vscode.commands.registerCommand('novasuiteRunner.open', () => openPanel(context))
  );
}

function toggleFavorite(id) {
  if (!id) return;
  if (favorites.has(id)) favorites.delete(id);
  else favorites.add(id);
  if (store) store.update(FAV_KEY, [...favorites]);
  pushState();
}

function cfg() {
  return vscode.workspace.getConfiguration('novasuiteRunner');
}

function flutterBin() {
  return cfg().get('flutterPath') || 'flutter';
}

// ─────────────────────────────────────────── panel

function openPanel(context) {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Active);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'novasuiteRunner',
    'NovaSuite Runner',
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [
        vscode.Uri.joinPath(context.extensionUri, 'media'),
        ...(vscode.workspace.workspaceFolders || []).map((f) => f.uri),
      ],
    }
  );

  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
  panel.webview.html = buildHtml(panel.webview, context.extensionUri);

  panel.webview.onDidReceiveMessage((msg) => handleMessage(msg), null, context.subscriptions);

  panel.onDidDispose(() => {
    panel = null;
    if (daemon && daemon.proc) {
      try { daemon.proc.kill('SIGTERM'); } catch {}
      daemon = null;
    }
    // Los procesos siguen vivos a proposito: cerrar el panel no mata tus apps.
  }, null, context.subscriptions);

  scanProjects();
  ensureDaemon();
}

function post(msg) {
  if (panel) panel.webview.postMessage(msg);
}

function pushState() {
  post({
    type: 'state',
    devices: cache.devices,
    emulators: cache.emulators,
    projects: cache.projects.map((p) => ({
      ...p,
      iconUri: p.icon && panel ? panel.webview.asWebviewUri(vscode.Uri.file(p.icon)).toString() : null,
    })),
    roots: cache.roots,
    busy: cache.busy,
    favorites: [...favorites],
    sessions: [...sessions.values()].map((s) => ({
      key: s.key,
      projectDir: s.project.dir,
      projectName: s.project.name,
      deviceId: s.device.id,
      deviceName: s.device.name,
      status: s.status,
    })),
  });
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'ready':
      pushState();
      for (const s of sessions.values()) {
        post({ type: 'logs', key: s.key, lines: s.logs });
      }
      break;
    case 'refresh':
      scanProjects();
      if (!ensureDaemon()) queryDaemon();
      break;
    case 'run':
      startApp(msg.dir, msg.deviceId);
      break;
    case 'stop':
      stopApp(msg.key);
      break;
    case 'reload':
      restartApp(msg.key, false);
      break;
    case 'restart':
      restartApp(msg.key, true);
      break;
    case 'launchEmulator':
      launchEmulator(msg.id, msg.cold);
      break;
    case 'toggleFavorite':
      toggleFavorite(msg.id);
      break;
    case 'repair':
      repairDevice(msg.deviceId);
      break;
    case 'clearLogs': {
      const s = sessions.get(msg.key);
      if (s) s.logs = [];
      post({ type: 'logs', key: msg.key, lines: [] });
      break;
    }
    case 'openFolder':
      vscode.commands.executeCommand('vscode.openFolder');
      break;
    case 'openSettings':
      vscode.commands.executeCommand('workbench.action.openSettings', 'novasuiteRunner');
      break;
    case 'openProject':
      vscode.commands.executeCommand(
        'revealInExplorer',
        vscode.Uri.file(path.join(msg.dir, 'lib', 'main.dart'))
      );
      break;
  }
}

// ─────────────────────────────────────────── descubrimiento

function scanProjects() {
  const folders = vscode.workspace.workspaceFolders || [];
  const found = [];

  cache.roots = folders.map((f) => f.uri.fsPath);

  for (const folder of folders) {
    walk(folder.uri.fsPath, 0, found);
  }

  found.sort((a, b) => a.name.localeCompare(b.name));
  cache.projects = found;
  pushState();
}

function walk(dir, depth, out) {
  if (depth > 4) return;

  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }

  const pubspec = entries.find((e) => e.isFile() && e.name === 'pubspec.yaml');
  if (pubspec) {
    const project = describeProject(dir);
    if (project) out.push(project);
    // Un proyecto Dart no contiene otros proyectos que nos interesen (salvo example/,
    // que no vale la pena listar en un monorepo de apps).
    return;
  }

  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name)) continue;
    walk(path.join(dir, e.name), depth + 1, out);
  }
}

function describeProject(dir) {
  // Solo apps ejecutables: un package sin entrypoint no se puede correr.
  if (!fs.existsSync(path.join(dir, 'lib', 'main.dart'))) return null;

  let raw = '';
  try {
    raw = fs.readFileSync(path.join(dir, 'pubspec.yaml'), 'utf8');
  } catch {
    return null;
  }

  if (!/^\s*flutter:\s*$/m.test(raw) && !/\bsdk:\s*flutter\b/.test(raw)) return null;

  const nameMatch = raw.match(/^name:\s*['"]?([\w.-]+)['"]?/m);
  const descMatch = raw.match(/^description:\s*['"]?(.+?)['"]?\s*$/m);
  const name = nameMatch ? nameMatch[1] : path.basename(dir);

  const root = (vscode.workspace.workspaceFolders || [])[0];
  const rel = root ? path.relative(root.uri.fsPath, dir) || '.' : dir;

  return {
    name,
    dir,
    rel,
    description: descMatch ? descMatch[1] : '',
    icon: findIcon(dir, raw),
  };
}

function findIcon(dir, pubspec) {
  const candidates = [];

  // Lo que la app declara para flutter_launcher_icons manda sobre cualquier convencion.
  const block = pubspec.match(/^flutter_(?:launcher_)?icons:\s*$([\s\S]*?)(?=^\S|\Z)/m);
  if (block) {
    for (const key of ['image_path', 'image_path_android', 'image_path_ios']) {
      const m = block[1].match(new RegExp(`^\\s+${key}:\\s*['"]?(.+?)['"]?\\s*$`, 'm'));
      if (m) candidates.push(m[1]);
    }
  }

  candidates.push(
    'assets/images/logo/logo_icon.png',
    'assets/images/logo/logo_icon_square.png',
    'assets/images/logo_icon.png',
    'assets/icon/icon.png',
    'android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png',
    'web/icons/Icon-192.png'
  );

  for (const rel of candidates) {
    const full = path.join(dir, rel);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) return full;
  }
  return null;
}

/**
 * Un unico "flutter daemon" de larga vida sustituye al sondeo: reporta
 * device.added / device.removed en cuanto ocurren, para todas las plataformas.
 * Devuelve true si tuvo que arrancarlo (y por tanto ya pedira el estado inicial).
 */
function ensureDaemon() {
  if (daemon && daemon.proc && !daemon.proc.killed) return false;

  let proc;
  try {
    proc = cp.spawn(flutterBin(), ['daemon']);
  } catch (err) {
    post({ type: 'error', message: toolError('flutter daemon', err) });
    return false;
  }

  daemon = { proc, buffer: '', reqId: 1, ready: false };
  cache.busy = true;
  pushState();

  proc.stdout.on('data', (chunk) => onDaemonChunk(chunk));
  proc.on('error', (err) => {
    post({ type: 'error', message: toolError('flutter daemon', err) });
    daemon = null;
    cache.busy = false;
    pushState();
  });
  proc.on('close', () => {
    daemon = null;
    cache.busy = false;
    // Solo lo revivimos si el panel sigue abierto; si no, que quede muerto.
    if (panel) setTimeout(() => { if (panel) ensureDaemon(); }, 3000);
  });

  return true;
}

function onDaemonChunk(chunk) {
  if (!daemon) return;
  daemon.buffer += String(chunk);
  const lines = daemon.buffer.split('\n');
  daemon.buffer = lines.pop() || '';

  for (const raw of lines) {
    const line = raw.trim();
    if (!line.startsWith('[{') || !line.endsWith('}]')) continue;
    let payload;
    try {
      payload = JSON.parse(line);
    } catch {
      continue;
    }
    for (const msg of payload) onDaemonMessage(msg);
  }
}

function onDaemonMessage(msg) {
  if (msg.event === 'daemon.connected') {
    daemon.ready = true;
    send('device.enable');
    queryDaemon();
    return;
  }

  if (msg.event === 'device.added' || msg.event === 'device.changed') {
    upsertDevice(msg.params);
    return;
  }

  if (msg.event === 'device.removed') {
    cache.devices = cache.devices.filter((d) => d.id !== msg.params.id);
    pushState();
    return;
  }

  if (msg.id !== undefined && msg.result !== undefined) {
    const kind = daemon.pending && daemon.pending[msg.id];
    if (kind === 'devices') {
      cache.devices = (msg.result || []).map(mapDevice);
    } else if (kind === 'emulators') {
      // El daemon devuelve UNA entrada generica para todo iOS ("apple_ios_simulator"),
      // asi que los simuladores reales hay que sacarlos de simctl.
      cache.emulators = (msg.result || [])
        .filter((e) => e.platformType !== 'ios')
        .map((e) => ({
          id: e.id,
          name: e.name,
          platform: e.platformType || e.category || '',
          kind: 'android',
          group: 'Android',
        }));
      loadIosSimulators();
    }
    cache.busy = false;
    pushState();
  }
}

function send(method, params) {
  if (!daemon || !daemon.proc) return null;
  const id = daemon.reqId++;
  daemon.proc.stdin.write(JSON.stringify([{ id, method, params: params || {} }]) + '\n');
  return id;
}

function queryDaemon() {
  if (!daemon) return;
  daemon.pending = daemon.pending || {};
  cache.busy = true;
  pushState();
  daemon.pending[send('device.getDevices')] = 'devices';
  daemon.pending[send('emulator.getEmulators')] = 'emulators';
}

function runtimeLabel(key) {
  // com.apple.CoreSimulator.SimRuntime.iOS-17-2  ->  iOS 17.2
  const tail = String(key).split('SimRuntime.').pop();
  const m = tail.match(/^([A-Za-z]+)-(.+)$/);
  return m ? `${m[1]} ${m[2].replace(/-/g, '.')}` : tail;
}

function loadIosSimulators() {
  if (process.platform !== 'darwin') return;

  cp.execFile(
    'xcrun',
    ['simctl', 'list', 'devices', 'available', '--json'],
    { timeout: 30000, maxBuffer: 8 * 1024 * 1024 },
    (err, stdout) => {
      if (err) return;

      let parsed;
      try {
        parsed = JSON.parse(stdout).devices || {};
      } catch {
        return;
      }

      const sims = [];
      for (const [runtime, list] of Object.entries(parsed)) {
        if (!/iOS|xrOS|watchOS|tvOS/.test(runtime)) continue;
        const group = runtimeLabel(runtime);
        for (const d of list) {
          if (d.isAvailable === false) continue;
          sims.push({ id: d.udid, name: d.name, platform: 'ios', kind: 'ios', group, state: d.state });
        }
      }

      // Los ya arrancados los reporta el daemon como dispositivos; aqui solo los apagados.
      cache.emulators = [
        ...cache.emulators.filter((e) => e.kind !== 'ios'),
        ...sims.filter((s) => s.state !== 'Booted'),
      ];
      pushState();
    }
  );
}

function mapDevice(p) {
  return {
    id: p.id,
    name: p.name,
    platform: p.platform || p.platformType || '',
    sdk: p.sdk || '',
    emulator: !!p.emulator,
    emulatorId: p.emulatorId || null,
    category: p.category || '',
    supported: p.isSupported !== false,
  };
}

function upsertDevice(params) {
  const d = mapDevice(params);
  const i = cache.devices.findIndex((x) => x.id === d.id);
  if (i >= 0) cache.devices[i] = d;
  else cache.devices.push(d);
  pushState();
}

function launchEmulator(id, cold) {
  const entry = cache.emulators.find((e) => e.id === id);

  if (entry && entry.kind === 'ios') {
    post({ type: 'toast', message: `Arrancando ${entry.name}…` });
    runSteps(
      [
        ['xcrun', ['simctl', 'boot', id]],
        // simctl boot no abre la ventana: sin esto arranca headless.
        ['open', ['-a', 'Simulator'], { ignoreError: true }],
      ],
      `Arrancando ${entry.name}`
    );
    return;
  }

  if (cold) {
    const bin = androidEmulatorBin();
    if (!bin) {
      post({ type: 'error', message: 'No se encontro el binario "emulator" del SDK de Android (revisa ANDROID_HOME).' });
      return;
    }
    post({ type: 'toast', message: `Arrancando ${id} en frio…` });
    // Se desprende a proposito: el emulator ocupa la terminal mientras vive.
    const child = cp.spawn(bin, ['-avd', id, '-no-snapshot-load'], { detached: true, stdio: 'ignore' });
    child.unref();
    setTimeout(queryDaemon, 8000);
    return;
  }

  post({ type: 'toast', message: `Arrancando ${id}…` });
  cp.execFile(flutterBin(), ['emulators', '--launch', id], { timeout: 180000 }, (err) => {
    if (err) {
      post({ type: 'error', message: toolError(`flutter emulators --launch ${id}`, err) });
      return;
    }
    post({ type: 'toast', message: `${id} arrancado.` });
    setTimeout(queryDaemon, 3000);
  });
}

async function repairDevice(deviceId) {
  const d = cache.devices.find((x) => x.id === deviceId);
  if (!d) return;

  const items = repairItems(d);
  if (!items.length) {
    vscode.window.showInformationMessage(`No hay acciones de reparacion para ${d.name}.`);
    return;
  }

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: `Reparar ${d.name}`,
    matchOnDetail: true,
  });
  if (!pick) return;

  if (pick.confirm) {
    const ok = await vscode.window.showWarningMessage(pick.confirm, { modal: true }, 'Continuar');
    if (ok !== 'Continuar') return;
  }

  if (pick.run) pick.run();
  else runSteps(pick.steps, pick.label);
}

/**
 * Reinicia un emulador Android descartando el snapshot de arranque y, si se pide,
 * borrando sus datos. El serial (emulator-5554) no sirve para relanzarlo: hay que
 * preguntarle al propio emulador como se llama su AVD.
 */
function androidResetBoot(d, wipe) {
  const bin = androidEmulatorBin();
  if (!bin) {
    post({ type: 'error', message: 'No se encontro el binario "emulator" del SDK de Android (revisa ANDROID_HOME).' });
    return;
  }

  const label = wipe ? 'Borrando datos y rearrancando' : 'Arranque en frio';
  post({ type: 'toast', message: `${label}…` });

  cp.execFile(adbBin(), ['-s', d.id, 'emu', 'avd', 'name'], { timeout: 20000 }, (err, stdout) => {
    if (err) {
      post({ type: 'error', message: toolError('adb emu avd name', err) });
      return;
    }
    const avd = String(stdout).split('\n').map((l) => l.trim()).filter((l) => l && l !== 'OK')[0];
    if (!avd) {
      post({ type: 'error', message: 'No se pudo determinar el AVD de este emulador.' });
      return;
    }

    cp.execFile(adbBin(), ['-s', d.id, 'emu', 'kill'], { timeout: 20000 }, () => {
      // El emulador tarda en soltar el puerto; relanzar de inmediato falla.
      setTimeout(() => {
        const args = ['-avd', avd, wipe ? '-wipe-data' : '-no-snapshot-load'];
        const child = cp.spawn(bin, args, { detached: true, stdio: 'ignore' });
        child.unref();
        post({ type: 'toast', message: `${avd}: ${label.toLowerCase()} en curso.` });
        setTimeout(queryDaemon, 10000);
      }, 4000);
    });
  });
}

function repairItems(d) {
  const platform = String(d.platform || '');
  const isIosSim = platform.startsWith('ios') && d.emulator;
  const isAndroid = platform.startsWith('android');

  if (isIosSim) {
    return [
      {
        label: 'Reiniciar el simulador',
        detail: `xcrun simctl shutdown ${d.id} && xcrun simctl boot ${d.id}`,
        description: 'Pantalla negra o spinner pegado',
        steps: [
          ['xcrun', ['simctl', 'shutdown', d.id], { ignoreError: true }],
          ['xcrun', ['simctl', 'boot', d.id]],
        ],
      },
      {
        label: 'Apagar el simulador',
        detail: `xcrun simctl shutdown ${d.id}`,
        steps: [['xcrun', ['simctl', 'shutdown', d.id]]],
      },
      {
        label: 'Reiniciar el servicio CoreSimulator',
        description: 'Afecta a TODOS los simuladores',
        detail: 'killall -9 com.apple.CoreSimulator.CoreSimulatorService',
        confirm: 'Esto mata el servicio de simuladores de macOS y cierra todos los simuladores abiertos. ¿Continuar?',
        steps: [
          ['killall', ['-9', 'com.apple.CoreSimulator.CoreSimulatorService'], { ignoreError: true }],
          ['xcrun', ['simctl', 'boot', d.id], { ignoreError: true }],
        ],
      },
      {
        label: 'Borrar contenido y ajustes',
        description: 'DESTRUCTIVO · borra la base de datos de las apps',
        detail: `xcrun simctl erase ${d.id}`,
        confirm: `Esto borra TODO el contenido del simulador ${d.name}, incluidas las bases de datos SQLite de tus apps. Es irreversible. ¿Continuar?`,
        steps: [
          ['xcrun', ['simctl', 'shutdown', d.id], { ignoreError: true }],
          ['xcrun', ['simctl', 'erase', d.id]],
          ['xcrun', ['simctl', 'boot', d.id]],
        ],
      },
    ];
  }

  if (isAndroid) {
    const items = [
      {
        label: 'Reiniciar el dispositivo',
        detail: `adb -s ${d.id} reboot`,
        description: 'Pantalla negra o congelada',
        steps: [[adbBin(), ['-s', d.id, 'reboot']]],
      },
      {
        label: 'Reiniciar el servidor ADB',
        description: 'Cuando el dispositivo aparece y desaparece',
        detail: 'adb kill-server && adb start-server',
        steps: [
          [adbBin(), ['kill-server'], { ignoreError: true }],
          [adbBin(), ['start-server']],
        ],
      },
    ];

    if (d.emulator) {
      items.splice(1, 0, {
        label: 'Apagar el emulador',
        detail: `adb -s ${d.id} emu kill`,
        steps: [[adbBin(), ['-s', d.id, 'emu', 'kill']]],
      });
      items.push(
        {
          label: 'Arranque en frio',
          description: 'Descarta el snapshot · para spinner o pantalla negra al arrancar',
          detail: 'adb emu kill && emulator -avd <avd> -no-snapshot-load',
          run: () => androidResetBoot(d, false),
        },
        {
          label: 'Borrar datos del dispositivo',
          description: 'DESTRUCTIVO · deja el emulador de fabrica',
          detail: 'adb emu kill && emulator -avd <avd> -wipe-data',
          confirm: `Esto borra TODO el contenido de ${d.name}: apps instaladas, cuentas y las bases de datos SQLite de tus apps. Es irreversible. ¿Continuar?`,
          run: () => androidResetBoot(d, true),
        }
      );
    }
    return items;
  }

  return [];
}

function runSteps(steps, label) {
  post({ type: 'toast', message: `${label}…` });

  const next = (i) => {
    if (i >= steps.length) {
      post({ type: 'toast', message: `${label}: listo.` });
      setTimeout(queryDaemon, 2500);
      return;
    }
    const [cmd, args, opts = {}] = steps[i];
    cp.execFile(cmd, args, { timeout: 120000 }, (err) => {
      if (err && !opts.ignoreError) {
        post({ type: 'error', message: toolError(`${cmd} ${args.join(' ')}`, err) });
        return;
      }
      next(i + 1);
    });
  };

  next(0);
}

function toolError(cmd, err) {
  if (err && err.code === 'ENOENT') {
    return `No se encontro "${flutterBin()}". Configura novasuiteRunner.flutterPath con la ruta absoluta al binario de Flutter.`;
  }
  return `${cmd} fallo: ${err && err.message ? err.message : err}`;
}

// ─────────────────────────────────────────── ejecucion

function startApp(dir, deviceId) {
  const project = cache.projects.find((p) => p.dir === dir);
  const device = cache.devices.find((d) => d.id === deviceId);
  if (!project || !device) return;

  const key = `${dir}::${deviceId}`;
  if (sessions.has(key)) {
    post({ type: 'toast', message: `${project.name} ya corre en ${device.name}.` });
    return;
  }

  const extra = cfg().get('extraRunArgs') || [];
  const args = ['run', '--machine', '-d', device.id, ...extra];

  let proc;
  try {
    proc = cp.spawn(flutterBin(), args, { cwd: dir });
  } catch (err) {
    post({ type: 'error', message: toolError('flutter run', err) });
    return;
  }

  const session = {
    key, project, device, proc,
    appId: null,
    status: 'starting',
    logs: [],
    reqId: 1,
    buffer: '',
  };
  sessions.set(key, session);
  pushState();
  addLog(session, `▶ flutter ${args.join(' ')}  (cwd: ${project.rel})`, 'meta');

  proc.stdout.on('data', (chunk) => onDaemonData(session, chunk));
  proc.stderr.on('data', (chunk) => addLog(session, String(chunk).trimEnd(), 'error'));

  proc.on('error', (err) => {
    addLog(session, toolError('flutter run', err), 'error');
    post({ type: 'error', message: toolError('flutter run', err) });
    sessions.delete(key);
    pushState();
  });

  proc.on('close', (code) => {
    addLog(session, `■ proceso terminado (codigo ${code})`, 'meta');
    sessions.delete(key);
    pushState();
  });
}

function onDaemonData(session, chunk) {
  session.buffer += String(chunk);
  const lines = session.buffer.split('\n');
  session.buffer = lines.pop() || '';

  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) continue;

    // El daemon emite JSON entre corchetes; lo demas es salida humana del arranque.
    if (line.startsWith('[{') && line.endsWith('}]')) {
      let payload;
      try {
        payload = JSON.parse(line);
      } catch {
        addLog(session, line, 'out');
        continue;
      }
      for (const msg of payload) handleDaemonEvent(session, msg);
    } else {
      addLog(session, line, 'out');
    }
  }
}

function handleDaemonEvent(session, msg) {
  if (msg.event === 'app.start') {
    session.appId = msg.params && msg.params.appId;
    session.status = 'starting';
    pushState();
  } else if (msg.event === 'app.started') {
    session.status = 'running';
    addLog(session, '✓ app iniciada', 'meta');
    pushState();
  } else if (msg.event === 'app.log') {
    const p = msg.params || {};
    addLog(session, String(p.log || '').trimEnd(), p.error ? 'error' : 'out');
  } else if (msg.event === 'app.progress') {
    const p = msg.params || {};
    if (p.message && !p.finished) addLog(session, `… ${p.message}`, 'meta');
  } else if (msg.event === 'daemon.logMessage') {
    const p = msg.params || {};
    if (p.level === 'error') addLog(session, String(p.message), 'error');
  } else if (msg.event === 'app.stop') {
    session.status = 'stopping';
    pushState();
  } else if (msg.id !== undefined && msg.error) {
    addLog(session, `✗ ${JSON.stringify(msg.error)}`, 'error');
    session.status = 'running';
    pushState();
  }
}

function sendRequest(session, method, params) {
  if (!session.appId) {
    addLog(session, '✗ la app todavia no reporta appId; espera a que arranque.', 'error');
    return;
  }
  const id = session.reqId++;
  const payload = JSON.stringify([{ id, method, params: { appId: session.appId, ...params } }]);
  session.proc.stdin.write(payload + '\n');
}

function restartApp(key, full) {
  const session = sessions.get(key);
  if (!session) return;
  session.status = full ? 'restarting' : 'reloading';
  pushState();
  addLog(session, full ? '⟳ hot restart…' : '⚡ hot reload…', 'meta');
  sendRequest(session, 'app.restart', { fullRestart: full, pause: false, reason: 'manual' });
  setTimeout(() => {
    if (sessions.get(key) === session && session.status !== 'running') {
      session.status = 'running';
      pushState();
    }
  }, 4000);
}

function stopApp(key) {
  const session = sessions.get(key);
  if (!session) return;
  session.status = 'stopping';
  pushState();
  addLog(session, '■ deteniendo…', 'meta');

  if (session.appId) sendRequest(session, 'app.stop', {});

  // Si el daemon no responde, matamos el proceso.
  setTimeout(() => {
    if (sessions.get(key) === session) {
      try { session.proc.kill('SIGTERM'); } catch {}
    }
  }, 4000);
}

function addLog(session, text, level) {
  if (!text) return;
  for (const line of String(text).split('\n')) {
    session.logs.push({ text: line, level });
  }
  if (session.logs.length > MAX_LOG_LINES) {
    session.logs.splice(0, session.logs.length - MAX_LOG_LINES);
  }
  post({ type: 'log', key: session.key, line: { text, level } });
}

// ─────────────────────────────────────────── html

function buildHtml(webview, extensionUri) {
  const nonce = String(Math.random()).slice(2) + Date.now().toString(36);
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.css'));
  const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'media', 'main.js'));
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
  ].join('; ');

  return `<!DOCTYPE html>
<html lang="es">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link href="${cssUri}" rel="stylesheet">
  <title>NovaSuite Runner</title>
</head>
<body>
  <header class="bar">
    <span class="brand">NovaSuite Runner</span>
    <span id="summary" class="summary"></span>
    <button id="refresh" class="btn ghost">Refrescar</button>
    <button id="settings" class="btn ghost iconbtn" title="Configuracion" aria-label="Configuracion">&#9881;</button>
  </header>
  <div id="toast" class="toast"></div>
  <main class="grid">
    <aside class="sidebar">
      <h2>Apps</h2>
      <div id="projects" class="applist"></div>
    </aside>
    <div id="vsplit" class="vsplit" title="Arrastra para cambiar el ancho de la lista"></div>
    <section class="pane">
      <div id="devTabs" class="tabs devtabs"></div>
      <div id="devices" class="devgrid"></div>
    </section>
  </main>
  <div id="hsplit" class="hsplit" title="Arrastra para cambiar el alto de los logs"></div>
  <section class="logs">
    <div id="tabs" class="tabs"></div>
    <pre id="log" class="log"></pre>
  </section>
  <script nonce="${nonce}" src="${jsUri}"></script>
</body>
</html>`;
}

function deactivate() {
  if (daemon && daemon.proc) {
    try { daemon.proc.kill('SIGTERM'); } catch {}
    daemon = null;
  }
  for (const s of sessions.values()) {
    try { s.proc.kill('SIGTERM'); } catch {}
  }
  sessions.clear();
}

module.exports = { activate, deactivate };
