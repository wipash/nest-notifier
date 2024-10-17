export interface SlackPayload {
  text: string;
  blocks: any[] | undefined;
}

export interface AirtableRecord {
  id: string;
  fields: Record<string, unknown>;
}

export interface Config {
  slackChannelId: string;
  messageTemplate: string;
  buttonText: string;
  includedFields: string[];
  statusFieldName: string;
}
