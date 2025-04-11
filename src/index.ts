import { SlackPayload, AirtableRecord, Config } from './types';

export interface Env {
  SLACK_BOT_TOKEN: string;
  AIRTABLE_API_KEY: string;
  AIRTABLE_BASE_ID: string;
  AIRTABLE_TABLE_NAME: string;
  SLACK_SIGNING_SECRET: string;
  AIRTABLE_WEBHOOK_SECRET: string;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    // Clone the request so we can read the body multiple times if needed
    const clonedRequest = request.clone();

    if (request.headers.get('X-Slack-Signature')) {
      // --- Slack Request Verification ---
      const isValid = await isValidSlackRequest(clonedRequest, env.SLACK_SIGNING_SECRET);
      if (!isValid) {
        console.warn('Invalid Slack signature received.');
        return new Response('Invalid Slack signature', { status: 401 });
      }
      console.log('Slack signature verified successfully.');
      // Use the original request for formData parsing as it hasn't been consumed
      return handleSlackInteraction(request, env);
    } else {
      // --- Airtable Webhook Secret Verification ---
      const expectedSecret = env.AIRTABLE_WEBHOOK_SECRET;
      const receivedSecret = request.headers.get('X-Webhook-Secret'); // Or your chosen header name

      if (!expectedSecret || !receivedSecret || !timingSafeEqual(expectedSecret, receivedSecret)) {
        console.warn('Unauthorized webhook attempt: Invalid or missing secret.');
        return new Response('Unauthorized', { status: 401 });
      }
       console.log('Airtable webhook secret verified successfully.');
      // Use the original request for JSON parsing
      return handleWebhook(request, env);
    }
  },
};

// --- Slack Signature Verification Helper ---
async function isValidSlackRequest(request: Request, secret: string): Promise<boolean> {
  const timestamp = request.headers.get('X-Slack-Request-Timestamp');
  const slackSignature = request.headers.get('X-Slack-Signature');
  const body = await request.text(); // Read raw body from the cloned request

  if (!timestamp || !slackSignature || !body) {
    console.error('Missing Slack signature headers or body');
    return false;
  }

  // Prevent replay attacks by checking timestamp (e.g., within 5 minutes)
  const fiveMinutesAgo = Math.floor(Date.now() / 1000) - 60 * 5;
  if (parseInt(timestamp, 10) < fiveMinutesAgo) {
    console.error('Slack timestamp is too old:', timestamp);
    return false;
  }

  const sigBasestring = `v0:${timestamp}:${body}`;

  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign']
    );

    const signatureBuffer = await crypto.subtle.sign(
        'HMAC',
        key,
        encoder.encode(sigBasestring)
    );

    // Convert ArrayBuffer to hex string
    const hexSignature = Array.from(new Uint8Array(signatureBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');

    const expectedSignature = `v0=${hexSignature}`;

    // Use timing-safe comparison
    return timingSafeEqual(slackSignature, expectedSignature);

  } catch (error) {
      console.error("Error verifying Slack signature:", error);
      return false;
  }
}

// --- Timing Safe String Comparison Helper ---
// Basic implementation
function timingSafeEqual(a: string, b: string): boolean {
    if (a.length !== b.length) {
        return false;
    }

    let result = 0;
    for (let i = 0; i < a.length; i++) {
        result |= a.charCodeAt(i) ^ b.charCodeAt(i); // XOR will be 0 if chars match
    }

    return result === 0;
}

async function handleWebhook(request: Request, env: Env): Promise<Response> {
  try {
    const payload = (await request.json()) as { record: AirtableRecord; config: Config };
    const { record, config } = payload;

    // Format the Slack message
    const message = formatSlackMessage(record, config);

    // Send message to all specified Slack channels
    const channelIds = config.slackChannelIds;
    console.log('Sending messages to channels:', channelIds);

    const messagePromises = channelIds.map((channelId) => sendSlackMessage(env.SLACK_BOT_TOKEN, channelId, message));

    // Using Promise.allSettled to handle potential individual message failures better
    const results = await Promise.allSettled(messagePromises);
    console.log('Message sending results:', results);

    // Check if any promises were rejected
    const hasFailures = results.some(result => result.status === 'rejected');
    if (hasFailures) {
        console.error('Some messages failed to send.');
        // Decide if this constitutes a 500 or if partial success is OK
        // For now, let's still return 200 if *any* message could potentially be sent,
        // but log the errors clearly. A more robust system might track failures.
        // return new Response('Webhook processed with some errors', { status: 500 }); // Option 1: Fail hard
        return new Response('Webhook processed', { status: 200 }); // Option 2: Acknowledge processing
    }

    return new Response('Webhook processed', { status: 200 });
  } catch (error: any) {
    console.error('Error processing webhook:', error);
    // Catch JSON parsing errors or other unexpected issues
    if (error instanceof SyntaxError) {
        return new Response('Invalid JSON payload', { status: 400 });
    }
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
