# Billar Finanzas (M&S) — Offline + PWA + Sync opcional

App web sin backend (HTML/CSS/JS) para controlar finanzas e inventario.

- **Offline por defecto**: guarda todo localmente en el navegador con **IndexedDB**.
- **Instalable (PWA)**: se puede instalar como app en Android/Windows/macOS (según navegador).
- **Sincronización opcional**: si tienes internet, puedes sincronizar entre dispositivos usando **WebDAV** (por ejemplo **Nextcloud**).

## Estructura

- `index.html`
- `assets/app.css`
- `assets/app.js`
- `manifest.webmanifest`
- `sw.js`

## Ejecutar en local (recomendado para pruebas)

> El Service Worker (PWA) no funciona bien con `file://`. Usa un servidor local.

Con Python:

```bash
python -m http.server 5173
```

Luego abre:

- `http://localhost:5173/`

## Instalar como aplicación (PWA)

En **Chrome/Edge**:

- Abre la app por `http://localhost:5173/` (o por HTTPS si la publicas).
- Usa el botón **Instalar** dentro de la app, o el menú del navegador → **Instalar app**.

Notas:
- Para instalar en otros equipos/teléfonos necesitas abrirla por **HTTPS** (o `localhost`).

## Publicar por HTTPS (opcional) con GitHub Pages

Para que sea instalable desde cualquier dispositivo por internet:

1. Ve a **Settings → Pages** en GitHub.
2. En **Build and deployment** selecciona **Deploy from a branch**.
3. Elige `main` y carpeta `/ (root)`.
4. Guarda.

GitHub te dará una URL tipo:

- `https://USUARIO.github.io/billar_finanzas/`

Esa versión ya sirve por HTTPS y es ideal para instalar en el celular.

## Guardado local (cómo funciona)

- Los datos se guardan en **IndexedDB**.
- Si borras datos del navegador o cambias de dispositivo, perderás los datos locales… a menos que:
  - exportes/importes JSON (backup manual), o
  - uses la sincronización WebDAV.

## Sincronización entre dispositivos (WebDAV / Nextcloud)

En **Config → Sincronización**:

- **URL WebDAV (archivo .json)**: apunta a un archivo remoto donde se guardará el JSON.
- **Usuario / Contraseña**: credenciales WebDAV.
- Botones:
  - **Probar**: valida acceso.
  - **Subir**: envía tus datos locales al remoto.
  - **Bajar**: trae los datos remotos y reemplaza tu estado local.
- **Auto-sync al abrir**: si hay internet, revisa si el remoto es más nuevo y lo aplica.

### Ejemplo Nextcloud

URL típica (ajusta servidor/usuario/ruta):

```
https://TU-SERVIDOR/remote.php/dav/files/USUARIO/ms_finanzas_sync.json
```

Recomendaciones:
- Usa una **App Password** (Nextcloud) en vez de tu contraseña principal.
- Usa siempre **HTTPS**.

### Conflictos / “quién gana”

- Antes de sobrescribir, la app compara timestamps (`updatedAt`).
- Si detecta que el remoto o lo local parece más reciente, pide confirmación.

> Nota: por simplicidad, la sincronización reemplaza el “estado completo”. Si más adelante quieres una sincronización que mezcle registros (merge por ID), se puede añadir.

## Seguridad

- La contraseña WebDAV se guarda **solo en este dispositivo** (en la base local del navegador).
- No se envía a ningún servidor propio de esta app; únicamente se usa para autenticar contra tu WebDAV.

## Licencia

Pendiente (agrega la licencia que prefieras).
