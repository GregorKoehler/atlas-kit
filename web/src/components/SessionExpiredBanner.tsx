import { useEffect, useState } from 'preact/hooks'
import { probeSession, relogin } from '../lib/api'

// App-wide safety net for an expired access session (Cloudflare Access, or any
// auth proxy in front of the dashboard). Every API call then bounces to a login
// page the cards cannot show, so the app reads as dead; this says why and
// offers the way back. Probed on start and whenever the app comes back to the
// foreground; offline (the probe threw) shows nothing, and an install with no
// proxy in front never sees it.
export function SessionExpiredBanner() {
  const [expired, setExpired] = useState(false)

  useEffect(() => {
    const check = () => {
      probeSession().then((s) => {
        if (s !== 'offline') setExpired(s === 'expired')
      })
    }
    const onVisible = () => {
      if (document.visibilityState === 'visible') check()
    }
    check()
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  if (!expired) return null
  return (
    <div className="session-expired" role="alert">
      <span>Session expired</span>
      <button type="button" className="session-expired__btn" onClick={relogin}>
        sign in again
      </button>
    </div>
  )
}
