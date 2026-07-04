import { motion, type Transition, type Variants } from 'framer-motion'

export type TabId = 'command' | 'atlas'

export const TABS: { id: TabId; label: string; short: string }[] = [
  { id: 'command', label: 'Home', short: 'Home' },
  { id: 'atlas', label: 'Atlas', short: 'Atlas' },
]

const item: Variants = {
  hidden: { opacity: 0, y: 6 },
  show: { opacity: 1, y: 0 },
}
const reveal: Transition = { duration: 0.45, ease: [0.22, 1, 0.36, 1] }

interface Props {
  active: TabId
  onSelect: (id: TabId) => void
}

export function TabBar({ active, onSelect }: Props) {
  return (
    <nav className="order-last flex w-full items-center justify-between gap-2 sm:order-none sm:w-auto sm:justify-start sm:gap-8">
      {TABS.map((t) => (
        <motion.button
          key={t.id}
          variants={item}
          transition={reveal}
          type="button"
          onClick={() => onSelect(t.id)}
          aria-current={active === t.id ? 'page' : undefined}
          className={`hud-tab ${active === t.id ? 'hud-tab--active' : ''}`}
        >
          <span className="sm:hidden">{t.short}</span>
          <span className="hidden sm:inline">{t.label}</span>
        </motion.button>
      ))}
    </nav>
  )
}
