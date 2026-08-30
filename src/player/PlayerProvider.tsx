import type { ReactNode } from 'react'
import { playerContext, usePlayerValue } from './usePlayer'

export default function PlayerProvider({ children }: { children: ReactNode }) {
  const value = usePlayerValue()
  return <playerContext.Provider value={value}>{children}</playerContext.Provider>
}
