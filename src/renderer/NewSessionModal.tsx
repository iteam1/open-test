import { useState } from 'react'

type Props = {
  // Throws on failure (invalid or duplicate id) — the message is shown in
  // the modal and it stays open so the user can fix it.
  onCreate: (opts: {
    sessionId?: string
    description?: string
  }) => Promise<void>
  onCancel: () => void
}

/** Popup for "+ New session": optional id + description, both default when blank; duplicate/invalid ids surface as an inline error (checked in the main process). */
export function NewSessionModal({ onCreate, onCancel }: Props) {
  const [sessionId, setSessionId] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit: React.DOMAttributes<HTMLFormElement>['onSubmit'] = async (
    event,
  ) => {
    event.preventDefault()
    if (submitting) return
    setSubmitting(true)
    setError('')
    try {
      await onCreate({
        sessionId: sessionId.trim() || undefined,
        description: description.trim() || undefined,
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setSubmitting(false)
    }
  }

  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label="New session"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="modal-title">New session</h2>
        <form onSubmit={handleSubmit}>
          <label className="modal-field">
            <span className="modal-label">Session ID</span>
            <input
              className="modal-input"
              value={sessionId}
              autoFocus
              placeholder="optional — auto-generated if blank"
              onChange={(e) => setSessionId(e.target.value)}
            />
          </label>
          <label className="modal-field">
            <span className="modal-label">Description</span>
            <input
              className="modal-input"
              value={description}
              placeholder="optional — a label to recognize this session by"
              onChange={(e) => setDescription(e.target.value)}
            />
          </label>

          {error && <div className="modal-error">{error}</div>}

          <div className="modal-actions">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="btn btn-primary"
              disabled={submitting}
            >
              {submitting ? 'Creating…' : 'Create'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
