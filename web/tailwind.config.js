/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // Surfaces / background ramp
        bg: {
          900: 'var(--bg-900)',
          850: 'var(--bg-850)',
          800: 'var(--bg-800)',
          750: 'var(--bg-750)',
        },
        // Cyan/teal accent family — used sparingly
        accent: {
          DEFAULT: 'var(--accent)',
          teal: 'var(--accent-teal)',
          dim: 'var(--accent-dim)',
        },
        secondary: 'var(--secondary)',
        hairline: 'var(--hairline)',
        // Text ramp
        hud: {
          bright: 'var(--text-bright)',
          DEFAULT: 'var(--text)',
          dim: 'var(--text-dim)',
          faint: 'var(--text-faint)',
        },
        // Status (desaturated)
        status: {
          green: 'var(--status-green)',
          amber: 'var(--status-amber)',
          red: 'var(--status-red)',
        },
      },
      fontFamily: {
        display: ['"Chakra Petch"', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        body: ['Saira', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'monospace'],
      },
      boxShadow: {
        glow: '0 0 24px var(--glow-cyan)',
        'glow-sm': '0 0 12px var(--glow-cyan)',
        panel: '0 10px 40px rgba(0, 0, 0, 0.45)',
      },
      borderRadius: {
        panel: '14px',
      },
      letterSpacing: {
        hud: '0.18em',
      },
    },
  },
  plugins: [],
}
