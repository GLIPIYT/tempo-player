# Profile and small dialogs — design preview

Standalone interactive preview: `/docs/design/profile-redesign/index.html` on the existing Vite server. No database or audio requests. No replacement of the production profile until a variant is selected.

## Direction

Use Tempo's existing font and music artwork, translucent charcoal surfaces, restrained separators, icon controls, cherry-pink focus states and blur behind dialogs. Palette: charcoal `#151017`, raised `#211a24`, text `#f4f0f4`, muted `#a49aa8`, accent `#f14d78`, destructive `#bd394e`. The profile should read as a listening history, with the user's music carrying the identity rather than decorative copy.

- **A · Air:** horizontal passport, open statistics and two-column listening history. Small dialogs place the action and input directly in one quiet vertical column.
- **B · Focus:** a compact identity rail beside the listening chart and lists. Dialogs use a narrow artwork rail to distinguish the selected playlist from the form/action.
- **C · Panorama:** a broad artwork-backed identity header, a shared statistics strip and wide chart. Dialogs carry a short artwork header and a calm form beneath.

All three keep the same real product labels, sample library covers, editable nickname, graph periods, playable preview rows, playlist creation and deletion confirmations. Actions change only preview state. Dialogs trap keyboard focus, dismiss on Escape or backdrop, restore focus and animate both entering and leaving. Respect reduced motion. Responsive layouts collapse rails and columns without truncating controls.

Checks requested for this task are static/type/build checks only; no browser, screenshot or visual verification was performed.
