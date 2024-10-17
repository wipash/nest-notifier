import { SlackPayload, AirtableRecord, Config } from './types';

export interface Env {
  SLACK_BOT_TOKEN: string;
  AIRTABLE_API_KEY: string;
  AIRTABLE_BASE_ID: string;
  AIRTABLE_TABLE_NAME: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'POST') {
      if (request.headers.get('X-Slack-Signature')) {
        // Handle Slack interaction
        return handleSlackInteraction(request, env);
      } else {
        // Handle webhook from Airtable
        return handleWebhook(request, env);
      }
    } else {
      return new Response('Method not allowed', { status: 405 });
    }
  },
};

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  const payload = (await request.json()) as { record: AirtableRecord; config: Config };
  const { record, config } = payload;

  // Format the Slack message
  const message = formatSlackMessage(record, config);
  console.log(config);

  // Send message to Slack
  await sendSlackMessage(env.SLACK_BOT_TOKEN, config.slackChannelId, message);

  return new Response('Webhook processed', { status: 200 });
}

function formatSlackMessage(record: AirtableRecord, config: Config): SlackPayload {
  let text = config.messageTemplate;
  for (const [key, value] of Object.entries(record.fields)) {
    text = text.replace(`{${key}}`, value as string);
  }

  return {
    text: text,
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: text,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: config.buttonText,
            },
            value: JSON.stringify({
              recordId: record.id,
              statusFieldName: config.statusFieldName,
            }),
            action_id: 'approve_application',
          },
        ],
      },
    ],
  };
}

async function sendSlackMessage(token: string, channelId: string, message: SlackPayload): Promise<void> {
  const requestBody = JSON.stringify({
    channel: channelId,
    ...message,
  });

  console.log('Sending Slack message with:', {
    url: 'https://slack.com/api/chat.postMessage',
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token.substring(0, 10)}...`, // Log only part of the token for security
      'Content-Type': 'application/json',
    },
    body: requestBody,
  });

  const slackResponse = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: requestBody,
  });

  const responseBody = await slackResponse.json();

  console.log('Slack API Response:', {
    status: slackResponse.status,
    statusText: slackResponse.statusText,
    body: responseBody,
  });

  if (!slackResponse.ok || !responseBody.ok) {
    console.error('Slack API Error:', responseBody);
    throw new Error(`Failed to send Slack message: ${responseBody.error}`);
  }

  console.log('Slack message sent successfully:', responseBody);
}

async function handleSlackInteraction(request: Request, env: Env): Promise<Response> {
  const formData = await request.formData();
  const payload = JSON.parse(formData.get('payload') as string) as any;

  if (payload.type === 'block_actions' && payload.actions[0].action_id === 'approve_application') {
    const value = JSON.parse(payload.actions[0].value);

    // Update Airtable record
    await updateAirtableRecord(env, value.recordId, value.statusFieldName);

    // Update Slack message
    await updateSlackMessage(env.SLACK_BOT_TOKEN, payload.container.channel_id, payload.container.message_ts);
  }

  return new Response('Interaction handled', { status: 200 });
}

async function updateAirtableRecord(env: Env, recordId: string, statusFieldName: string): Promise<void> {
  const updateResponse = await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_TABLE_NAME}/${recordId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${env.AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fields: {
        [statusFieldName]: 'Approved',
      },
    }),
  });

  if (!updateResponse.ok) {
    throw new Error(`Failed to update Airtable record: ${updateResponse.statusText}`);
  }
}

async function updateSlackMessage(token: string, channelId: string, messageTs: string): Promise<void> {
  const updateResponse = await fetch('https://slack.com/api/chat.update', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel: channelId,
      ts: messageTs,
      text: 'Application approved!',
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'Application approved!',
          },
        },
      ],
    }),
  });

  if (!updateResponse.ok) {
    throw new Error(`Failed to update Slack message: ${updateResponse.statusText}`);
  }
}
