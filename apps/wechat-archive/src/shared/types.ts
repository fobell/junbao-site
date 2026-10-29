export type JobState =
  | "queued"
  | "running"
  | "paused"
  | "waiting_auth"
  | "cooldown"
  | "succeeded"
  | "partial"
  | "failed"
  | "cancelled";
export type Coverage = "unverified" | "verified" | "has_gaps";
export type ResourceState = "pending" | "complete" | "missing";
export interface ArticleRef {
  key: string;
  url: string;
  title: string;
  author?: string | null;
  publishedAt?: string | null;
  updatedAt?: string | null;
  html?: string;
  source: "official" | "browser" | "url";
  sourceId: string;
  deleted?: boolean;
  biz?: string;
  originalId?: string;
}
export interface SourcePage {
  items: ArticleRef[];
  cursor: string | null;
  ended: boolean;
  totalMessages?: number;
  messageCount: number;
  evidence: string;
}
export interface SourceAdapter {
  probe(): Promise<void>;
  list(cursor?: string): Promise<SourcePage>;
}
export class AppError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public retryable = false,
    public retryAfterMs?: number,
  ) {
    super(message);
    this.name = "AppError";
  }
}
export const stateLabels: Record<JobState, string> = {
  queued: "排队中",
  running: "运行中",
  paused: "已暂停",
  waiting_auth: "等待授权",
  cooldown: "冷却中",
  succeeded: "已完成",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已取消",
};
export const coverageLabels: Record<Coverage, string> = {
  unverified: "待核对",
  verified: "已核对",
  has_gaps: "存在缺口",
};
