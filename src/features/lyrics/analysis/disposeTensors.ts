/** Release each unique inference tensor once, even when several outputs alias it. */
export function disposeTensors(values: readonly unknown[]): void {
  const disposed = new Set<object>()
  for (const value of values) {
    if (typeof value !== 'object' || value === null || disposed.has(value)) continue
    const tensor = value as { dispose?: unknown }
    if (typeof tensor.dispose !== 'function') continue
    disposed.add(value)
    try { (tensor.dispose as () => void).call(value) } catch { /* Release the remaining outputs as well. */ }
  }
}
