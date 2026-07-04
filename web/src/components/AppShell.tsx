import { useEffect, useState } from 'preact/hooks'
import { motion, type Transition, type Variants } from 'framer-motion'
import { TabBar, type TabId } from './TabBar'
import { useAgentFocus } from '../lib/agentFocus'
import { CommandCenter } from './CommandCenter'
import { AtlasCenter } from './AtlasCenter'
import { ThemeSwitcher } from './ThemeSwitcher'
import { AsciiBackdrop } from './AsciiBackdrop'

// One tasteful staggered reveal on load. No looping animation — this runs
// on a TV all day, so motion is strictly entrance-only.
const container: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1 },
}
const stagger: Transition = { staggerChildren: 0.08, delayChildren: 0.06 }

const rise: Variants = {
  hidden: { opacity: 0, y: 10 },
  show: { opacity: 1, y: 0 },
}
const reveal: Transition = { duration: 0.55, ease: [0.22, 1, 0.36, 1] }

export function AppShell() {
  const [active, setActive] = useState<TabId>('command')

  // Clicking an agent node (the hero overview, the Atlas constellation, or the
  // full-screen switcher strip) jumps to the tab where that agent's card lives;
  // the matching row then full-screens itself.
  const focus = useAgentFocus()
  useEffect(() => {
    if (focus) setActive(focus.tab)
  }, [focus?.n])

  return (
    <div
      className="app-bg scanlines relative flex min-h-screen flex-col text-hud"
      data-active-tab={active}
    >
      <AsciiBackdrop />
      <span className="corner corner--tl" />
      <span className="corner corner--tr" />
      <span className="corner corner--bl" />
      <span className="corner corner--br" />

      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        transition={stagger}
        className="relative z-10 flex min-h-screen flex-col"
      >
        <motion.header
          variants={rise}
          transition={reveal}
          className="glass relative z-30 mx-4 mt-4 flex flex-wrap items-center justify-between gap-x-8 gap-y-3 px-6 py-3.5 sm:mx-6 sm:mt-6"
        >
          <div className="flex items-center gap-3">
            <AtlasMark />
            <div className="leading-none">
              <div className="hud-label glow-text text-[1.05rem] text-hud-bright">Atlas Kit</div>
            </div>
          </div>

          <TabBar active={active} onSelect={setActive} />

          <ThemeSwitcher />
        </motion.header>

        <motion.main variants={rise} transition={reveal} className="relative mt-4 flex-1 sm:mt-6">
          {active === 'command' ? <CommandCenter /> : <AtlasCenter />}
        </motion.main>
      </motion.div>
    </div>
  )
}

// The Atlas "A" mark — same glyph as the favicon. Stroke + glow read from the
// theme tokens so it goes cyan in the HUD theme and coral in the Claude theme.
function AtlasMark() {
  return (
    <svg
      viewBox="0 0 100 100"
      className="h-8 w-8 shrink-0"
      fill="none"
      stroke="var(--accent)"
      strokeWidth={11}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      style={{ filter: 'drop-shadow(0 0 6px var(--glow-cyan-strong))' }}
    >
      <path d="M20 82 L50 18 L80 82" />
      <path d="M32 58 H68" />
    </svg>
  )
}
