import type { SessionSummary, ArtifactList } from '../io/claudeRunner'

export {}

declare global {
  interface Window {
    api: {
      createSession(): Promise<{ sessionId: string; sessionDir: string }>
      listSessions(): Promise<SessionSummary[]>
      renameSession(claudeSessionId: string, title: string): Promise<void>
      getChatLog(sessionId: string): Promise<unknown[]>
      getArtifacts(sessionId: string): Promise<ArtifactList>
      sendMessage(sessionId: string, prompt: string): void
      killSession(sessionId: string): void
      onChunk(
        callback: (sessionId: string, message: unknown) => void,
      ): () => void
      onStatus(
        callback: (
          sessionId: string,
          status: 'idle' | 'running' | 'closed',
        ) => void,
      ): () => void
      onPushRejected(callback: (sessionId: string) => void): () => void
      onArtifactsChanged(callback: (sessionId: string) => void): () => void
    }
  }
}
