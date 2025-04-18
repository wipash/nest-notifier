export interface SlackPayload {
  text: string;
  blocks?: any[];
}

export interface AirtableRecord {
  id: string;
  fields: { [key: string]: string | number | boolean | string[] | undefined };
}

export interface ButtonConfig {
  label: string;
  field?: string;
  value?: string | any;
}

export interface Config {
  baseId: string;
  tableId: string;
  slackChannelIds: string[];
  messageTemplate: string;
  primaryButton?: ButtonConfig;
  secondaryButton?: ButtonConfig;
}

export interface Env {
  SLACK_BOT_TOKEN: string;
  AIRTABLE_API_KEY: string;
  SLACK_SIGNING_SECRET: string;
  AIRTABLE_WEBHOOK_SECRET: string;
}
