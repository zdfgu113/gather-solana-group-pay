export function createPendingCheckGate<T extends { signature: string }>(current: () => T | null) {
  const inFlight = new Set<string>()
  return async function check<R>(
    record: T,
    resolve: () => Promise<R>,
    commit: (outcome: { ok: true; value: R } | { ok: false; error: unknown }) => void | Promise<void>,
  ) {
    if (current() !== record || inFlight.has(record.signature)) return false
    inFlight.add(record.signature)
    try {
      let outcome: { ok: true; value: R } | { ok: false; error: unknown }
      try { outcome = { ok: true, value: await resolve() } }
      catch (error) { outcome = { ok: false, error } }
      if (current() !== record) return false
      await commit(outcome)
      return true
    } finally {
      inFlight.delete(record.signature)
    }
  }
}

export function appendTransactionOnce<T extends { id: string }>(rows: T[], entry: T): T[] {
  return rows.some((row) => row.id === entry.id) ? rows : [...rows, entry]
}
