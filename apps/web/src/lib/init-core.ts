/**
 * Inicialización de @calistenia/core para web.
 *
 * DEBE ser de los primeros imports de main.tsx (solo después de Sentry):
 * los módulos de core leen el platform adapter al evaluarse.
 */
import * as Sentry from '@sentry/react'
import { OpenPanel } from '@openpanel/web'
import { initCore } from '@calistenia/core/platform'
import { shouldSendAnalytics } from '@calistenia/core/lib/analytics'

// Session replay (rrweb) solo en builds de producción y navegadores reales:
// el e2e de CI corre contra el bundle de prod con `vite preview`, y no queremos
// grabaciones de Playwright en el panel. navigator.webdriver los descarta.
const replayEnabled =
  !import.meta.env.DEV && typeof navigator !== 'undefined' && !navigator.webdriver

const openPanelClientId = import.meta.env.VITE_OPENPANEL_CLIENT_ID

const op = openPanelClientId
  ? new OpenPanel({
      apiUrl: import.meta.env.VITE_OPENPANEL_API_URL || 'https://openpanel.guille.tech/api',
      clientId: openPanelClientId,
      trackScreenViews: true,
      trackOutgoingLinks: true,
      trackAttributes: true,
      filter: shouldSendAnalytics,
      sessionReplay: {
        enabled: replayEnabled,
        unmaskTextSelector: '[data-op-unmask]',
      },
    })
  : null

if (openPanelClientId && typeof window !== 'undefined') {
  fetch(import.meta.env.VITE_OPENPANEL_API_URL || 'https://openpanel.guille.tech/api', { method: 'HEAD', mode: 'no-cors' }).catch(() => {
    console.warn('[analytics] OpenPanel endpoint unreachable — events may be blocked by ad blocker or network issue')
  })
}

initCore({
  storage: localStorage,
  // Estado de una sola sesión (snapshot de carrera): F5 lo conserva, cerrar la pestaña no.
  sessionStorage,
  env: {
    // Vacío en prod o dev con proxy → window.location.origin permite acceso desde cualquier dispositivo (tablet/móvil/túnel)
    pbUrl: import.meta.env.VITE_POCKETBASE_URL || (typeof window !== 'undefined' ? window.location.origin : 'http://127.0.0.1:8090'),
    // Vacío en dev → el proxy de Vite maneja /api/*
    aiApiUrl: import.meta.env.VITE_AI_API_URL || (import.meta.env.DEV ? '' : 'https://gym-server.guille.tech'),
    isDev: import.meta.env.DEV,
    // Identidad del cliente → cabeceras X-App-* en cada request a PocketBase.
    // `build: 0` a propósito: la web no tiene builds instalados que puedan
    // quedarse atrás (el service worker en modo prompt ya la actualiza sola), y
    // `evaluateUpdate` trata el 0 como "nunca bloquear". La versión sigue
    // viajando para poder correlacionar un bug con un deploy concreto.
    client: { version: __APP_VERSION__, build: 0, platform: 'web' },
  },
  analytics: {
    track: (name, properties) => op?.track(name, properties),
    // El payload del facade es laxo; OpenPanel exige profileId — los callers de core siempre lo mandan.
    identify: (payload) => {
      op?.identify(payload as Parameters<typeof op.identify>[0])
      // Cruce OpenPanel↔Sentry: el mismo id de PocketBase en los dos lados.
      // Sin esto Sentry solo tiene la IP y cruzar una sesión del panel con un
      // issue era «mismo dispositivo + misma hora». Solo el id, nada de PII.
      const profileId = (payload as { profileId?: string }).profileId
      if (profileId) Sentry.setUser({ id: profileId })
    },
    clear: () => {
      op?.clear()
      Sentry.setUser(null)
    },
  },
  reportError: (e, context) => Sentry.captureException(e, context),
  lifecycle: {
    isForeground: () => document.visibilityState === 'visible',
    onForeground: (handler) => {
      const onVisibility = () => {
        if (document.visibilityState === 'visible') handler()
      }
      document.addEventListener('visibilitychange', onVisibility)
      return () => document.removeEventListener('visibilitychange', onVisibility)
    },
    onBackground: (handler) => {
      const onVisibility = () => {
        if (document.visibilityState === 'hidden') handler()
      }
      document.addEventListener('visibilitychange', onVisibility)
      return () => document.removeEventListener('visibilitychange', onVisibility)
    },
  },
  connectivity: {
    isOnline: () => navigator.onLine,
    onOnline: (handler) => {
      window.addEventListener('online', handler)
      return () => window.removeEventListener('online', handler)
    },
    onChange: (handler) => {
      const on = () => handler(true)
      const off = () => handler(false)
      window.addEventListener('online', on)
      window.addEventListener('offline', off)
      return () => {
        window.removeEventListener('online', on)
        window.removeEventListener('offline', off)
      }
    },
  },
})
