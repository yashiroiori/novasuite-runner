# NovaSuite Runner

> Parte de **NovaSuiteTools**, las herramientas internas de desarrollo de NovaSuite.

Un panel para VS Code y Antigravity que lista **las apps Flutter de tu workspace**
y **los dispositivos disponibles**, y las corre con un click o arrastrando una
sobre el otro. Pensado para monorepos con varias apps, donde `flutter run` obliga
a hacer `cd` y a recordar IDs de dispositivo.

Sin terminal, sin copiar IDs, sin una ventana por app.

![NovaSuite Runner](https://raw.githubusercontent.com/yashiroiori/novasuite-runner/main/media/screenshot.png)

---

## Instalar

Desde el `.vsix`:

```bash
code --install-extension novasuite-runner-0.11.6.vsix
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

## El menú de cada app

Cada app de la lista trae un botón **`⚒`** a la derecha (aparece al pasar el mouse
o si es la app seleccionada). Abre un menú con tres grupos.

### Correr

| Opción | Qué hace |
|---|---|
| **Perfil de ejecución…** | Modo (`debug` / `profile` / `release`), `--flavor` y `--dart-define` de esa app |
| **Correr en los favoritos conectados** | Lanza la app en todos tus favoritos vivos, de un golpe |
| **Correr en todos los dispositivos activos** | Igual, pero sin filtrar por favoritos |

El perfil se guarda por app en el `globalState`, así que sobrevive a recargar la
ventana. Cuando no es el default, aparece bajo el nombre de la app en la lista
(`release · prod · 2 define`) para que no compiles en release sin darte cuenta.

Correr en varios dispositivos a la vez es lo que hace usable un flujo que exige
dos o más equipos emparejados: cada uno es su propio proceso con su propio log.

### Compilar

| Opción | Comando |
|---|---|
| APK (release) | `flutter build apk --release` |
| APK por arquitectura | `flutter build apk --release --split-per-abi` |
| APK (debug) | `flutter build apk --debug` |
| App Bundle (AAB) | `flutter build appbundle --release` |
| IPA (release) | `flutter build ipa --release` *(solo en macOS)* |

La compilación corre en segundo plano y abre su propia pestaña en el panel de
logs. Mientras dura, la app muestra el avance en la barra izquierda y el botón
cambia a **`■`** para cancelarla.

Al terminar sale un aviso con el peso del archivo y las acciones **Instalar en…**
(elige un dispositivo Android y hace `adb install -r`), **Mostrar archivo** y
**Copiar ruta**. Con `--split-per-abi` te pregunta cuál de los tres APK instalar.

### Mantenimiento

`flutter clean`, `flutter pub get` y `flutter doctor -v`, con la salida en la misma
pestaña de logs. Es la misma maquinaria que la compilación: se puede cancelar igual.

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

El grupo **Reparar** del menú `⋯` son las acciones de rescate, para cuando el
emulador se queda en negro o pegado en el spinner:

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

## DevTools

Cada app corriendo tiene un botón **`◈`** junto a `⚡ ⟳ ■`. Abre DevTools en el
navegador con la sesión ya conectada.

La URL sale de dos lados: el evento `app.debugPort` del daemon (que trae la URI del
VM service) y la línea de DevTools del propio log. Si solo tenemos la primera, el
botón abre el VM service y además copia la URI al portapapeles. El botón está en
gris hasta que la app reporta el depurador.

---

## Captura y video del dispositivo

En el menú **`⋯`** de cada tarjeta:

| Acción | Android | iOS (simulador) |
|---|---|---|
| Captura de pantalla | `adb exec-out screencap -p` | `simctl io <id> screenshot` |
| Grabar la pantalla | `adb shell screenrecord` + `adb pull` | `simctl io <id> recordVideo` |

Los archivos van a una carpeta temporal con nombre `<dispositivo>-<fecha>.png/mp4`,
y el aviso al terminar ofrece **Mostrar archivo** y **Copiar ruta**. Mientras
grabas, la tarjeta muestra un badge **REC** parpadeando; se detiene desde el mismo
menú `⋯`. Ambas herramientas cierran el archivo al recibir la señal de parada, no
antes, así que el video aparece un momento después.

---

## Instalar un APK

Dos caminos:

- Al terminar una compilación, la acción **Instalar en…** del aviso.
- En el menú `⋯` de un dispositivo Android, **Instalar un APK…**, que abre el
  selector de archivos.

Ambos hacen `adb -s <id> install -r`, y si Android responde `Failure [...]` te lo
muestra en vez de decir que todo salió bien.

---

## ADB por WiFi

Para soltar el cable, en dos pasos:

1. Con el teléfono conectado por USB: menú `⋯ → Habilitar ADB por WiFi`
   (`adb tcpip 5555`).
2. Desconecta el cable y usa el botón **WiFi…** de la barra de pestañas de
   dispositivos: escribe la IP y hace `adb connect <ip>:5555`.

Las IPs que hayas usado quedan guardadas (las últimas 8) y salen en una lista para
no volver a teclearlas.

---

## Hot reload al guardar

Apagado por defecto. Con `novasuiteRunner.reloadOnSave` en `true`, cada vez que
guardas un `.dart` dentro de `lib/` se manda hot reload a las apps corriendo de
**ese** proyecto. Guardar varios archivos de golpe dispara un solo reload
(300 ms de espera).

---

## Filtrar y guardar el log

La barra de pestañas de logs trae un campo **Filtrar…** que esconde las líneas que
no coinciden — se aplica también a lo que va llegando en vivo — y un botón
**Guardar**, que escribe la pestaña activa a un archivo de texto.

---

## Panel o barra lateral

La extensión se puede usar de dos formas, con el mismo estado en las dos:

- **Pestaña del editor** — `Cmd/Ctrl + Shift + P` → *NovaSuite Runner: Abrir panel*.
- **Barra lateral** — el icono de NovaSuite Runner en la barra de actividad.

Puedes tener las dos abiertas: comparten el daemon, las sesiones y los logs. El
daemon de dispositivos solo se apaga cuando cierras ambas.

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
| `novasuiteRunner.reloadOnSave` | `false` | Hot reload automático al guardar un `.dart` de `lib/` |

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

**Un simulador de iOS no arranca** y `simctl` responde
`launchd_sim may have crashed or quit responding`. Es CoreSimulator colgado, no el
simulador: mientras siga así no arranca ninguno. La extensión lo detecta al arrancar
y ofrece **Reiniciar y reintentar**, que mata
`com.apple.CoreSimulator.CoreSimulatorService` (macOS lo relanza solo) y vuelve a
intentar el boot. Cierra todos los simuladores abiertos. La misma acción está en el
menú `⋯ → Reparar` de un simulador que sí aparece en la lista.

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

```bash
# F5 desde la raíz del repo con la config "NovaSuite Runner (Extension Host)"
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
(alta y baja en tiempo real), el listado de simuladores por `simctl`, la
resolución del SDK de Android (`adb`, `emulator`), la captura de pantalla por
`adb exec-out screencap` sobre un teléfono real, y el empaquetado del `.vsix`.

**Sin verificar en vivo**, por orden de riesgo:

- **`⚡` hot reload y `⟳` hot restart**, y por lo tanto también el hot reload al
  guardar, que usa el mismo `app.restart`. El protocolo está implementado y el
  daemon acepta la conexión, pero nunca he visto ejecutarse un `app.restart`.
- **La generación de APK/AAB/IPA** de principio a fin, y con ella `Instalar en…`.
- **Grabar la pantalla**, DevTools, ADB por WiFi y la vista de barra lateral.

Lo que sí hice con todo lo anterior: cargar la extensión en Node con un stub de la
API de VS Code (activa y desactiva sin errores) y ejecutar los helpers puros con
las rutas reales de esta máquina.

### Un bug que salió en el camino

Al escribir estas features encontré que `adbBin()`, `androidEmulatorBin()` y
`androidSdkDir()` se usaban en todo el módulo pero **nunca estuvieron definidas**:
están así desde la primera versión publicada. Cualquier acción de emulador Android
o de reparación tiraba `ReferenceError` en vez de correr. Quedaron implementadas en
la 0.12.0, resolviendo el SDK desde `ANDROID_HOME`, `ANDROID_SDK_ROOT` y las rutas
por defecto de macOS, Linux y Windows.

## Licencia

MIT.
