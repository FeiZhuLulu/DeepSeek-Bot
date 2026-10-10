// The transcript is flat: no collapsible step groups in any conversation.
// dsh's Chat work-details mode `verbose` is the only mode without them.
export const FLAT_TRANSCRIPT_VIEW = 'verbose'

// Holds the `ui-chat` settings section at the flat mode. Desktop's first-run setup
// writes `standard`, and with no saved value ui-chat falls back to `standard` on
// Desktop and `detailed` elsewhere, so any other value is overwritten whenever it
// shows up. At most one write is made per Host revision: a refused write leaves the
// revision unchanged, and retrying it would loop.
export function holdFlatTranscript(form) {
  let tried
  const check = () => {
    const snapshot = form.getSnapshot()
    if (snapshot.status !== 'ready' || snapshot.value === undefined || !snapshot.writable) return
    if (snapshot.value.transcriptView === FLAT_TRANSCRIPT_VIEW) return
    if (tried === snapshot.revision) return
    tried = snapshot.revision
    void Promise.resolve(form.set('transcriptView', FLAT_TRANSCRIPT_VIEW)).catch(() => {})
  }
  check()
  return form.subscribe(check)
}
