# Changelog

Todas las versiones notables de NovaSuite Runner.

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
