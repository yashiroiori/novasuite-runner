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
const builds = new Map();

let panel = null;
let view = null;                // la misma UI hospedada en la barra lateral
let extUri = null;
let daemon = null;
let cache = { devices: [], emulators: [], projects: [], roots: [], busy: false };

const FAV_KEY = 'novasuiteRunner.favorites';
const PROFILE_KEY = 'novasuiteRunner.profiles';
const WIFI_KEY = 'novasuiteRunner.wifiHosts';

let store = null;              // globalState: favoritos y perfiles sobreviven al reinstalar
let favorites = new Set();
let profiles = {};             // dir -> { mode, flavor, dartDefines[] }
let wifiHosts = [];            // ips usadas con adb connect, para no re-teclearlas
const recordings = new Map();  // deviceId -> { proc, file, device }

function activate(context) {
  store = context.globalState;
  extUri = context.extensionUri;
  favorites = new Set(store.get(FAV_KEY, []));
  profiles = store.get(PROFILE_KEY, {});
  wifiHosts = store.get(WIFI_KEY, []);

  context.subscriptions.push(
    vscode.commands.registerCommand('novasuiteRunner.open', () => openPanel(context)),
    vscode.window.registerWebviewViewProvider('novasuiteRunner.view', {
      resolveWebviewView(v) {
        view = v;
        v.webview.options = webviewOptions(context);
        v.webview.html = buildHtml(v.webview, context.extensionUri);
        v.webview.onDidReceiveMessage((msg) => handleMessage(msg));
        v.onDidDispose(() => { view = null; maybeStopDaemon(); });
        scanProjects();
        ensureDaemon();
      },
    })
  );

  watchForReload(context);
}

function webviewOptions(context) {
  return {
    enableScripts: true,
    retainContextWhenHidden: true,
    localResourceRoots: [
      vscode.Uri.joinPath(context.extensionUri, 'media'),
      ...(vscode.workspace.workspaceFolders || []).map((f) => f.uri),
    ],
  };
}

function hosts() {
  return [panel, view].filter(Boolean).map((h) => h.webview);
}

function maybeStopDaemon() {
  if (hosts().length) return;
  if (daemon && daemon.proc) {
    try { daemon.proc.kill('SIGTERM'); } catch {}
    daemon = null;
  }
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
    webviewOptions(context)
  );

  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.svg');
  panel.webview.html = buildHtml(panel.webview, context.extensionUri);

  panel.webview.onDidReceiveMessage((msg) => handleMessage(msg), null, context.subscriptions);

  panel.onDidDispose(() => {
    panel = null;
    // Los procesos siguen vivos a proposito: cerrar el panel no mata tus apps.
    maybeStopDaemon();
  }, null, context.subscriptions);

  scanProjects();
  ensureDaemon();
}

function post(msg) {
  for (const w of hosts()) w.postMessage(msg);
}

function pushState() {
  post({
    type: 'state',
    devices: cache.devices,
    emulators: cache.emulators,
    projects: cache.projects.map((p) => ({
      ...p,
      iconUri: p.icon && hosts()[0] ? hosts()[0].asWebviewUri(vscode.Uri.file(p.icon)).toString() : null,
      profile: profileLabel(p.dir),
    })),
    roots: cache.roots,
    busy: cache.busy,
    favorites: [...favorites],
    builds: [...builds.values()].map((b) => ({
      key: b.key,
      projectDir: b.project.dir,
      projectName: b.project.name,
      targetLabel: b.targetLabel,
      status: b.status,
    })),
    sessions: [...sessions.values()].map((s) => ({
      key: s.key,
      projectDir: s.project.dir,
      projectName: s.project.name,
      deviceId: s.device.id,
      deviceName: s.device.name,
      status: s.status,
      devtools: !!(s.devtoolsUrl || s.vmServiceHttp),
    })),
    recording: [...recordings.keys()],
  });
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'ready':
      pushState();
      for (const s of sessions.values()) {
        post({ type: 'logs', key: s.key, lines: s.logs });
      }
      for (const b of builds.values()) {
        post({ type: 'logs', key: b.key, lines: b.logs });
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
    case 'installRuntime':
      installRuntime(msg.runtime);
      break;
    case 'pruneSimulators':
      pruneSimulators();
      break;
    case 'toggleFavorite':
      toggleFavorite(msg.id);
      break;
    case 'repair':
      repairDevice(msg.deviceId);
      break;
    case 'build':
      appMenu(msg.dir);
      break;
    case 'devtools':
      openDevTools(msg.key);
      break;
    case 'deviceMenu':
      deviceMenu(msg.deviceId);
      break;
    case 'wifiConnect':
      wifiConnect();
      break;
    case 'saveLog':
      saveLog(msg.name, msg.text);
      break;
    case 'cancelBuild':
      cancelBuild(msg.key);
      break;
    case 'clearLogs': {
      const s = sessions.get(msg.key) || builds.get(msg.key);
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
    // Solo lo revivimos si queda alguna vista abierta; si no, que quede muerto.
    if (hosts().length) setTimeout(() => { if (hosts().length) ensureDaemon(); }, 3000);
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
    ['simctl', 'list', 'devices', '--json'],
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
          // Un simulador cuyo runtime se desinstalo sigue registrado pero no arranca.
          // Ocultarlo lo hace desaparecer sin explicacion; mejor mostrarlo apagado.
          const gone = d.isAvailable === false;
          sims.push({
            id: d.udid,
            name: d.name,
            platform: 'ios',
            kind: 'ios',
            group,
            state: d.state,
            unavailable: gone,
            reason: gone ? String(d.availabilityError || 'no disponible') : '',
            runtime: group,
          });
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

/**
 * CoreSimulator se cuelga con cierta frecuencia: launchd_sim se queda sin responder
 * y a partir de ahi NINGUN simulador arranca hasta reiniciar el servicio. simctl lo
 * reporta como POSIX 60 / SimLaunchHostService, no como un fallo del simulador.
 */
function isCoreSimulatorStuck(err) {
  const m = String((err && err.message) || '');
  return (
    /launchd_sim/.test(m) ||
    /SimLaunchHostService/.test(m) ||
    /launchd failed to respond/.test(m) ||
    /code=60/.test(m)
  );
}

function bootIosSimulator(id, name, healed) {
  post({ type: 'toast', message: `Arrancando ${name}…` });

  cp.execFile('xcrun', ['simctl', 'boot', id], { timeout: 120000 }, async (err) => {
    const msg = String((err && err.message) || '');

    // Ya estaba arrancado: no es un error, solo falta traer la ventana al frente.
    if (err && !/current state: Booted/.test(msg)) {
      if (isCoreSimulatorStuck(err) && !healed) {
        const ok = await vscode.window.showWarningMessage(
          `No se pudo arrancar ${name}: el servicio CoreSimulator de macOS dejo de responder.\n\n` +
            'Se puede reiniciar el servicio y volver a intentarlo. Esto cierra todos los simuladores abiertos.',
          { modal: true },
          'Reiniciar y reintentar'
        );
        if (ok !== 'Reiniciar y reintentar') return;

        post({ type: 'toast', message: 'Reiniciando CoreSimulator…' });
        cp.execFile('killall', ['-9', 'com.apple.CoreSimulator.CoreSimulatorService'], () => {
          // El servicio tarda un par de segundos en volver a levantarse.
          setTimeout(() => bootIosSimulator(id, name, true), 3000);
        });
        return;
      }

      post({ type: 'error', message: toolError(`xcrun simctl boot ${id}`, err) });
      return;
    }

    // simctl boot no abre la ventana: sin esto arranca headless.
    cp.execFile('open', ['-a', 'Simulator'], () => {});
    post({ type: 'toast', message: `${name} arrancado.` });
    setTimeout(queryDaemon, 3000);
  });
}

function launchEmulator(id, cold) {
  const entry = cache.emulators.find((e) => e.id === id);

  if (entry && entry.kind === 'ios') {
    bootIosSimulator(id, entry.name);
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

/**
 * Un simulador sin runtime instalado no se arregla con simctl: hay que bajar el
 * runtime. La descarga son varios GB y puede pedir la contrasena, asi que va a una
 * terminal visible en vez de correr escondida.
 */
function installRuntime(runtime) {
  const version = String(runtime || '').replace(/[^0-9.]/g, '');
  if (!version) {
    post({ type: 'error', message: 'No pude deducir la version del runtime.' });
    return;
  }
  const cmd = `xcodebuild -downloadPlatform iOS -buildVersion ${version}`;
  const term = vscode.window.createTerminal('NovaSuite Runner · runtime iOS');
  term.show(true);
  term.sendText(cmd);
  post({ type: 'toast', message: `Descargando el runtime de iOS ${version} en la terminal.` });
}

function pruneSimulators() {
  vscode.window
    .showWarningMessage(
      'Borrar los simuladores sin runtime instalado?',
      { modal: true, detail: 'xcrun simctl delete unavailable\n\nQuita el registro de los simuladores que ya no pueden arrancar. No toca los que si funcionan.' },
      'Borrar'
    )
    .then((ok) => {
      if (ok !== 'Borrar') return;
      cp.execFile('xcrun', ['simctl', 'delete', 'unavailable'], { timeout: 120000 }, (err) => {
        if (err) {
          post({ type: 'error', message: toolError('xcrun simctl delete unavailable', err) });
          return;
        }
        post({ type: 'toast', message: 'Registros borrados.' });
        loadIosSimulators();
      });
    });
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

// ─────────────────────────────────────────── devtools

function openDevTools(key) {
  const session = sessions.get(key);
  if (!session) return;

  // El daemon manda app.debugPort con la URI del VM service; DevTools sale en el log.
  const url = session.devtoolsUrl || session.vmServiceHttp;
  if (!url) {
    post({
      type: 'error',
      message: 'Todavia no hay URI del depurador para esta app. Espera a que termine de arrancar.',
    });
    return;
  }

  vscode.env.openExternal(vscode.Uri.parse(url));
  if (!session.devtoolsUrl) {
    vscode.env.clipboard.writeText(url);
    post({
      type: 'toast',
      message: 'Abriendo el VM service; la URI tambien quedo en el portapapeles.',
    });
  }
}

// ─────────────────────────────────────────── acciones de dispositivo

function androidDevices() {
  return cache.devices.filter((d) => String(d.platform || '').startsWith('android'));
}

function androidSdkDir() {
  const home = require('os').homedir();
  const candidates = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    path.join(home, 'Library', 'Android', 'sdk'),
    path.join(home, 'Android', 'Sdk'),
    path.join(home, 'AppData', 'Local', 'Android', 'Sdk'),
  ].filter(Boolean);
  return candidates.find((dir) => fs.existsSync(dir)) || null;
}

function androidEmulatorBin() {
  const sdk = androidSdkDir();
  if (!sdk) return null;
  const exe = process.platform === 'win32' ? 'emulator.exe' : 'emulator';
  for (const rel of [['emulator', exe], ['tools', exe]]) {
    const bin = path.join(sdk, ...rel);
    if (fs.existsSync(bin)) return bin;
  }
  return null;
}

function adbBin() {
  const sdk = androidSdkDir();
  if (sdk) {
    const bin = path.join(sdk, 'platform-tools', 'adb');
    if (fs.existsSync(bin)) return bin;
  }
  return 'adb';
}

function shotDir() {
  const dir = path.join(require('os').tmpdir(), 'novasuite-runner');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function stamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-');
}

function isIosSim(d) {
  return String(d.platform || '').startsWith('ios') && d.emulator;
}

async function deviceMenu(deviceId) {
  const d = cache.devices.find((x) => x.id === deviceId);
  if (!d) return;

  const android = String(d.platform || '').startsWith('android');
  const rec = recordings.get(d.id);
  const items = [];

  if (android || isIosSim(d)) {
    items.push({ ...SEP, label: 'Capturar' });
    items.push({ id: 'shot', label: 'Captura de pantalla', description: 'Guarda un PNG y lo abre' });
    items.push(
      rec
        ? { id: 'recStop', label: 'Detener la grabacion', description: 'Guarda el video y lo abre' }
        : { id: 'recStart', label: 'Grabar la pantalla', description: 'Se detiene desde este mismo menu' }
    );
  }

  if (android) {
    items.push({ ...SEP, label: 'Instalar' });
    items.push({ id: 'install', label: 'Instalar un APK…', description: 'adb install -r' });
    items.push({ ...SEP, label: 'Red' });
    items.push({
      id: 'tcpip',
      label: 'Habilitar ADB por WiFi',
      description: 'adb tcpip 5555, para desconectar el cable',
    });
  }

  const repairs = repairItems(d);
  if (repairs.length) {
    items.push({ ...SEP, label: 'Reparar' });
    for (const r of repairs) items.push({ ...r, id: 'repair' });
  }

  if (!items.length) {
    vscode.window.showInformationMessage(`No hay acciones disponibles para ${d.name}.`);
    return;
  }

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: d.name,
    matchOnDetail: true,
  });
  if (!pick) return;

  switch (pick.id) {
    case 'shot': return screenshot(d);
    case 'recStart': return startRecording(d);
    case 'recStop': return stopRecording(d);
    case 'install': return pickAndInstall(d);
    case 'tcpip': return enableTcpip(d);
    case 'repair': {
      if (pick.confirm) {
        const ok = await vscode.window.showWarningMessage(pick.confirm, { modal: true }, 'Continuar');
        if (ok !== 'Continuar') return;
      }
      if (pick.run) return pick.run();
      return runSteps(pick.steps, pick.label);
    }
  }
}

function revealResult(file, message) {
  vscode.window.showInformationMessage(message, 'Mostrar archivo', 'Copiar ruta').then((a) => {
    if (a === 'Mostrar archivo') vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(file));
    else if (a === 'Copiar ruta') vscode.env.clipboard.writeText(file);
  });
}

function screenshot(d) {
  const file = path.join(shotDir(), `${d.name.replace(/\W+/g, '_')}-${stamp()}.png`);
  post({ type: 'toast', message: `${d.name}: capturando…` });

  const done = (err) => {
    if (err) {
      post({ type: 'error', message: toolError('captura de pantalla', err) });
      return;
    }
    revealResult(file, `Captura de ${d.name} guardada.`);
  };

  if (isIosSim(d)) {
    cp.execFile('xcrun', ['simctl', 'io', d.id, 'screenshot', file], { timeout: 60000 }, done);
    return;
  }

  // exec-out entrega el PNG binario sin las conversiones de fin de linea de adb shell.
  const out = fs.createWriteStream(file);
  const proc = cp.spawn(adbBin(), ['-s', d.id, 'exec-out', 'screencap', '-p']);
  proc.stdout.pipe(out);
  proc.on('error', done);
  proc.on('close', (code) => {
    out.end();
    done(code === 0 ? null : new Error(`adb salio con codigo ${code}`));
  });
}

function startRecording(d) {
  if (recordings.has(d.id)) return;
  const ext = isIosSim(d) ? 'mp4' : 'mp4';
  const file = path.join(shotDir(), `${d.name.replace(/\W+/g, '_')}-${stamp()}.${ext}`);

  let proc;
  if (isIosSim(d)) {
    proc = cp.spawn('xcrun', ['simctl', 'io', d.id, 'recordVideo', '--force', file]);
  } else {
    // screenrecord graba dentro del telefono; al parar hay que traerse el archivo.
    proc = cp.spawn(adbBin(), ['-s', d.id, 'shell', 'screenrecord', '/sdcard/nsr-rec.mp4']);
  }

  recordings.set(d.id, { proc, file, device: d });
  pushState();
  post({ type: 'toast', message: `${d.name}: grabando… detenla desde el menu ⋯` });

  proc.on('error', (err) => {
    recordings.delete(d.id);
    pushState();
    post({ type: 'error', message: toolError('grabacion de pantalla', err) });
  });
}

function stopRecording(d) {
  const rec = recordings.get(d.id);
  if (!rec) return;
  recordings.delete(d.id);
  pushState();

  // Ambas herramientas cierran el archivo al recibir SIGINT, no antes.
  try { rec.proc.kill('SIGINT'); } catch {}

  if (isIosSim(d)) {
    setTimeout(() => revealResult(rec.file, `Video de ${d.name} guardado.`), 1200);
    return;
  }

  post({ type: 'toast', message: `${d.name}: bajando el video…` });
  setTimeout(() => {
    cp.execFile(
      adbBin(),
      ['-s', d.id, 'pull', '/sdcard/nsr-rec.mp4', rec.file],
      { timeout: 120000 },
      (err) => {
        if (err) {
          post({ type: 'error', message: toolError('adb pull', err) });
          return;
        }
        cp.execFile(adbBin(), ['-s', d.id, 'shell', 'rm', '/sdcard/nsr-rec.mp4'], () => {});
        revealResult(rec.file, `Video de ${d.name} guardado.`);
      }
    );
  }, 1500);
}

async function pickAndInstall(d) {
  const files = await vscode.window.showOpenDialog({
    canSelectMany: false,
    openLabel: 'Instalar',
    filters: { APK: ['apk'] },
  });
  if (!files || !files.length) return;
  install(d, files[0].fsPath);
}

async function installApk(apks) {
  const targets = androidDevices();
  if (!targets.length) {
    post({ type: 'error', message: 'No hay dispositivos Android conectados.' });
    return;
  }

  const device =
    targets.length === 1
      ? targets[0]
      : await vscode.window
          .showQuickPick(
            targets.map((d) => ({ label: d.name, description: d.id, device: d })),
            { placeHolder: 'Instalar en…' }
          )
          .then((x) => x && x.device);
  if (!device) return;

  // Con --split-per-abi hay tres APK y solo uno le sirve al telefono.
  const apk =
    apks.length === 1
      ? apks[0]
      : await vscode.window
          .showQuickPick(
            apks.map((f) => ({ label: path.basename(f), description: f })),
            { placeHolder: 'Cual APK' }
          )
          .then((x) => x && x.description);
  if (!apk) return;

  install(device, apk);
}

function install(d, apk) {
  post({ type: 'toast', message: `${d.name}: instalando ${path.basename(apk)}…` });
  cp.execFile(adbBin(), ['-s', d.id, 'install', '-r', apk], { timeout: 300000 }, (err, stdout) => {
    if (err) {
      post({ type: 'error', message: toolError('adb install', err) });
      return;
    }
    const failed = /Failure \[([^\]]+)\]/.exec(String(stdout));
    if (failed) {
      post({ type: 'error', message: `adb install fallo: ${failed[1]}` });
      return;
    }
    post({ type: 'toast', message: `${d.name}: instalado.` });
  });
}

function enableTcpip(d) {
  runSteps([[adbBin(), ['-s', d.id, 'tcpip', '5555']]], `${d.name}: ADB por WiFi`);
  vscode.window.showInformationMessage(
    `${d.name} escucha en el puerto 5555. Desconecta el cable y usa "Conectar por WiFi" con la IP del telefono.`
  );
}

async function wifiConnect() {
  const items = [
    ...wifiHosts.map((h) => ({ label: h, description: 'usado antes' })),
    { label: 'Otra direccion…', alwaysShow: true },
  ];

  let host;
  if (wifiHosts.length) {
    const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Conectar por WiFi' });
    if (!pick) return;
    host = pick.label === 'Otra direccion…' ? null : pick.label;
  }

  if (!host) {
    const v = await vscode.window.showInputBox({
      prompt: 'IP del dispositivo (el puerto por defecto es 5555)',
      placeHolder: '192.168.0.15',
      validateInput: (x) => (/^[\d.]+(:\d+)?$/.test(x.trim()) ? null : 'Escribe una IP, por ejemplo 192.168.0.15'),
    });
    if (!v) return;
    host = v.trim();
  }

  const target = host.includes(':') ? host : `${host}:5555`;
  post({ type: 'toast', message: `Conectando con ${target}…` });

  cp.execFile(adbBin(), ['connect', target], { timeout: 30000 }, (err, stdout) => {
    const out = String(stdout || '');
    if (err || /unable to connect|failed to connect/i.test(out)) {
      post({ type: 'error', message: `adb connect ${target} fallo: ${out.trim() || (err && err.message)}` });
      return;
    }
    wifiHosts = [host, ...wifiHosts.filter((h) => h !== host)].slice(0, 8);
    if (store) store.update(WIFI_KEY, wifiHosts);
    post({ type: 'toast', message: `Conectado con ${target}.` });
    setTimeout(queryDaemon, 1500);
  });
}

async function saveLog(name, text) {
  if (!text) {
    post({ type: 'error', message: 'No hay nada que guardar en esta pestana.' });
    return;
  }

  const target = await vscode.window.showSaveDialog({
    defaultUri: vscode.Uri.file(path.join(shotDir(), `${name || 'log'}-${stamp()}.log`)),
    filters: { Log: ['log', 'txt'] },
  });
  if (!target) return;

  try {
    fs.writeFileSync(target.fsPath, text, 'utf8');
  } catch (err) {
    post({ type: 'error', message: `No se pudo guardar el log: ${err.message}` });
    return;
  }
  revealResult(target.fsPath, 'Log guardado.');
}

// ─────────────────────────────────────────── recarga al guardar

function watchForReload(context) {
  const watcher = vscode.workspace.createFileSystemWatcher('**/lib/**/*.dart');
  let timer = null;

  const onChange = (uri) => {
    if (!cfg().get('reloadOnSave')) return;
    const file = uri.fsPath;
    clearTimeout(timer);
    // Guardar varios archivos de golpe debe disparar un solo reload.
    timer = setTimeout(() => {
      for (const s of sessions.values()) {
        if (s.status !== 'running') continue;
        if (!file.startsWith(s.project.dir + path.sep)) continue;
        addLog(s, '⚡ hot reload (archivo guardado)', 'meta');
        sendRequest(s, 'app.restart', { fullRestart: false, pause: false, reason: 'save' });
      }
    }, 300);
  };

  watcher.onDidChange(onChange);
  watcher.onDidCreate(onChange);
  context.subscriptions.push(watcher);
}

// ─────────────────────────────────────────── perfil de ejecucion

const RUN_MODES = [
  { id: 'debug', label: 'Debug', description: 'Hot reload disponible; el default de Flutter', args: [] },
  { id: 'profile', label: 'Profile', description: 'Para medir rendimiento; sin hot reload', args: ['--profile'] },
  { id: 'release', label: 'Release', description: 'Como lo veria el cliente; sin hot reload', args: ['--release'] },
];

function profileOf(dir) {
  return profiles[dir] || { mode: 'debug', flavor: '', dartDefines: [] };
}

function profileLabel(dir) {
  const p = profileOf(dir);
  const bits = [];
  if (p.mode !== 'debug') bits.push(p.mode);
  if (p.flavor) bits.push(p.flavor);
  if (p.dartDefines && p.dartDefines.length) bits.push(`${p.dartDefines.length} define`);
  return bits.join(' · ');
}

function saveProfile(dir, patch) {
  profiles[dir] = { ...profileOf(dir), ...patch };
  if (store) store.update(PROFILE_KEY, profiles);
  pushState();
}

function profileArgs(dir) {
  const p = profileOf(dir);
  const mode = RUN_MODES.find((m) => m.id === p.mode) || RUN_MODES[0];
  return [
    ...mode.args,
    ...(p.flavor ? ['--flavor', p.flavor] : []),
    ...(p.dartDefines || []).map((d) => `--dart-define=${d}`),
  ];
}

async function editProfile(dir) {
  const project = cache.projects.find((x) => x.dir === dir);
  if (!project) return;

  for (;;) {
    const p = profileOf(dir);
    const pick = await vscode.window.showQuickPick(
      [
        { id: 'mode', label: 'Modo', description: p.mode },
        { id: 'flavor', label: 'Flavor', description: p.flavor || 'ninguno' },
        {
          id: 'defines',
          label: 'dart-define',
          description: (p.dartDefines || []).join(', ') || 'ninguno',
        },
        { id: 'reset', label: 'Restablecer', description: 'Volver a debug sin flavor ni defines' },
      ],
      { placeHolder: `Perfil de ejecucion de ${project.name}` }
    );
    if (!pick) return;

    if (pick.id === 'mode') {
      const m = await vscode.window.showQuickPick(RUN_MODES, { placeHolder: 'Modo de compilacion' });
      if (m) saveProfile(dir, { mode: m.id });
    } else if (pick.id === 'flavor') {
      const v = await vscode.window.showInputBox({
        prompt: 'Flavor de Android/iOS (vacio para ninguno)',
        value: p.flavor || '',
      });
      if (v !== undefined) saveProfile(dir, { flavor: v.trim() });
    } else if (pick.id === 'defines') {
      const v = await vscode.window.showInputBox({
        prompt: 'dart-define separados por coma, en formato CLAVE=valor',
        value: (p.dartDefines || []).join(','),
        placeHolder: 'ENV=dev,API=https://…',
      });
      if (v !== undefined) {
        saveProfile(dir, {
          dartDefines: v.split(',').map((x) => x.trim()).filter(Boolean),
        });
      }
    } else if (pick.id === 'reset') {
      saveProfile(dir, { mode: 'debug', flavor: '', dartDefines: [] });
    }
  }
}

// ─────────────────────────────────────────── menu de la app

const SEP = { label: '', kind: vscode.QuickPickItemKind.Separator };

async function appMenu(dir) {
  const project = cache.projects.find((p) => p.dir === dir);
  if (!project) return;

  const building = builds.get(`build::${dir}`);
  const items = [
    { ...SEP, label: 'Correr' },
    {
      id: 'profile',
      label: 'Perfil de ejecucion…',
      description: profileLabel(dir) || 'debug',
      detail: 'Modo, flavor y dart-define que se usan al correr esta app',
    },
    { id: 'runFav', label: 'Correr en los favoritos conectados' },
    { id: 'runAll', label: 'Correr en todos los dispositivos activos' },
    { ...SEP, label: 'Compilar' },
    ...(building
      ? [{ id: 'cancel', label: 'Cancelar la compilacion en curso', description: building.targetLabel }]
      : buildTargets().map((t) => ({ ...t, id: 'build' }))),
    { ...SEP, label: 'Mantenimiento' },
    ...MAINTENANCE.map((t) => ({ ...t, id: 'maint' })),
  ];

  const pick = await vscode.window.showQuickPick(items, {
    placeHolder: project.name,
    matchOnDetail: true,
  });
  if (!pick) return;

  if (pick.id === 'profile') return editProfile(dir);
  if (pick.id === 'runFav') return runOnMany(dir, 'fav');
  if (pick.id === 'runAll') return runOnMany(dir, 'all');
  if (pick.id === 'cancel') return cancelBuild(`build::${dir}`);
  if (pick.id === 'build') return startBuild(project, pick);
  if (pick.id === 'maint') return startBuild(project, pick);
}

const MAINTENANCE = [
  {
    label: 'flutter clean',
    description: 'Borra build/ y .dart_tool/',
    args: ['clean'],
  },
  {
    label: 'flutter pub get',
    description: 'Vuelve a resolver las dependencias',
    args: ['pub', 'get'],
  },
  {
    label: 'flutter doctor -v',
    description: 'Diagnostico del entorno',
    args: ['doctor', '-v'],
  },
];

function runOnMany(dir, which) {
  const targets = cache.devices.filter((d) => {
    if (!d.supported) return false;
    if (which === 'fav') return favorites.has(d.id) || (d.emulatorId && favorites.has(d.emulatorId));
    return true;
  });

  if (!targets.length) {
    post({ type: 'error', message: which === 'fav'
      ? 'No hay favoritos conectados ahora mismo.'
      : 'No hay dispositivos activos.' });
    return;
  }

  for (const d of targets) startApp(dir, d.id);
}

// ─────────────────────────────────────────── compilacion

function buildTargets() {
  const items = [
    {
      label: 'APK (release)',
      description: 'El instalable normal para repartir a mano',
      detail: 'flutter build apk --release',
      args: ['build', 'apk', '--release'],
    },
    {
      label: 'APK por arquitectura',
      description: 'Tres APK mas chicos: arm64, arm32 y x86_64',
      detail: 'flutter build apk --release --split-per-abi',
      args: ['build', 'apk', '--release', '--split-per-abi'],
    },
    {
      label: 'APK (debug)',
      description: 'Compila mas rapido, pesa mas y va sin optimizar',
      detail: 'flutter build apk --debug',
      args: ['build', 'apk', '--debug'],
    },
    {
      label: 'App Bundle (AAB)',
      description: 'El formato que pide Google Play',
      detail: 'flutter build appbundle --release',
      args: ['build', 'appbundle', '--release'],
    },
  ];

  if (process.platform === 'darwin') {
    items.push({
      label: 'IPA (release)',
      description: 'Requiere Xcode y un perfil de firma configurado',
      detail: 'flutter build ipa --release',
      args: ['build', 'ipa', '--release'],
    });
  }

  return items;
}

function startBuild(project, target) {
  const dir = project.dir;
  const key = `build::${dir}`;
  if (builds.has(key)) {
    post({ type: 'toast', message: `${project.name} ya tiene una tarea corriendo.` });
    return;
  }

  let proc;
  try {
    proc = cp.spawn(flutterBin(), target.args, { cwd: dir });
  } catch (err) {
    post({ type: 'error', message: toolError('flutter', err) });
    return;
  }

  const build = {
    key,
    project,
    proc,
    targetLabel: target.label,
    status: 'building',
    logs: [],
    artifacts: [],
  };
  builds.set(key, build);
  pushState();

  addLog(build, `▶ flutter ${target.args.join(' ')}  (cwd: ${project.rel})`, 'meta');
  post({ type: 'toast', message: `${project.name}: ${target.label}…` });

  const onText = (chunk, level) => {
    const text = String(chunk).trimEnd();
    if (!text) return;
    addLog(build, text, level);
    for (const line of text.split('\n')) {
      // Flutter anuncia el resultado como "✓ Built build/app/outputs/.../app-release.apk (21.4MB)".
      const m = line.match(/Built\s+(\S+\.(?:apk|aab|ipa))/);
      if (m) build.artifacts.push(path.resolve(dir, m[1]));
    }
  };

  proc.stdout.on('data', (chunk) => onText(chunk, null));
  proc.stderr.on('data', (chunk) => onText(chunk, 'error'));

  proc.on('error', (err) => {
    addLog(build, toolError('flutter', err), 'error');
    post({ type: 'error', message: toolError('flutter', err) });
    builds.delete(key);
    pushState();
  });

  proc.on('close', (code) => {
    const cancelled = build.status === 'cancelled';
    builds.delete(key);
    pushState();

    if (cancelled) {
      addLog(build, '■ tarea cancelada', 'meta');
      post({ type: 'toast', message: `${project.name}: ${target.label} cancelado.` });
      return;
    }

    if (code !== 0) {
      addLog(build, `■ fallo (codigo ${code})`, 'error');
      post({
        type: 'error',
        message: `${project.name}: fallo ${target.label}. Revisa el log.`,
      });
      return;
    }

    addLog(build, `✓ ${target.label} listo`, 'meta');
    if (build.artifacts.length) announceArtifacts(project, target.label, build.artifacts);
    else post({ type: 'toast', message: `${project.name}: ${target.label} listo.` });
  });
}

function announceArtifacts(project, targetLabel, artifacts) {
  const found = artifacts.filter((f) => fs.existsSync(f));
  if (!found.length) {
    post({ type: 'toast', message: `${project.name}: ${targetLabel} listo.` });
    return;
  }

  const sizeMb = found.reduce((acc, f) => acc + fs.statSync(f).size, 0) / 1048576;
  const many = found.length > 1 ? ` (${found.length} archivos)` : '';

  const installable = found.filter((f) => f.endsWith('.apk'));
  const actions = ['Mostrar archivo', 'Copiar ruta'];
  if (installable.length && androidDevices().length) actions.unshift('Instalar en…');

  vscode.window
    .showInformationMessage(
      `${project.name}: ${targetLabel} listo${many} · ${sizeMb.toFixed(1)} MB`,
      ...actions
    )
    .then((action) => {
      if (action === 'Mostrar archivo') {
        vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(found[0]));
      } else if (action === 'Copiar ruta') {
        vscode.env.clipboard.writeText(found.join('\n'));
      } else if (action === 'Instalar en…') {
        installApk(installable);
      }
    });
}

function cancelBuild(key) {
  const build = builds.get(key);
  if (!build) return;
  build.status = 'cancelled';
  pushState();
  try { build.proc.kill('SIGTERM'); } catch {}
}

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
  const args = ['run', '--machine', '-d', device.id, ...profileArgs(dir), ...extra];

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
  } else if (msg.event === 'app.debugPort') {
    const p = msg.params || {};
    // wsUri viene como ws://127.0.0.1:PORT/token=/ws; la forma http es la que abre el navegador.
    if (p.wsUri) session.vmServiceHttp = String(p.wsUri).replace(/^ws/, 'http').replace(/ws$/, '');
    else if (p.baseUri) session.vmServiceHttp = String(p.baseUri).replace(/^ws/, 'http');
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
  if (session.device) sniffDebugUrls(session, text);
  for (const line of String(text).split('\n')) {
    session.logs.push({ text: line, level });
  }
  if (session.logs.length > MAX_LOG_LINES) {
    session.logs.splice(0, session.logs.length - MAX_LOG_LINES);
  }
  post({ type: 'log', key: session.key, line: { text, level } });
}

function sniffDebugUrls(session, text) {
  if (session.devtoolsUrl) return;
  for (const line of String(text).split('\n')) {
    if (!/DevTools/i.test(line)) continue;
    const m = line.match(/https?:\/\/\S+/);
    if (m) {
      session.devtoolsUrl = m[0].replace(/[.,)]$/, '');
      pushState();
      return;
    }
  }
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
      <input id="appfilter" class="filter" type="text" placeholder="Filtrar apps…" aria-label="Filtrar apps">
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
  for (const b of builds.values()) {
    try { b.proc.kill('SIGTERM'); } catch {}
  }
  builds.clear();
}

module.exports = { activate, deactivate };
