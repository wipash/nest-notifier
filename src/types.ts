export interface SlackPayload {
  text: string;
  blocks?: any[]; // Consider defining more specific block types
}

export interface AirtableRecord {
  id: string;
  fields: { [key: string]: string | number | boolean | string[] | undefined }; // Allow undefined for optional fields
}

export interface ButtonConfig {
  label: string;
  field?: string;
  value?: string | any; // Allow any type for the value
}

export interface Config {
  slackChannelIds: string[];
  messageTemplate: string;
  // approveButtonText: string; // Obsolete
  // statusFieldName: string; // Obsolete - handled by button config
  primaryButton?: ButtonConfig;
  secondaryButton?: ButtonConfig;
  // includedFields: string[]; // Keep if still used by Airtable script, remove if not
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
