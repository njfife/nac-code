import type { Chat } from '../store/store'

/** Pure + exported for testing: the metering footer/inspector cost string.
 *  Order matters — real accumulated dollars win over the opencode-local shortcut (a chat can carry
 *  both a metered provider's history AND a later opencode/local switch; real $ never gets hidden),
 *  then opencode+lmstudio* reads as free · local, then any metered turn is an honest $0.00 (never a
 *  fabricated placeholder), else there's simply nothing metered yet. */
export function costLabel(chat: Pick<Chat, 'provider' | 'model' | 'usage'>): string {
  const real = Object.values(chat.usage).reduce((sum, u) => sum + (u.costUsd ?? 0), 0)
  if (real > 0) return real < 0.01 ? '<$0.01' : `$${real.toFixed(2)}`
  if (chat.provider === 'opencode' && chat.model.startsWith('lmstudio')) return 'free · local'
  if (Object.values(chat.usage).some((u) => u.turns > 0)) return '$0.00'
  return '—'
}
