import { useEffect, useState, type CSSProperties } from 'react'
import { useApp, selectActiveChat } from '../store/store'
import { PROVIDERS, type ModelDef, type ProviderDef } from '../data/providers'
import type { ProviderProbe } from '../../../shared/runtime'

// Model & provider modal (FR-7.1), provider-first: page 1 lists DETECTED providers (live CLI probe,
// CliRegistry v0); page 2 = one provider's models + options. Applies to the ACTIVE chat only (FR-7.4).
// parseVersionLine can fall back to non-numeric strings (e.g. 'dev build') — only prefix real versions.
const versionLabel = (v: string): string => (/^\d/.test(v) ? `v${v}` : v)

// Selectable-entry count for a provider row (variants count — they're picked like models).
const modelCount = (models: ModelDef[]): string => {
  const n = models.reduce((a, m) => a + 1 + (m.variants?.length ?? 0), 0)
  return `${n} ${n === 1 ? 'model' : 'models'}`
}

export default function ModelModal() {
  const active = useApp(selectActiveChat)
  const setModel = useApp((s) => s.setModel)
  const setEffort = useApp((s) => s.setEffort)
  const toggleFast = useApp((s) => s.toggleFast)
  const close = useApp((s) => s.closeModal)
  const [page, setPage] = useState<string | null>(null) // null = provider list, else a provider id
  const [probes, setProbes] = useState<ProviderProbe[] | null>(null) // null = probing
  const [discovered, setDiscovered] = useState<Record<string, ModelDef[]>>({})

  // Escape backs out of a provider page first, then closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (page) setPage(null)
      else close()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [close, page])

  // Live availability: adapter-backed CLIs probed fresh each time the modal opens.
  useEffect(() => {
    let live = true
    const registry = window.nac?.registry
    if (!registry) {
      // No preload bridge (tests, stale preload) — degrade to "no providers detected", never stuck probing.
      setProbes([])
      return
    }
    registry
      .providers()
      .then((r) => {
        if (live) setProbes(r)
      })
      .catch(() => {
        if (live) setProbes([])
      })
    return () => {
      live = false
    }
  }, [])

  // Live model discovery (OpenCode reflects the account's real configured models); falls back to static.
  useEffect(() => {
    let live = true
    window.nac?.models
      ?.discover('opencode')
      .then((ids) => {
        if (live && ids.length) setDiscovered({ opencode: ids.map((id) => ({ id, label: id })) })
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  const probeFor = (id: string): ProviderProbe | undefined => probes?.find((p) => p.id === id)
  const detected = PROVIDERS.filter((p) => probeFor(p.id)?.installed)
  const provider = detected.find((p) => p.id === page) ?? null

  function pick(providerId: string, modelLabel: string): void {
    setModel(providerId, modelLabel)
    close()
  }

  return (
    <div onClick={close} style={backdrop}>
      <div onClick={(e) => e.stopPropagation()} style={card}>
        <div style={modalHeader}>
          {provider && (
            <button onClick={() => setPage(null)} style={backBtn} aria-label="Back">
              ←
            </button>
          )}
          <span style={{ fontWeight: 600 }}>{provider ? provider.name : 'Model & provider'}</span>
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--muted)' }}>applies to this chat only</span>
          <button onClick={close} style={closeBtn} aria-label="Close">
            ✕
          </button>
        </div>

        <div style={{ overflow: 'auto' }}>
          {provider ? (
            <ProviderPage
              provider={provider}
              version={probeFor(provider.id)?.version}
              models={discovered[provider.id] ?? provider.models}
              isActiveProvider={active.provider === provider.id}
              activeModel={active.model}
              effort={active.effort}
              fast={active.fast}
              onPick={pick}
              onEffort={setEffort}
              onFast={toggleFast}
            />
          ) : probes === null ? (
            <div style={emptyState}>Detecting installed CLIs…</div>
          ) : detected.length === 0 ? (
            <div style={emptyState}>No providers detected. Install one of: claude, codex, copilot, opencode.</div>
          ) : (
            detected.map((p) => (
              <button key={p.id} onClick={() => setPage(p.id)} style={providerRow}>
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: p.dot, flexShrink: 0 }} />
                <span style={{ fontSize: 13, fontWeight: 600 }}>{p.name}</span>
                {active.provider === p.id && <span className="mono" style={currentTag}>{active.model}</span>}
                <span className="mono" style={{ marginLeft: 'auto', fontSize: 11, color: 'var(--faint)' }}>
                  {probeFor(p.id)?.version ? `${versionLabel(probeFor(p.id)!.version!)} · ` : ''}
                  {modelCount(discovered[p.id] ?? p.models)} ›
                </span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  )
}

function ProviderPage(props: {
  provider: ProviderDef
  version?: string
  models: ModelDef[]
  isActiveProvider: boolean
  activeModel: string
  effort: string | null
  fast: boolean
  onPick: (provider: string, model: string) => void
  onEffort: (e: string | null) => void
  onFast: () => void
}) {
  const p = props.provider
  return (
    <div style={{ padding: '10px 16px 16px', borderTop: '1px solid var(--line)' }}>
      <div className="mono" style={{ fontSize: 11, color: 'var(--faint)', marginBottom: 10 }}>
        {p.detail}
        {props.version ? ` · ${versionLabel(props.version)}` : ''}
      </div>

      <div style={sectionLabel}>Models</div>
      {!p.modelsWired && (
        <div style={{ fontSize: 11, color: 'var(--faint)', marginBottom: 8 }}>
          account default runs · model selection needs real discovery (M4)
        </div>
      )}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
        {/* Unwired providers stay switchable via one actionable chip; modelIdFor returns undefined
            for this label, so no --model is ever sent and the CLI runs its account default. */}
        {!p.modelsWired && (
          <Chip
            label="Account default"
            active={props.isActiveProvider && props.activeModel === 'Account default'}
            onClick={() => props.onPick(p.id, 'Account default')}
          />
        )}
        {props.models.flatMap((m) => [
          <Chip
            key={m.id}
            label={m.label}
            active={props.isActiveProvider && props.activeModel === m.label}
            disabled={!p.modelsWired}
            onClick={p.modelsWired ? () => props.onPick(p.id, m.label) : undefined}
          />,
          ...(m.variants ?? []).map((v) => (
            <Chip
              key={v.id}
              label={v.label}
              active={props.isActiveProvider && props.activeModel === v.label}
              disabled={!p.modelsWired}
              onClick={p.modelsWired ? () => props.onPick(p.id, v.label) : undefined}
            />
          ))
        ])}
      </div>

      {p.options.length > 0 && <div style={sectionLabel}>Options · this chat</div>}
      {p.options.map((opt) => (
        <div key={opt.id} style={{ marginBottom: 10 }}>
          <div style={optionLabel}>
            {opt.label}
            {opt.note ? <span style={{ color: 'var(--faint)', fontWeight: 400 }}> — {opt.note}</span> : null}
          </div>
          {opt.kind === 'enum' ? (
            <div style={{ display: 'flex', gap: 6 }}>
              {(opt.values ?? []).map((v) => (
                <Chip
                  key={v}
                  label={v}
                  active={props.effort === (v === 'none' ? null : v)}
                  onClick={() => props.onEffort(v === 'none' ? null : v)}
                />
              ))}
            </div>
          ) : (
            <Chip label={props.fast ? 'On' : 'Off'} active={props.fast} onClick={props.onFast} />
          )}
        </div>
      ))}
    </div>
  )
}

function Chip(props: { label: string; active: boolean; onClick?: () => void; disabled?: boolean }) {
  const disabled = props.disabled ?? !props.onClick
  return (
    <button
      onClick={props.onClick}
      disabled={disabled}
      className="mono"
      style={{
        ...modelChip,
        background: props.active ? 'var(--accent-tint-3)' : 'var(--card)',
        color: props.active ? 'var(--text)' : 'var(--text-2)',
        borderColor: props.active ? 'var(--accent)' : 'var(--line)',
        ...(disabled ? { opacity: 0.45, cursor: 'default' } : null)
      }}
    >
      {props.label}
    </button>
  )
}

const backdrop: CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 100
}
const card: CSSProperties = {
  width: 480,
  maxWidth: '90vw',
  maxHeight: '74vh',
  display: 'flex',
  flexDirection: 'column',
  background: 'var(--panel)',
  border: '1px solid var(--line-2)',
  borderRadius: 16,
  boxShadow: '0 30px 90px rgba(0,0,0,.6)',
  overflow: 'hidden'
}
const modalHeader: CSSProperties = { display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px' }
const closeBtn: CSSProperties = { background: 'transparent', border: 'none', color: 'var(--muted)', cursor: 'pointer', fontSize: 14 }
const backBtn: CSSProperties = { background: 'var(--card)', color: 'var(--text-2)', border: '1px solid var(--line)', borderRadius: 6, padding: '2px 9px', fontSize: 13, cursor: 'pointer' }
const modelChip: CSSProperties = { border: '1px solid var(--line)', borderRadius: 6, padding: '5px 10px', fontSize: 12, cursor: 'pointer' }
const providerRow: CSSProperties = { display: 'flex', alignItems: 'center', gap: 8, width: '100%', padding: '12px 16px', background: 'transparent', border: 'none', borderTop: '1px solid var(--line)', cursor: 'pointer', textAlign: 'left', color: 'var(--text)' }
const currentTag: CSSProperties = { fontSize: 11, color: 'var(--accent-light)', background: 'var(--accent-tint-3)', borderRadius: 5, padding: '1px 7px' }
const emptyState: CSSProperties = { padding: '28px 16px', textAlign: 'center', fontSize: 12.5, color: 'var(--muted)', borderTop: '1px solid var(--line)' }
const sectionLabel: CSSProperties = { fontSize: 10.5, letterSpacing: 1.2, textTransform: 'uppercase', color: 'var(--muted-2)', fontWeight: 600, marginBottom: 8 }
const optionLabel: CSSProperties = { fontSize: 12, color: 'var(--muted)', marginBottom: 6, fontWeight: 600 }
