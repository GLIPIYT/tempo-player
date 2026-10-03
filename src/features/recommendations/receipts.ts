/** Bounded no-repeat receipts. Bloom false positives suppress extra discoveries;
 * the summary is never reset/rotated within a session, so old receipts do not
 * become eligible merely because their exact key left the recent window. */
export const RECEIPT_RECENT_LIMIT = 512
export const RECEIPT_BYTES = 32_768
const HASH_COUNT = 4
export interface ReceiptState { recent: string[]; summary: string }

export class RecommendationReceipts {
  private recent = new Set<string>()
  private summary: Uint8Array
  constructor(private readonly bytes = RECEIPT_BYTES) { this.summary = new Uint8Array(bytes) }
  private positions(key: string): number[] {
    let a = 2166136261, b = 5381
    for (const character of key) {
      a = Math.imul(a ^ character.charCodeAt(0), 16777619)
      b = Math.imul(b, 33) ^ character.charCodeAt(0)
    }
    const step = (b >>> 0) | 1
    return Array.from({ length: HASH_COUNT }, (_, index) => ((a >>> 0) + index * step) >>> 0)
      .map(value => value % (this.bytes * 8))
  }
  has(key: string): boolean {
    return this.recent.has(key) || this.positions(key).every(position => (this.summary[position >>> 3] & (1 << (position & 7))) !== 0)
  }
  add(key: string) {
    for (const position of this.positions(key)) this.summary[position >>> 3] |= 1 << (position & 7)
    this.recent.delete(key)
    this.recent.add(key)
    if (this.recent.size > RECEIPT_RECENT_LIMIT) this.recent.delete(this.recent.values().next().value!)
  }
  keys(): string[] { return [...this.recent] }
  clear() { this.recent.clear(); this.summary.fill(0) }
  snapshot(): ReceiptState {
    let binary = ''
    for (const byte of this.summary) binary += String.fromCharCode(byte)
    return { recent: this.keys(), summary: btoa(binary) }
  }
  restore(state: ReceiptState) {
    if (state.recent.length > RECEIPT_RECENT_LIMIT) throw new Error('Invalid receipt window')
    const binary = atob(state.summary)
    if (binary.length !== this.bytes) throw new Error('Invalid receipt summary')
    this.summary = Uint8Array.from(binary, character => character.charCodeAt(0))
    this.recent = new Set(state.recent)
    // Preserve membership even when decoding an older inconsistent exact window.
    for (const key of this.recent) for (const position of this.positions(key)) this.summary[position >>> 3] |= 1 << (position & 7)
  }
}
