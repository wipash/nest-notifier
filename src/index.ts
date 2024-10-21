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
  const channelIds = config.slackChannelIds; // Assume this is now an array of channel IDs
  console.log('Sending messages to channels:', channelIds);

  const channelInfo: ChannelInfo[] = channelIds.map((channelId) => ({ channelId }));

  const messagePromises = channelIds.map((channelId) => sendSlackMessage(env.SLACK_BOT_TOKEN, channelId, message, channelInfo));

  try {
    const results = await Promise.all(messagePromises);
    console.log('Messages sent successfully:', results);

    // Update channelInfo with message timestamps
    results.forEach((result, index) => {
      if (channelInfo[index]) {
        channelInfo[index].ts = result.ts;
      }
    });

    console.log('Updated channel info:', channelInfo);

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

async function sendSlackMessage(
  token: string,
  channelId: string,
  message: SlackPayload,
  channelInfo: ChannelInfo[]
): Promise<SlackAPIResponse> {
  const requestBody = JSON.stringify({
    channel: channelId,
    ...message,
    metadata: {
      event_type: 'multi_channel_message',
      event_payload: {
        channel_info: channelInfo,
      },
    },
  });

  console.log(`Sending Slack message to channel ${channelId}:`, requestBody);

  const slackResponse = await fetch('https://slack.com/api/chat.postMessage', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: requestBody,
  });

  const responseBody = (await slackResponse.json()) as SlackAPIResponse;

  if (!slackResponse.ok || !responseBody.ok) {
    console.error('Slack API Error:', responseBody);
    throw new Error(`Failed to send Slack message: ${responseBody.error}`);
  }

  console.log(`Successfully sent message to channel ${channelId}:`, responseBody);

  return responseBody;
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

    // Get channel info from metadata
    let channelInfo: ChannelInfo[] = [];
    if (payload.message && payload.message.metadata && payload.message.metadata.event_payload) {
      channelInfo = payload.message.metadata.event_payload.channel_info || [];
    } else {
      console.warn('Message metadata not found or incomplete. Falling back to single channel update.');
      channelInfo = [
        {
          channelId: payload.channel.id,
          ts: payload.message.ts,
        },
      ];
    }

    console.log('Channel info for updates:', channelInfo);

    // Update Slack message in all channels (or just the current channel if metadata is missing)
    const updatedMessage = formatUpdatedMessage(payload.message, action, userName);
    try {
      await Promise.all(
        channelInfo.map((info: ChannelInfo) => updateSlackMessage(env.SLACK_BOT_TOKEN, info.channelId, info.ts!, updatedMessage))
      );
      console.log('Successfully updated messages in all channels');
    } catch (error) {
      console.error('Error updating messages:', error);
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

async function updateSlackMessage(token: string, channelId: string, messageTs: string, updatedMessage: SlackPayload): Promise<void> {
  const updateResponse = await fetch('https://slack.com/api/chat.update', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      channel: channelId,
      ts: messageTs,
      ...updatedMessage,
    }),
  });

  if (!updateResponse.ok) {
    throw new Error(`Failed to update Slack message: ${updateResponse.statusText}`);
  }
}
