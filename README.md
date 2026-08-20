# NovaSuite Runner

> Parte de **NovaSuiteTools**, las herramientas internas de desarrollo de NovaSuite.

Un panel para VS Code y Antigravity que lista **las apps Flutter de tu workspace**
y **los dispositivos disponibles**, y las corre con un click o arrastrando una
sobre el otro. Pensado para monorepos con varias apps, donde `flutter run` obliga
a hacer `cd` y a recordar IDs de dispositivo.

Sin terminal, sin copiar IDs, sin una ventana por app.

---

## Instalar

Desde el `.vsix`:

```bash
code --install-extension novasuite-runner-0.10.0.vsix
```

En Antigravity, Windsurf, Cursor o VSCodium: **Extensions → `⋯` → Install from VSIX**.

Después de instalar o actualizar hay que recargar la ventana (`Developer: Reload Window`).

### Requisitos

- Flutter en el `PATH`, o la ruta puesta en `novasuiteRunner.flutterPath`.
- Para emuladores Android: el SDK de Android (se busca en `ANDROID_HOME`,
  `ANDROID_SDK_ROOT`, `~/Library/Android/sdk` o `~/Android/Sdk`).
- Para simuladores iOS: Xcode con las command line tools (`xcrun simctl`).

---

## Abrir el panel

`Cmd/Ctrl + Shift + P` → **NovaSuite Runner: Abrir panel**.

Se abre como una pestaña normal del editor, en la columna activa. Puedes moverla,
partirla en dos o dejarla al lado del código.

---

## La interfaz

```
┌──────────────────────────────────────────────────────────────┐
│ NovaSuite Runner   3 activos · 6 apps · 2 corriendo   [Refrescar] [⚙] │
├────────────┬─────────────────────────────────────────────────┤
│ Apps       │ Dispositivos activos (3) | Favoritos (2) | Inactivos (33) │
│            │                                                 │
│ ▣ tienda   │  ── Fisicos ─────────────────────── 1           │
│ ▣ taller   │  ┌──────────────┐  ┌──────────────┐             │
│ ▣ agenda   │  │ ★  ⋯         │  │ ★  ⋯         │             │
│ ▣ …        │  │ Redmi Note 12│  │ iPhone 15 Pro│             │
│            │  │ ● ACTIVO     │  │ ● ACTIVO     │             │
│            │  │ ▶ Correr …   │  │ ⚡ ⟳ ■        │             │
├────────────┴─────────────────────────────────────────────────┤
│ tienda · iPhone 15 | taller · Redmi              [Limpiar]    │
│ Syncing files to device…                                     │
└──────────────────────────────────────────────────────────────┘
```

**Barra superior** — resumen vivo (`N activos · N apps · N corriendo`), botón
**Refrescar** (vuelve a escanear apps y dispositivos) y el engrane **⚙**, que abre
los ajustes de la extensión.

**Apps** (izquierda) — cada `pubspec.yaml` con `lib/main.dart` encontrado en el
workspace, hasta 4 niveles de profundidad. Se saltan `build/`, `.dart_tool/`,
`node_modules/`, `ios/`, `android/`, `Pods/` y demás carpetas de artefactos.

**Dispositivos** (derecha) — tres pestañas: activos, favoritos, inactivos.

**Logs** (abajo) — una pestaña por app corriendo.

---

## Correr una app

Hay cuatro caminos, todos equivalentes:

1. **Click en la app, click en la tarjeta del dispositivo.**
2. **Click en la app, botón `▶ Correr <app>`** de la tarjeta.
3. **Arrastrar la app y soltarla sobre el dispositivo.** Mientras arrastras, los
   dispositivos compatibles se marcan con borde punteado.
4. **`Enter` o `Espacio`** sobre la app en la lista la selecciona sin mouse.

**Doble click en una app** no la corre: la revela en el explorador, abriendo su
`lib/main.dart`.

Las tarjetas de dispositivos no soportados (o sea, donde esa app no puede correr)
quedan deshabilitadas y no aceptan drops.

---

## Mientras corre

Cada app corriendo aparece **dentro de la tarjeta de su dispositivo**, con su icono
y tres botones:

| Botón | Qué hace |
|---|---|
| `⚡` | Hot reload — `app.restart` con `fullRestart: false` |
| `⟳` | Hot restart — `app.restart` con `fullRestart: true` |
| `■` | Detener — pide parada limpia y, si no responde en 4s, `SIGTERM` |

`⚡` y `⟳` se habilitan cuando la app llegó a *corriendo*; antes están en gris
porque el daemon todavía no acepta reload.

**Un dispositivo puede tener varias apps a la vez**, y se listan todas. Cambiar de
app en la barra izquierda no esconde lo que ya está corriendo: no hay que detener
nada para soltar otra app encima.

**Click en una app corriendo** salta directo a su pestaña de logs.

### Varias apps a la vez

Puedes correr la misma app en dos dispositivos, o dos apps distintas, o cualquier
combinación. Cada instancia es un proceso `flutter run --machine` independiente con
su propia pestaña de log. Es lo que hace usable cualquier flujo que exija dos o
más dispositivos emparejados a la vez.

### Logs

Una pestaña por instancia, etiquetada `<app> · <dispositivo>`. Guarda hasta 1500
líneas por sesión; **Limpiar** vacía la pestaña activa. Los errores salen en rojo y
los mensajes de la extensión en gris.

Si cierras el panel y lo vuelves a abrir, los logs anteriores se restauran: el
buffer vive en el host de la extensión, no en la vista.

---

## Favoritos

Con 30+ simuladores instalados, encontrar el de siempre es lo lento. Marca los
tuyos con la **estrella `☆`** de cada tarjeta y quedan juntos en la pestaña
**Favoritos**, en dos grupos:

- **Conectados** — favoritos vivos ahora, con todas sus acciones.
- **Sin arrancar** — emuladores favoritos apagados, listos para arrancar.

Un **dispositivo físico** favorito solo aparece cuando está conectado; no tiene
sentido mostrar un teléfono que no está enchufado. Un **emulador** favorito aparece
siempre.

Se guardan en el `globalState` del IDE: sobreviven a cerrar el panel, a recargar la
ventana y a reinstalar la extensión. Se guarda el ID del AVD/simulador, no el del
dispositivo arrancado, para que el favorito no se pierda al reiniciarlo.

La pestaña Favoritos también acepta arrastrar y soltar.

---

## Emuladores y simuladores

La pestaña **Inactivos** lista lo que tienes instalado pero apagado, agrupado por
plataforma: Android primero, luego los runtimes de iOS del más nuevo al más viejo.

| Botón | Qué hace |
|---|---|
| **Arrancar** | Levanta el emulador o simulador |
| **En frío** (solo Android) | `emulator -avd X -no-snapshot-load`, descarta el snapshot |

Los simuladores de iOS se leen con `xcrun simctl list devices --json`, no con
Flutter: el daemon reporta un único `apple_ios_simulator` genérico en vez de uno
por simulador.

**En cuanto un dispositivo arranca o se conecta, aparece solo.** No hay sondeo ni
botón que apretar: un `flutter daemon` de larga vida empuja `device.added` y
`device.removed` en cuanto pasan. Medido: un simulador aparece ~8s después del
`simctl boot` —que es lo que tarda en arrancar él— y desaparece ~4s después de
apagarlo.

---

## Reparar un dispositivo

El botón `⋯` de cada tarjeta abre las acciones de rescate, para cuando el emulador
se queda en negro o pegado en el spinner:

| Plataforma | Acción | Comando |
|---|---|---|
| iOS Simulator | Reiniciar el simulador | `simctl shutdown` + `simctl boot` |
| iOS Simulator | Reiniciar CoreSimulator | `killall -9 com.apple.CoreSimulator.CoreSimulatorService` |
| iOS Simulator | Borrar contenido y ajustes | `simctl erase` |
| Android | Reiniciar el dispositivo | `adb reboot` |
| Android | Reiniciar el servidor ADB | `adb kill-server` + `start-server` |
| Android emulador | Apagar | `adb emu kill` |
| Android emulador | Reiniciar en frío | `adb emu kill` + `emulator -avd X -no-snapshot-load` |
| Android emulador | Borrar datos del dispositivo | `adb emu kill` + `emulator -avd X -wipe-data` |

Las acciones destructivas (borrar contenido, borrar datos) piden confirmación modal
antes de correr. `adb` y `emulator` se resuelven desde el SDK, no desde el `PATH`,
porque el IDE no siempre lo hereda.

---

## Ajustar el panel

Los dos divisores se arrastran, como en VS Code:

- El **vertical** cambia el ancho de la lista de apps (150–480px).
- El **horizontal** cambia el alto de los logs (60px hasta el 80% de la ventana).

**Doble click** en un divisor lo devuelve a su tamaño por defecto. Los tamaños se
guardan y se restauran al reabrir.

---

## Iconos de app

Si la app configura `flutter_launcher_icons` en su `pubspec.yaml`, ese icono
aparece en la lista y junto a cada instancia corriendo. Se leen `image_path`,
`image_path_android` e `image_path_ios`, y si no hay bloque se prueban rutas
convencionales:

```
assets/images/logo/logo_icon.png
assets/images/logo/logo_icon_square.png
assets/images/logo_icon.png
assets/icon/icon.png
android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png
web/icons/Icon-192.png
```

Sin icono, la app muestra un cuadro con sus iniciales. Cuando está corriendo, el
icono lleva un anillo verde.

---

## Cerrar el panel

**No detiene nada.** Los procesos viven en el host de la extensión, no en la vista;
al cerrar solo se apaga el daemon de descubrimiento de dispositivos, que vuelve
cuando reabres. Las apps siguen corriendo y las recuperas con sus logs.

**Sí se detiene todo** al recargar la ventana, cerrar el IDE, o instalar/actualizar
la extensión — las tres cosas son un reinicio del host.

---

## Configuración

| Ajuste | Default | Para qué |
|---|---|---|
| `novasuiteRunner.flutterPath` | `flutter` | Ruta absoluta si el IDE no hereda tu PATH |
| `novasuiteRunner.extraRunArgs` | `[]` | Args extra para `flutter run`, ej. `["--dart-define=ENV=dev"]` |

El engrane de la barra superior te lleva directo a estos ajustes.

---

## Si algo no sale

**No aparece ninguna app.** El panel escanea las carpetas abiertas en el workspace.
Si abriste un archivo suelto en vez de una carpeta, no hay dónde buscar — el estado
vacío te dice qué rutas escaneó y ofrece abrir una carpeta.

**No encuentra `flutter`.** Pon la ruta absoluta en `novasuiteRunner.flutterPath`.
Los IDEs lanzados desde el Dock no heredan el `PATH` de tu shell.

**No aparecen los simuladores de iOS.** Requiere Xcode instalado y
`xcrun simctl list devices` funcionando desde tu terminal.

**Las acciones de Android fallan.** Se necesita el SDK en una de las rutas
conocidas, o `ANDROID_HOME` exportado en el entorno del que arrancó el IDE.

---

## Cómo funciona por dentro

Usa el protocolo daemon JSON de Flutter, el mismo que usa la extensión oficial de
Dart: un `flutter daemon` persistente para descubrir dispositivos y emuladores, y
un `flutter run --machine` por cada app corriendo.

Es lo que permite mandar hot reload sin terminal: el hot reload por tecla `r`
necesita un TTY interactivo, y un `spawn` normal no lo tiene. Con `--machine`,
reload y restart son peticiones JSON por stdin.

---

## Desarrollo

Sin dependencias ni compilación — JavaScript plano.

Abre esta carpeta en VS Code o Antigravity y pulsa **F5** — arranca una ventana
con la extensión cargada (config `Run Extension`).

```bash
npx @vscode/vsce package        # genera el .vsix
```

## Publicar

El mismo `.vsix` va a las dos tiendas:

```bash
npx @vscode/vsce publish                  # VS Code Marketplace (publisher + PAT de Azure DevOps)
npx ovsx publish *.vsix -p $OVSX_TOKEN    # Open VSX (Antigravity, Windsurf, Cursor, VSCodium)
```

Antigravity y los demás forks no pueden consumir el Marketplace de Microsoft por
licencia; de ahí las dos publicaciones.

---

## Estado

Verificado en vivo: descubrimiento de apps e iconos, el daemon de dispositivos
(alta y baja en tiempo real, medidas arriba), el listado de simuladores por
`simctl`, arranque de emuladores, las acciones de reparación, y el empaquetado.

**Sin verificar en vivo: `⚡` hot reload y `⟳` hot restart.** El protocolo está
implementado y el daemon acepta la conexión, pero el build de prueba en macOS no
terminó dentro de la ventana de tiempo disponible, así que nunca vi ejecutarse un
`app.restart`. Es lo único de la extensión que no he visto funcionar con mis
propios ojos.

## Licencia

MIT.
