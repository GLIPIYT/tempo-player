import type { LucideIcon } from 'lucide-react'

export default function HomeSectionTitle({ icon: Icon, children }: { icon: LucideIcon; children: string }) {
  return (
    <h2 className="home-section-title">
      <Icon size={16} strokeWidth={1.8} aria-hidden="true" />
      <span>{children}</span>
    </h2>
  )
}
