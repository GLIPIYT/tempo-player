import type { LucideIcon } from 'lucide-react'

interface StatCardProps {
  icon: LucideIcon
  value: string
  label: string
}

export default function StatCard({ icon: Icon, value, label }: StatCardProps) {
  return (
    <div className="stat-card">
      <div className="stat-icon">
        <Icon size={18} />
      </div>
      <div className="stat-body">
        <div className="stat-value">{value}</div>
        <div className="stat-label">{label}</div>
      </div>
    </div>
  )
}
