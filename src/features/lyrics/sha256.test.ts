import { describe, expect, it } from 'vitest'
import { sha256Hex } from './sha256'

describe('browser synchronous SHA-256', () => {
  it.each([
    ['', 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'],
    ['abc', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad'],
    ['Привет 🌍', 'd415d2646823ba3dd5ca460a26bd0e0cc066770bbdff46c7517bf70336b01fde'],
  ])('hashes the UTF-8 bytes of %s', (input, expected) => {
    expect(sha256Hex(input)).toBe(expected)
  })
})
