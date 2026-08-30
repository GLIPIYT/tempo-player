type Listener = () => void

let version = 0
const listeners = new Set<Listener>()

export const libraryVersion = {
  get: () => version,
  bump: () => {
    version += 1
    listeners.forEach((l) => l())
  },
  subscribe: (l: Listener) => {
    listeners.add(l)
    return () => {
      listeners.delete(l)
    }
  },
}

export const bumpLibraryVersion = libraryVersion.bump
