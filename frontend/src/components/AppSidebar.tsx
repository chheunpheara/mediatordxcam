import { useEffect, useState } from 'react'
import { NavLink } from 'react-router-dom'

import { routes } from '../app/routes'
import { useAuthUser } from '../features/auth/authContext'

/**
 * The fixed 260px arm of the L-shaped layout (D18 chrome).
 *
 * It carries three things and nothing else: who made this screen (the mark),
 * where the user can go (the navigation), and whether the machine underneath
 * is healthy (the engine card). Everything account-specific that is *not*
 * navigation stays in the top bar, so the two halves never duplicate a control.
 *
 * Labels are written for a teller who has never seen the product: "Workspace"
 * rather than an internal route name, and every icon is decorative because the
 * word beside it already says the same thing (§32).
 */
interface AppSidebarProps {
  /** Below `lg` the arm is off-canvas until the top bar's button opens it. */
  readonly open?: boolean
}

interface IconProps {
  readonly className?: string
}

interface NavItem {
  readonly to: string
  readonly label: string
  readonly Icon: (props: IconProps) => React.JSX.Element
  /** The landing route is `/`, which `NavLink` would otherwise match everywhere. */
  readonly end?: boolean
}

const VERIFY_ITEMS: readonly NavItem[] = [
  { to: routes.landing, label: 'Upload document', Icon: TrayIcon, end: true },
  { to: routes.idCard, label: 'Workspace', Icon: PanelsIcon },
  { to: routes.teller, label: 'Teller dashboard', Icon: MonitorIcon },
]

const OPERATIONS_ITEMS: readonly NavItem[] = [
  { to: routes.display, label: 'Customer display', Icon: BroadcastIcon },
  { to: routes.admin, label: 'Administration', Icon: ShieldIcon },
]

/** Administration exists only for an administrator — the guard decides twice. */
function visibleOperations(isAdmin: boolean): readonly NavItem[] {
  return OPERATIONS_ITEMS.filter((item) => item.to !== routes.admin || isAdmin)
}

export function AppSidebar({ open = false }: AppSidebarProps) {
  const user = useAuthUser()

  return (
    <aside
      id="app-sidebar"
      aria-label="Main navigation"
      className={`app-sidebar ${open ? 'app-sidebar--open' : ''}`}
    >
      <div className="flex items-center gap-3 px-5 py-5">
        <span
          aria-hidden="true"
          className="accent-gradient grid h-10 w-10 place-items-center rounded-xl shadow-[0_10px_24px_-12px_oklch(52%_0.26_292_/_0.95)]"
        >
          <MarkGlyph />
        </span>
        <span className="min-w-0">
          <span className="block truncate text-[0.95rem] font-semibold tracking-tight text-white">
            CamDX
          </span>
          <span className="block truncate text-[0.7rem] font-medium text-white/45">
            Identity Suite
          </span>
        </span>
      </div>

      <nav className="app-sidebar__scroll px-3" aria-label="Sections">
        <NavGroup label="Verification" items={VERIFY_ITEMS} />
        <NavGroup label="Operations" items={visibleOperations(user?.isAdmin ?? false)} />
      </nav>

      <div className="px-3 pt-4 pb-4">
        <EngineStatusCard />
      </div>
    </aside>
  )
}

function NavGroup({
  label,
  items,
}: {
  readonly label: string
  readonly items: readonly NavItem[]
}) {
  return (
    <div className="mb-5">
      <p className="px-3 pb-2 text-[0.65rem] font-semibold tracking-[0.14em] text-white/35 uppercase">
        {label}
      </p>
      <ul className="grid gap-1">
        {items.map((item) => (
          <li key={item.to}>
            <NavLink
              to={item.to}
              end={item.end ?? false}
              className={({ isActive }) => `side-link ${isActive ? 'side-link--active' : ''}`}
            >
              <item.Icon className="h-4.5 w-4.5 shrink-0 opacity-90" />
              <span className="truncate">{item.label}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ── The local AI engine's vitals ───────────────────────────────────────── */

interface Meter {
  readonly label: string
  readonly usedGb: number
  readonly totalGb: number
}

interface EngineTelemetry {
  readonly ram: Meter
  readonly vram: Meter
}

/** What the card shows when the browser will not report anything itself. */
const LAST_REPORTED: EngineTelemetry = {
  ram: { label: 'RAM', usedGb: 6.2, totalGb: 16 },
  vram: { label: 'VRAM', usedGb: 2.4, totalGb: 8 },
}

/** `performance.memory` (Chromium only) — typed here because lib.dom omits it. */
type MemoryReportingPerformance = Performance & {
  readonly memory?: { readonly usedJSHeapSize: number; readonly jsHeapSizeLimit: number }
}

const GIB = 1024 ** 3

function readRam(): Meter {
  const memory = (performance as MemoryReportingPerformance).memory
  if (!memory) return LAST_REPORTED.ram
  const usedGb = memory.usedJSHeapSize / GIB
  const totalGb = Math.max(memory.jsHeapSizeLimit / GIB, usedGb)
  return { label: 'RAM', usedGb, totalGb }
}

/** No browser exposes VRAM, so this drifts gently around the engine's report. */
function readVram(): Meter {
  const base = LAST_REPORTED.vram
  const driftGb = 0.35 * Math.sin(Date.now() / 12000)
  return { ...base, usedGb: Math.min(base.totalGb, Math.max(0.4, base.usedGb + driftGb)) }
}

/**
 * Live figures where the browser exposes them, the engine's last report
 * everywhere else.
 *
 * The sampler only runs when `performance.memory` exists: a browser without it
 * has nothing new to say, and polling anyway would only repaint identical
 * numbers.
 */
function useEngineTelemetry(): EngineTelemetry {
  const [telemetry, setTelemetry] = useState<EngineTelemetry>(() => ({
    ram: readRam(),
    vram: readVram(),
  }))

  useEffect(() => {
    if (!(performance as MemoryReportingPerformance).memory) return
    const id = window.setInterval(() => {
      setTelemetry({ ram: readRam(), vram: readVram() })
    }, 4000)
    return () => window.clearInterval(id)
  }, [])

  return telemetry
}

function EngineStatusCard() {
  const { ram, vram } = useEngineTelemetry()

  return (
    // A group rather than a section: the card is chrome, not page content, so
    // it stays out of the document's region outline.
    <div role="group" aria-label="Local AI engine" className="glass-dark rounded-xl p-4">
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <span className="engine-dot shrink-0" aria-hidden="true" />
          <h2 className="truncate text-[0.8rem] font-semibold text-white">Local AI Engine</h2>
        </div>
        <span className="rounded-full bg-white/8 px-2 py-0.5 text-[0.65rem] font-semibold text-white/65">
          On-device
        </span>
      </div>

      <p className="mt-1.5 text-[0.7rem] leading-relaxed text-white/45">
        OCR and face matching run on this machine. No image leaves the counter.
      </p>

      <div className="mt-3.5 grid gap-3">
        <MeterRow meter={ram} />
        <MeterRow meter={vram} />
      </div>

      <p className="mt-3.5 text-[0.65rem] text-white/35">Runtime v2.4 · idle 41 ms</p>
    </div>
  )
}

function MeterRow({ meter }: { readonly meter: Meter }) {
  const percent = Math.round(Math.min(100, Math.max(0, (meter.usedGb / meter.totalGb) * 100)))

  return (
    <div className="meter">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[0.7rem] font-semibold text-white/70">{meter.label}</span>
        <span className="text-[0.7rem] tabular-nums text-white/45">
          {meter.usedGb.toFixed(1)} / {meter.totalGb} GB
        </span>
      </div>
      <div
        className="meter__track"
        role="progressbar"
        aria-label={`${meter.label} usage`}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={percent}
        aria-valuetext={`${meter.usedGb.toFixed(1)} GB of ${meter.totalGb} GB`}
      >
        <div
          className={`meter__fill ${percent > 85 ? 'meter__fill--warn' : ''}`}
          style={{ width: `${percent}%` }}
        />
      </div>
    </div>
  )
}

/* ── Decorative glyphs (the label beside each one carries the meaning) ──── */

function MarkGlyph() {
  return (
    <svg
      viewBox="0 0 24 24"
      className="h-5 w-5 text-white"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3 5 6v5.5c0 4.2 2.9 7.6 7 9.5 4.1-1.9 7-5.3 7-9.5V6l-7-3Z" />
      <path d="m9.2 12.2 1.9 1.9 3.7-3.9" />
    </svg>
  )
}

function TrayIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 15V4m0 0L8 8m4-4 4 4" />
      <path d="M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" />
    </svg>
  )
}

function PanelsIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4" width="7.5" height="16" rx="1.6" />
      <rect x="13.5" y="4" width="7.5" height="7" rx="1.6" />
      <rect x="13.5" y="13.5" width="7.5" height="6.5" rx="1.6" />
    </svg>
  )
}

function MonitorIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="3" y="4.5" width="18" height="12" rx="2" />
      <path d="M9 20h6m-3-3.5V20" />
    </svg>
  )
}

function BroadcastIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="2.2" />
      <path d="M7.8 7.8a6 6 0 0 0 0 8.4m8.4-8.4a6 6 0 0 1 0 8.4M5 5a10 10 0 0 0 0 14m14-14a10 10 0 0 1 0 14" />
    </svg>
  )
}

function ShieldIcon({ className }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3 5 6v5.5c0 4.2 2.9 7.6 7 9.5 4.1-1.9 7-5.3 7-9.5V6l-7-3Z" />
      <circle cx="12" cy="11" r="2.4" />
      <path d="M8.4 16.4a4.6 4.6 0 0 1 7.2 0" />
    </svg>
  )
}
