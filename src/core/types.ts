/** What the engine sends to a backend */
export type QueryRequest = {
  chatId: string;
  prompt: string;
  senderName: string;
  isGroup?: boolean;
  messageId?: number;
  onStreamDelta?: (text: string, phase?: "thinking" | "text") => void;
  onTextBlock?: (text: string) => Promise<void>;
};

/** What a backend returns */
export type QueryResult = {
  text: string;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
};

/** Backend interface -- one function */
export interface QueryBackend {
  query(request: QueryRequest): Promise<QueryResult>;
}

/** Frontend interface -- output actions */
export interface OutputBackend {
  sendText(chatId: number, text: string, replyTo?: number): Promise<number>;
  sendTyping(chatId: number): Promise<void>;
}
