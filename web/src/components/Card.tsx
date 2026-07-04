import { motion, type Transition, type Variants } from 'framer-motion'
import type { ComponentChildren } from 'preact'

// Shared entrance variants — children of CommandCenter's stagger container.
export const cardRise: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0 },
}
export const cardReveal: Transition = { duration: 0.5, ease: [0.22, 1, 0.36, 1] }

interface CardProps {
  title: string
  /** When set, the title becomes a link (opens in a new tab). */
  titleHref?: string
  className?: string
  actions?: ComponentChildren
  bodyClass?: string
  children: ComponentChildren
}

export function Card({ title, titleHref, className = '', actions, bodyClass = '', children }: CardProps) {
  return (
    <motion.section
      variants={cardRise}
      transition={cardReveal}
      className={`glass card ${className}`}
    >
      <header className="card__head">
        <span className="card__title hud-label">
          {titleHref ? (
            <a className="card__title-link" href={titleHref} target="_blank" rel="noopener noreferrer">
              {title}
            </a>
          ) : (
            title
          )}
        </span>
        {actions ? <div className="card__actions">{actions}</div> : null}
      </header>
      <div className={`card__body ${bodyClass}`}>{children}</div>
    </motion.section>
  )
}

export function EmptyState({ children }: { children: ComponentChildren }) {
  return <div className="empty-state">{children}</div>
}
