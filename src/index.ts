import { SlackPayload, AirtableRecord, Config, SlackAPIResponse, ChannelInfo } from './types';

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

  // Send message to all specified Slack channels
  const channelIds = config.slackChannelIds;
  console.log('Sending messages to channels:', channelIds);

  const messagePromises = channelIds.map((channelId) => sendSlackMessage(env.SLACK_BOT_TOKEN, channelId, message));

  try {
    const results = await Promise.all(messagePromises);
    console.log('Messages sent successfully:', results);
    return new Response('Webhook processed', { status: 200 });
  } catch (error) {
    console.error('Error processing webhook:', error);
    return new Response('Error processing webhook', { status: 500 });
  }
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
            style: 'primary',
            text: {
              type: 'plain_text',
              text: config.approveButtonText,
            },
            value: JSON.stringify({
              recordId: record.id,
              statusFieldName: config.statusFieldName,
            }),
            action_id: 'approve',
          },
          {
            type: 'button',
            style: 'danger',
            text: {
              type: 'plain_text',
              text: 'Ignore',
            },
            value: JSON.stringify({
              recordId: record.id,
              statusFieldName: config.statusFieldName,
            }),
            action_id: 'ignore',
          },
        ],
      },
    ],
  };
}

async function sendSlackMessage(token: string, channelId: string, message: SlackPayload): Promise<void> {
  const slackResponse = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel: channelId,
      ...message,
    }),
  });

  if (!slackResponse.ok) {
    const errorBody = await slackResponse.text();
    console.error(`Failed to send Slack message: ${slackResponse.status} ${slackResponse.statusText}`, errorBody);
    throw new Error(`Failed to send Slack message: ${slackResponse.statusText}`);
  }

  console.log(`Successfully sent message to channel ${channelId}`);
}

async function handleSlackInteraction(request: Request, env: Env): Promise<Response> {
  const formData = await request.formData();
  const payload = JSON.parse(formData.get('payload') as string) as any;

  console.log('Received Slack interaction payload:', JSON.stringify(payload, null, 2));

  if (payload.type === 'block_actions' && (payload.actions[0].action_id === 'approve' || payload.actions[0].action_id === 'ignore')) {
    const value = JSON.parse(payload.actions[0].value);
    const action = payload.actions[0].action_id;
    const userName = payload.user.name;

    if (action === 'approve') {
      // Update Airtable record
      await updateAirtableRecord(env, value.recordId, value.statusFieldName);
    }

    // Update the Slack message in the current channel
    const updatedMessage = formatUpdatedMessage(payload.message, action, userName);
    try {
      await updateSlackMessage(env.SLACK_BOT_TOKEN, payload.channel.id, payload.message.ts, updatedMessage);
    } catch (error) {
      console.error('Failed to update Slack message during interaction handling:', error);
      // Continue execution to return 200 to Slack, preventing retries
    }
  }

  return new Response('Interaction handled', { status: 200 });
}

function formatUpdatedMessage(originalMessage: any, action: string, userName: string): SlackPayload {
  const updatedBlocks = originalMessage.blocks.map((block: any) => {
    if (block.type === 'actions') {
      return {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${action === 'approve' ? 'Approved' : 'Ignored'}* by ${userName}`,
        },
      };
    }
    return block;
  });

  return {
    text: originalMessage.text,
    blocks: updatedBlocks,
  };
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

async function updateSlackMessage(token: string, channelId: string, ts: string, updatedMessage: SlackPayload): Promise<void> {
  const updateResponse = await fetch('https://slack.com/api/chat.update', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel: channelId,
      ts: ts,
      ...updatedMessage,
    }),
  });

  if (!updateResponse.ok) {
    const errorBody = await updateResponse.text();
    console.error(`Failed to update Slack message: ${updateResponse.status} ${updateResponse.statusText}`, errorBody);
    throw new Error(`Failed to update Slack message: ${updateResponse.statusText}`);
  }

  console.log(`Successfully updated message in channel ${channelId}`);
}
