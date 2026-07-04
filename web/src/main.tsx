import { render } from 'preact'
import './styles/fonts.css'
import './styles/tokens.css'
import './styles/index.css'
import { AppShell } from './components/AppShell'
import { applyTheme, getTheme } from './lib/theme'

// Apply the saved theme before first paint to avoid a flash of the default.
applyTheme(getTheme())

const root = document.getElementById('app')
if (root) render(<AppShell />, root)
