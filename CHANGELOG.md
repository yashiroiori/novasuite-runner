# Changelog

Todas las versiones notables de NovaSuite Runner.

## [0.12.3] — 2026-08-28

### Arreglado
- **Instalar runtime** mandaba `xcodebuild -downloadPlatform iOS -buildVersion X`,
  que no existe antes de Xcode 16: fallaba con `invalid option '-buildVersion'`.
  Ahora se comprueba si el flag esta disponible y, si no, se baja el runtime mas
  nuevo que soporte ese Xcode avisando que puede no ser el que se pidio.

## [0.12.2] — 2026-08-21

### Agregado
- Los simuladores de iOS cuyo runtime ya no esta instalado dejan de ocultarse:
  salen en gris como **NO DISPONIBLE**, con el motivo que reporta `simctl` y
  botones para bajar el runtime (`xcodebuild -downloadPlatform`) o borrar los
  registros muertos (`simctl delete unavailable`).

## [0.12.1] — 2026-08-21

### Cambiado
- El README ya no dibuja la interfaz en ASCII: la captura del panel la muestra
  mejor y el dibujo se habia quedado viejo (no traia el menu de app ni DevTools).

## [0.12.0] — 2026-08-20

### Agregado
- **Perfiles de ejecucion por app**: modo (debug/profile/release), flavor y
  `--dart-define`, recordados entre sesiones y visibles en el subtitulo de la app.
- **Menu de app** (`⚒`) con tres grupos: Correr (perfil, correr en los favoritos
  conectados, correr en todos los activos), Compilar (APK, split-per-abi, debug,
  App Bundle, IPA) y Mantenimiento (`clean`, `pub get`, `doctor -v`).
- **Menu de dispositivo** (`⋯`): captura de pantalla, grabacion de video, instalar
  un APK, ADB por WiFi y las acciones de reparacion que ya existian.
- **DevTools** (`◈`) por sesion, abriendo la URL del VM service en el navegador.
- **Hot reload al guardar**, opcional (`novasuiteRunner.reloadOnSave`).
- **Filtro de apps** y **filtro + guardado del log** a un archivo.
- La misma UI **tambien vive en la barra lateral**, no solo en el panel.

### Arreglado
- `adbBin()`, `androidEmulatorBin()` y `androidSdkDir()` se usaban en todo el
  modulo pero nunca estuvieron definidas: cualquier accion de emulador Android o
  de reparacion tiraba `ReferenceError`. Ahora resuelven el SDK desde
  `ANDROID_HOME`, `ANDROID_SDK_ROOT` y las rutas por defecto de cada plataforma.

## [0.11.6] — 2026-08-20

### Agregado
- Generar el instalable desde el panel: cada app tiene un boton `⚒` que abre un
  menu con APK release, APK por arquitectura (`--split-per-abi`), APK debug,
  App Bundle y, en macOS, IPA.
- La compilacion transmite su salida a una pestana propia del panel de logs, se
  puede cancelar, y al terminar avisa el peso del archivo con acciones para
  revelarlo en el Finder o copiar su ruta.

## [0.11.5] — 2026-08-20

### Arreglado
- Arrancar un simulador de iOS ya no muere con el error crudo de `simctl` cuando
  CoreSimulator se cuelga (`launchd_sim may have crashed`, POSIX 60): la extension
  lo detecta y ofrece reiniciar el servicio y reintentar el arranque.
- Un simulador que ya estaba arrancado deja de reportarse como error; solo trae la
  ventana al frente.

### Agregado
- Captura del panel en el README.

## [0.11.4] — 2026-08-20

### Cambiado
- Publisher `yashiroiori` y enlaces al repositorio publico
  `yashiroiori/novasuite-runner`.
- Licencia MIT, changelog y datos genericos en los ejemplos del README.

## [0.11.0] — 2026-08-20

### Agregado
- Icono de la extension (`media/icon.png`) y banner de galeria.
- README completo con todos los features y como usarlos.

## [0.10.0] — 2026-08-20

### Agregado
- Pestaña **Favoritos**: marca dispositivos con `☆` para tenerlos a la mano.
  Los emuladores favoritos aparecen encendidos o apagados; los fisicos, solo
  cuando estan conectados. Se guardan en `globalState`, con el ID del AVD para
  que sobrevivan a los reinicios del emulador.
- La pestaña Favoritos tambien acepta arrastrar y soltar apps.

## [0.9.1] — 2026-08-20

### Cambiado
- El boton de configuracion pasa a la barra superior, junto a Refrescar, como
  icono de engrane. Se elimina el pie de la barra lateral.

## [0.9.0] — 2026-08-20

### Agregado
- Divisores arrastrables para el ancho de la lista de apps (150–480px) y el
  alto de los logs (60px hasta el 80% de la ventana), con doble click para
  restaurar. Los tamaños persisten entre sesiones.

## [0.8.0]

### Agregado
- Simuladores de iOS en la pestaña Inactivos, leidos con `xcrun simctl` porque
  el daemon de Flutter solo reporta un `apple_ios_simulator` generico.
- Dispositivos activos agrupados en Fisicos / Emuladores / Escritorio y web.

## [0.7.0]

### Agregado
- Deteccion instantanea de dispositivos via `flutter daemon` persistente
  (`device.added` / `device.removed`), en lugar de sondeo cada 8s.
- Acciones de reparacion (`⋯`): reiniciar, arranque en frio, borrar datos,
  reiniciar ADB o CoreSimulator.

## [0.6.0]

### Agregado
- Iconos de app leidos de `flutter_launcher_icons` en el `pubspec.yaml`.

### Corregido
- Las tarjetas de dispositivo ahora listan todas las apps corriendo en el, sin
  importar cual este seleccionada en la barra lateral.

## [0.5.0]

### Agregado
- Arrastrar y soltar una app sobre un dispositivo para correrla ahi.

## [0.1.0]

- Primera version: lista de apps del workspace, dispositivos activos e
  inactivos, correr / hot reload / restart / stop, y logs por instancia.
