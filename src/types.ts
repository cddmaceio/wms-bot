export interface Settings {
  wmsUrl: string;
  wmsUser: string;
  wmsPass: string;
  apiUrl: string;
  apiEndpoint: string;
  apiToken: string;
  timezone: string;
  downloadTimeoutMs: number;
  uploadTimeoutMs: number;
  retentionDays: number;
  scheduleEnabled: boolean;
  times: string[];
  weekdays: number[];
  whatsappEnabled: boolean;
  sendEnabled: boolean;
  recipients: string[];
  events: string[];
}
export type JobState =
  | "queued"
  | "downloading"
  | "validating"
  | "uploading"
  | "completed"
  | "partial"
  | "failed"
  | "uncertain"
  | "no_data"
  | "downloaded";
export interface Job {
  id: string;
  requestKey: string;
  date: string;
  source: string;
  state: JobState;
  config: string;
  file: string | null;
  screenshot: string | null;
  summary: Record<string, unknown>;
  error: string | null;
  created: string;
  updated: string;
  finished: string | null;
}
export interface Delivery {
  id: number;
  jobId: string;
  event: string;
  recipient: string;
  text: string;
  state: string;
  messageId: string | null;
  note: string | null;
  attempts: number;
  updated: string;
}
export interface UploadResult {
  state: "completed" | "partial" | "failed" | "uncertain";
  status?: number;
  processed: number | null;
  maps: number | null;
  errors: unknown[];
  message: string;
}
export class AppError extends Error {
  constructor(
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
