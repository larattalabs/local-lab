export interface HistoryState { resetId: string; warning?: string }
export interface HistoryPreview {
  token: string; files: number; bytes: number; images: number; videos: number; chats: number; audio: number
  busy: boolean
}
export interface HistoryClear { token: string; confirmation: string }
