// This pinned ORT release omits `types` from its package exports. Its public
// browser API uses the same declarations as onnxruntime-common.
declare module 'onnxruntime-web/wasm' {
  export * from 'onnxruntime-common'
}
