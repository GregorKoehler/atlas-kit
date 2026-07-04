import type { ComponentChildren } from 'preact'

interface Props {
  name?: string
  className?: string
}

function Svg({ children, className }: { children: ComponentChildren; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? 'h-5 w-5'}
      aria-hidden="true"
    >
      {children}
    </svg>
  )
}

/** Small inline icon set (stroke = currentColor). Falls back to a diamond. */
export function Icon({ name, className }: Props) {
  switch (name) {
    case 'sun':
      return (
        <Svg className={className}>
          <circle cx="12" cy="12" r="4" />
          <path d="M12 2v2M12 20v2M2 12h2M20 12h2M5 5l1.4 1.4M17.6 17.6L19 19M19 5l-1.4 1.4M6.4 17.6L5 19" />
        </Svg>
      )
    case 'terminal':
      return (
        <Svg className={className}>
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </Svg>
      )
    case 'zap':
      return (
        <Svg className={className}>
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
        </Svg>
      )
    case 'doc':
      return (
        <Svg className={className}>
          <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
          <polyline points="14 3 14 8 19 8" />
        </Svg>
      )
    case 'search':
      return (
        <Svg className={className}>
          <circle cx="11" cy="11" r="7" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </Svg>
      )
    case 'book':
      return (
        <Svg className={className}>
          <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
          <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
        </Svg>
      )
    default:
      return (
        <Svg className={className}>
          <rect x="6.5" y="6.5" width="11" height="11" rx="2.5" transform="rotate(45 12 12)" />
        </Svg>
      )
  }
}
