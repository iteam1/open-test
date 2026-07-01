import { useCallback, useEffect, useState } from 'react'
import type { ArtifactList } from '../io/claudeRunner'

type Props = {
  sessionId: string
}

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.gif', '.webp']

function isImage(name: string): boolean {
  const lower = name.toLowerCase()
  return IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

/**
 * Right pane of SessionView (design.md). Watches output/turn-<n>/ for
 * whichever turn is currently latest (4.3) — refetches on mount and every
 * time ipc.ts's global fs.watch reports a change for this sessionId.
 */
export function ArtifactView({ sessionId }: Props) {
  const [artifacts, setArtifacts] = useState<ArtifactList>({
    turn: 0,
    files: [],
  })

  const refresh = useCallback(async () => {
    const result = await window.api.getArtifacts(sessionId)
    setArtifacts(result)
  }, [sessionId])

  useEffect(() => {
    refresh()
  }, [refresh])

  useEffect(() => {
    return window.api.onArtifactsChanged((id) => {
      if (id === sessionId) refresh()
    })
  }, [sessionId, refresh])

  return (
    <div className="artifact-view">
      <div className="artifact-view-header">
        {artifacts.turn > 0 ? `Turn ${artifacts.turn} artifacts` : 'Artifacts'}
      </div>
      {artifacts.files.length === 0 ? (
        <div className="artifact-empty">Nothing here yet.</div>
      ) : (
        <div className="artifact-list">
          {artifacts.files.map((file) => (
            <div className="artifact-item" key={file.name}>
              {isImage(file.name) ? (
                <img
                  className="artifact-image"
                  src={`file://${file.path}`}
                  alt={file.name}
                />
              ) : (
                <div className="artifact-file-placeholder">
                  {file.name.split('.').pop()?.toUpperCase() ?? 'FILE'}
                </div>
              )}
              <span className="artifact-name">{file.name}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
