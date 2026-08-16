import React, { useRef, useSyncExternalStore, useState } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientContext, SettingsScope, SessionId, UseProjection } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-session-projection/types'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /** Per-session autonomy override (null = inherits the settings default). */
    autonomy: { level: AutonomyLevel | null }
  }
}

export const name = 'autonomy-client'
// `remote.commands` MUST be declared for the typert commands namespace to be
// mounted on `ctx.remote.commands` — without it the slider's /autonomy
// alignment throws (same trap the OMD switcher hit).
export const inject = ['slots', 'settingsScope', 'remote', 'remote.commands']

type AutonomyLevel = 'strict' | 'heed' | 'normal' | 'creative' | 'wild'

interface AutonomySettings {
  level: AutonomyLevel
}

const LEVELS: { id: AutonomyLevel; label: string; description: string }[] = [
  { id: 'strict', label: '严格遵循', description: '只做字面请求，歧义即停问，工具调用最小化' },
  { id: 'heed', label: '听取要求', description: '忠实执行请求范围，不做请求之外的事' },
  { id: 'normal', label: '正常发挥', description: 'DSH 出厂行为，不加任何干预' },
  { id: 'creative', label: '展现创造', description: '主动指出改进点与替代方案，适度额外工作' },
  { id: 'wild', label: '天马行空', description: '先说明再动手，自由探索并主动增强' },
]

function labelOf(level: AutonomyLevel): string {
  return LEVELS.find((l) => l.id === level)?.label ?? level
}

function useScope<T>(scope: SettingsScope<T>) {
  return useSyncExternalStore(
    (cb) => scope.subscribe(cb),
    () => scope.getSnapshot(),
  )
}

/**
 * Composer tool-row autonomy switcher, rendered immediately left of the model
 * seat (conversation.input.right with the highest order). Shows the CURRENT
 * session's effective level (per-session autonomy projection ?? settings
 * default) and switches it through the /autonomy command — per-session,
 * never global. Failures are never silent: the button shows a ⚠ mark with
 * the error as its tooltip.
 *
 * The trigger mimics the model selector's toolbar trigger (transparent,
 * label-secondary text, hover fill), and the panel stays open until the user
 * clicks outside (dismiss overlay) — picking a level never closes it, so the
 * slider can be dragged repeatedly.
 */
function AutonomyControl(props: {
  sessionId: SessionId
  useProjection: UseProjection
  scope: SettingsScope<AutonomySettings>
  setLevel: (level: AutonomyLevel | 'reset') => Promise<{ ok: true } | { ok: false; message: string }>
}) {
  const [open, setOpen] = useState(false)
  const [hover, setHover] = useState(false)
  const [focused, setFocused] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [preview, setPreview] = useState<AutonomyLevel | null>(null)
  const override = props.useProjection('autonomy')?.level ?? null
  const snap = useScope(props.scope)
  const effective = override ?? snap.value?.level ?? 'normal'
  const display = preview ?? effective
  const [failure, setFailure] = useState<string | null>(null)
  const trackRef = useRef<HTMLDivElement>(null)

  const commit = (level: AutonomyLevel) => {
    setPreview(null)
    void props.setLevel(level).then((outcome) => {
      setFailure(outcome.ok ? null : outcome.message)
    })
  }

  const levelFromPointer = (clientX: number): AutonomyLevel => {
    const rect = trackRef.current?.getBoundingClientRect()
    if (rect === undefined || rect.width === 0) return effective
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return LEVELS[Math.round(ratio * (LEVELS.length - 1))].id
  }

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragging(true)
    setPreview(levelFromPointer(e.clientX))
  }
  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    setPreview(levelFromPointer(e.clientX))
  }
  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    setDragging(false)
    commit(levelFromPointer(e.clientX))
  }
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const idx = LEVELS.findIndex((l) => l.id === display)
    if (e.key === 'ArrowLeft' && idx > 0) commit(LEVELS[idx - 1].id)
    else if (e.key === 'ArrowRight' && idx < LEVELS.length - 1) commit(LEVELS[idx + 1].id)
  }

  // ── trigger (mirrors the model selector's toolbar trigger) ────────────────
  const triggerStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    height: 28,
    maxWidth: 220,
    padding: '0 4px 0 8px',
    fontSize: 13,
    fontWeight: 500,
    lineHeight: '20px',
    color: failure !== null ? 'var(--dsw-alias-state-error-primary)' : 'var(--dsw-alias-label-secondary)',
    background: hover ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
    border: 'none',
    borderRadius: 24,
    outline: 'none',
    cursor: 'pointer',
    boxShadow: focused ? '0 0 0 2px var(--dsw-alias-border-l3)' : undefined,
    transition: 'background 0.12s',
  }
  const chevronStyle: React.CSSProperties = {
    display: 'flex',
    flex: 'none',
    color: 'var(--dsw-alias-label-caption)',
    transition: 'transform 0.12s',
    transform: open ? 'rotate(180deg)' : undefined,
  }

  // ── panel (mirrors the model selector's menu card) ────────────────────────
  const card: React.CSSProperties = {
    position: 'absolute',
    bottom: 'calc(100% + 8px)',
    right: 0,
    width: 'min(304px, calc(100vw - 32px))',
    background: 'var(--dsw-specific-menu)',
    border: '1px solid var(--dsw-alias-border-inverted)',
    borderRadius: 12,
    boxShadow: 'var(--dsw-shadow-lv3)',
    padding: '14px 18px 12px',
    zIndex: 200,
  }
  const titleStyle: React.CSSProperties = {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--dsw-alias-label-primary)',
    marginBottom: 10,
  }
  const trackWrap: React.CSSProperties = {
    position: 'relative',
    height: 24,
    margin: '0 6px',
    cursor: 'pointer',
    touchAction: 'none',
    outline: 'none',
    borderRadius: 4,
  }
  const trackBase: React.CSSProperties = {
    position: 'absolute',
    top: '50%',
    height: 3,
    borderRadius: 2,
    transform: 'translateY(-50%)',
    pointerEvents: 'none',
  }
  const dot = (active: boolean): React.CSSProperties => ({
    position: 'absolute',
    top: '50%',
    width: active ? 14 : 11,
    height: active ? 14 : 11,
    borderRadius: '50%',
    transform: 'translate(-50%, -50%)',
    pointerEvents: 'none',
    background: active ? 'var(--dsw-alias-brand-primary)' : 'var(--dsw-alias-bg-layer-1)',
    border: active ? '2px solid var(--dsw-alias-bg-base)' : '1.5px solid var(--dsw-alias-border-l3)',
    boxShadow: active ? '0 0 0 1.5px var(--dsw-alias-brand-primary)' : undefined,
    transition: 'width 0.08s, height 0.08s',
  })
  const label = (active: boolean, isFirst: boolean, isLast: boolean): React.CSSProperties => ({
    position: 'absolute',
    top: 26,
    whiteSpace: 'nowrap',
    fontSize: 10.5,
    lineHeight: 1.2,
    cursor: 'pointer',
    pointerEvents: 'none',
    fontWeight: active ? 600 : 400,
    color: active ? 'var(--dsw-alias-label-primary)' : 'var(--dsw-alias-label-tertiary)',
    transform: isFirst ? 'none' : isLast ? 'translateX(-100%)' : 'translateX(-50%)',
  })
  const descStyle: React.CSSProperties = {
    marginTop: 26,
    fontSize: 11.5,
    lineHeight: 1.5,
    color: 'var(--dsw-alias-label-tertiary)',
    minHeight: 17,
  }

  return (
    <div style={{ position: 'relative' }}>
      {open && <div style={{ position: 'fixed', inset: 0, zIndex: 190 }} onClick={() => setOpen(false)} />}
      <button
        type="button"
        style={triggerStyle}
        title={failure ?? '自主性（每会话）'}
        aria-label={'自主性，当前：' + labelOf(effective)}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
      >
        {(failure === null ? '' : '⚠ ') + labelOf(effective)}
        <span style={chevronStyle} aria-hidden="true">
          <IconChevronDownOutline14 />
        </span>
      </button>
      {open && (
        <div style={card} role="dialog" aria-label="自主性">
          <div style={titleStyle}>自主性</div>
          <div
            ref={trackRef}
            style={trackWrap}
            role="radiogroup"
            aria-label="自主性档位"
            tabIndex={0}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
            onKeyDown={onKeyDown}
          >
            <div style={{ ...trackBase, left: 0, right: 0, background: 'var(--dsw-alias-border-l3)' }} />
            <div
              style={{
                ...trackBase,
                left: 0,
                width: `calc(100% * ${(LEVELS.findIndex((l) => l.id === display) * 25) / 100})`,
                background: 'var(--dsw-alias-brand-primary)',
              }}
            />
            {LEVELS.map((lvl, i) => {
              const active = lvl.id === display
              const pct = `${i * 25}%`
              return (
                <React.Fragment key={lvl.id}>
                  <div style={{ ...dot(active), left: pct }} role="radio" aria-checked={active} aria-label={lvl.label} />
                  <div
                    style={{ ...label(active, i === 0, i === LEVELS.length - 1), left: pct }}
                    aria-hidden="true"
                  >
                    {lvl.label}
                  </div>
                </React.Fragment>
              )
            })}
          </div>
          <div style={descStyle}>{LEVELS.find((l) => l.id === display)?.description}</div>
        </div>
      )}
    </div>
  )
}

export function apply(ctx: ClientContext) {
  const scope = ctx.settingsScope.bind<AutonomySettings>({ namespace: 'autonomy' })

  // The shell creates every client entry in parallel, so the composer slots
  // (declared by ui-conversation's apply) may not exist yet when this apply
  // runs. slots.inject defers the registration until the declaration lands.
  ctx.slots.inject('conversation.input.right', () =>
    ctx.slots.register(
      // Highest order: renders at the right end of the input.right group —
      // immediately LEFT of the model seat in the composer tool row.
      { name: 'conversation.input.right', id: 'autonomy', order: 1000, label: '自主性' },
      (slotProps: { sessionId: SessionId; useProjection: UseProjection }) =>
        React.createElement(AutonomyControl, {
          sessionId: slotProps.sessionId,
          useProjection: slotProps.useProjection,
          scope,
          setLevel: async (level) => {
            try {
              const line = '/autonomy ' + level
              const result = await ctx.remote.commands.execute(slotProps.sessionId, line)
              if (!result.ok) throw new Error('[' + result.error.code + '] ' + result.error.message)
              if (result.value === undefined) throw new Error('command not admitted by the host')
              return { ok: true as const }
            } catch (error) {
              console.error('[autonomy-client] /autonomy failed:', error)
              const message = error instanceof Error ? error.message : String(error)
              return { ok: false as const, message }
            }
          },
        }),
    ),
  )
}
