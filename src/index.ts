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

  const blocks: any[] = [
    {
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: text,
      },
    },
  ];

  const actionElements: any[] = [];

  if (config.primaryButton) {
    actionElements.push({
      type: 'button',
      style: 'primary', // Default primary style
      text: {
        type: 'plain_text',
        text: config.primaryButton.label,
        emoji: true,
      },
      value: JSON.stringify({
        recordId: record.id,
        buttonConfig: config.primaryButton,
      }),
      action_id: 'primary_action',
    });
  }

  if (config.secondaryButton) {
    actionElements.push({
      type: 'button',
      // style: 'danger', // Or default? Let's use default for now
      text: {
        type: 'plain_text',
        text: config.secondaryButton.label,
        emoji: true,
      },
      value: JSON.stringify({
        recordId: record.id,
        buttonConfig: config.secondaryButton,
      }),
      action_id: 'secondary_action',
    });
  }

  if (actionElements.length > 0) {
    blocks.push({
      type: 'actions',
      elements: actionElements,
    });
  }

  return {
    text: text, // Fallback text
    blocks: blocks,
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

  // Check if it's a block action and if the action_id matches our buttons
  if (payload.type === 'block_actions' && payload.actions[0]?.action_id.endsWith('_action')) {
    const action = payload.actions[0];
    const value = JSON.parse(action.value);
    const buttonConfig = value.buttonConfig; // Contains label, field, value
    const userName = payload.user.name;
    const recordId = value.recordId;

    // Update Airtable only if field and value are defined for this button
    if (buttonConfig.field && buttonConfig.value !== undefined) {
      try {
        await updateAirtableRecord(env, recordId, buttonConfig.field, buttonConfig.value);
        console.log(`Airtable record ${recordId} updated: ${buttonConfig.field} = ${buttonConfig.value}`);
      } catch (error) {
        console.error(`Failed to update Airtable record ${recordId}:`, error);
        // Optionally notify the user in Slack that the Airtable update failed
        // For now, we continue to update the Slack message regardless
      }
    } else {
        console.log(`Button "${buttonConfig.label}" clicked, no Airtable update configured.`);
    }

    // Update the Slack message
    const updatedMessage = formatUpdatedMessage(payload.message, buttonConfig.label, userName);
    try {
      await updateSlackMessage(env.SLACK_BOT_TOKEN, payload.channel.id, payload.message.ts, updatedMessage);
    } catch (error) {
      console.error('Failed to update Slack message during interaction handling:', error);
      // Continue execution to return 200 OK to Slack
    }
  } else {
    console.log('Received unhandled interaction type or action_id:', payload.type, payload.actions?.[0]?.action_id);
  }

  return new Response('Interaction handled', { status: 200 });
}

function formatUpdatedMessage(originalMessage: any, buttonLabel: string, userName: string): SlackPayload {
  const updatedBlocks = originalMessage.blocks.map((block: any) => {
    if (block.type === 'actions') {
      // Replace the actions block with a context or section block showing the action taken
      return {
        type: 'context', // Using context for less emphasis than section
        elements: [
            {
                type: 'mrkdwn',
                text: `*${buttonLabel}* by ${userName}`
            }
        ]
      };
    }
    // Keep other blocks (like the original message section)
    return block;
  });

  // Ensure we don't have duplicate context blocks if the button is clicked multiple times (though Slack might prevent this)
  // A simple approach: keep the original text, modify blocks.
  return {
    text: originalMessage.text, // Keep original fallback text
    blocks: updatedBlocks,
  };
}

async function updateAirtableRecord(env: Env, recordId: string, fieldName: string, newValue: any): Promise<void> {
  console.log(`Updating Airtable record ${recordId}: setting field "${fieldName}" to`, newValue);
  const updateResponse = await fetch(`https://api.airtable.com/v0/${env.AIRTABLE_BASE_ID}/${env.AIRTABLE_TABLE_NAME}/${recordId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${env.AIRTABLE_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      fields: {
        [fieldName]: newValue, // Use dynamic field name and value
      },
    }),
  });

  if (!updateResponse.ok) {
     const errorBody = await updateResponse.text();
     console.error(`Failed to update Airtable record ${recordId}: ${updateResponse.status} ${updateResponse.statusText}`, errorBody);
    throw new Error(`Failed to update Airtable record: ${updateResponse.statusText}`);
  }
   console.log(`Successfully updated Airtable record ${recordId}`);
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
