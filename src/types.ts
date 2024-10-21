export interface SlackPayload {
  text: string;
  blocks: any[] | undefined;
}

export interface AirtableRecord {
  id: string;
  fields: Record<string, unknown>;
}

export interface Config {
  slackChannelIds: string[];
  messageTemplate: string;
  approveButtonText: string;
  includedFields: string[];
  statusFieldName: string;
}

export interface SlackAPIResponse {
  ok: boolean;
  error?: string;
  [key: string]: any;
}

export interface ChannelInfo {
  channelId: string;
  ts?: string;  // Optional because it's not set initially
}
