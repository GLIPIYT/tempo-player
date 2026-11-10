# Tempo system icons

The Windows application, installer, Start menu shortcut and tray use the current Pulse mark from `docs/brand/icon-concepts/variants/pulse-violet-cyan.png`. The tray reads Tauri's default window icon; it has no independent legacy artwork.

The generated native assets live in `src-tauri/icons`. `tauri.conf.json` includes `32x32.png`, `128x128.png` and the multi-resolution `icon.ico`. The top-level PNG, ICO and ICNS files were regenerated together with the installed Tauri CLI. The unused legacy frontend fallback at `src/assets/app-icon.png` was synchronized as well.

To regenerate the complete platform icon set from the same source:

```powershell
npm run tauri -- icon docs/brand/icon-concepts/variants/pulse-violet-cyan.png --output src-tauri/icons
```

The native package has one fixed brand icon; the title-bar mark can still follow the user's appearance settings. Updating source assets does not replace the icon embedded in an already installed executable or its existing Windows shortcut. Those receive the new artwork when that installation is updated.
