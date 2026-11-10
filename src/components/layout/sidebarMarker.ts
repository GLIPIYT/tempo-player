/** The marker stays inset from the active row's top and bottom edges. */
const MARKER_INSET = 6

export interface SidebarRowLayout {
  left: number
  top: number
  height: number
}

export interface SidebarMarkerLayout {
  x: number
  y: number
  height: number
}

/**
 * Convert a row's layout coordinates to the sidebar marker's local coordinates.
 * Both `.side-item` buttons and the marker use the positioned `.sidebar` as their
 * offset/containing block, so these values are already in the same CSS-pixel
 * space. This avoids mixing zoomed client rectangles with layout-space transforms.
 */
export function sidebarMarkerLayout(row: SidebarRowLayout): SidebarMarkerLayout {
  return {
    x: row.left,
    y: row.top + MARKER_INSET,
    height: Math.max(0, row.height - MARKER_INSET * 2),
  }
}
