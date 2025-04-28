export interface SlackPayload {
  text: string;
  blocks?: any[];
}

export interface ButtonConfig {
  label: string;
  field?: string;
  value?: string | any;
}

export interface Config {
  baseId: string;
  tableId: string;
  recordId: string;
  slackChannelIds: string[];
  messageText: string;
  primaryButton?: ButtonConfig;
  secondaryButton?: ButtonConfig;
}

export interface Env {
  SLACK_BOT_TOKEN: string;
  AIRTABLE_API_KEY: string;
  SLACK_SIGNING_SECRET: string;
  AIRTABLE_WEBHOOK_SECRET: string;
}
