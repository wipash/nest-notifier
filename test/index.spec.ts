import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import worker from '../src/index';
import { Config, AirtableRecord, ButtonConfig, Env } from '../src/types';
import { mockEnv } from './mockEnv';

// Define mock IDs
const MOCK_BASE_ID = 'appMockBaseId';
const MOCK_TABLE_ID = 'tblMockTableId';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

// Helper function to generate Slack signature
async function generateSlackSignature(secret: string, timestamp: string, body: string): Promise<string> {
  const encoder = new TextEncoder();
  const sigBasestring = `v0:${timestamp}:${body}`;
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
  const hexSignature = Array.from(new Uint8Array(signatureBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
  return `v0=${hexSignature}`;
}

describe('Cloudflare Worker', () => {

  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('Airtable Webhook Handler', () => {
    it('successfully processes webhook and sends messages with configured buttons', async () => {
      const mockRecord: AirtableRecord = {
        id: 'rec123',
        fields: {
          Name: 'Test Organization',
          Address: '123 Test Street',
          Postcode: 'TE1 1ST',
          Services: 'Service 1\nService 2\nService 3',
        },
      };

      const mockPrimaryButton: ButtonConfig = {
        label: 'Approve',
        field: 'Status',
        value: 'Approved'
      };
      const mockSecondaryButton: ButtonConfig = {
        label: 'Reject',
        field: 'Status',
        value: 'Rejected'
      };

      const mockConfig: Config = {
        baseId: MOCK_BASE_ID,
        tableId: MOCK_TABLE_ID,
        slackChannelIds: ['C0123456789', 'C9876543210'],
        messageTemplate: `:sparkles: *New Request* :sparkles:\nName: {Name}\nAddress: {Address}`,
        primaryButton: mockPrimaryButton,
        secondaryButton: mockSecondaryButton
      };

      const mockPayload = { record: mockRecord, config: mockConfig };

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('OK')));

      const request = new IncomingRequest('http://example.com', {
        method: 'POST',
        headers: {
          'X-Webhook-Secret': mockEnv.AIRTABLE_WEBHOOK_SECRET
        },
        body: JSON.stringify(mockPayload),
      });

      const ctx = createExecutionContext();
      const response = await worker.fetch(request, mockEnv, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('Webhook processed');

      // Verify messages were sent to all channels
      expect(fetch).toHaveBeenCalledTimes(mockConfig.slackChannelIds.length);

      mockConfig.slackChannelIds.forEach(channelId => {
        const matchingCall = (fetch as Mock).mock.calls.find((call: any[]) => {
          if (!Array.isArray(call) || call.length < 2) return false;
          const url = call[0];
          const options = call[1];
          return (
            url === 'https://slack.com/api/chat.postMessage' &&
            (options?.body as string)?.includes(`"channel":"${channelId}"`)
          );
        });
        expect(matchingCall).toBeDefined();
        if (!matchingCall) throw new Error('Matching fetch call not found for channel: ' + channelId);

        const bodyJson = JSON.parse(matchingCall[1].body);
        expect(bodyJson.text).toContain('Test Organization');
        expect(bodyJson.blocks).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: 'section', text: expect.objectContaining({ type: 'mrkdwn' }) }),
          expect.objectContaining({
            type: 'actions',
            elements: expect.arrayContaining([
              expect.objectContaining({
                action_id: 'primary_action',
                text: expect.objectContaining({ text: mockPrimaryButton.label }),
                value: JSON.stringify({ recordId: mockRecord.id, buttonConfig: mockPrimaryButton, baseId: MOCK_BASE_ID, tableId: MOCK_TABLE_ID })
              }),
              expect.objectContaining({
                action_id: 'secondary_action',
                text: expect.objectContaining({ text: mockSecondaryButton.label }),
                value: JSON.stringify({ recordId: mockRecord.id, buttonConfig: mockSecondaryButton, baseId: MOCK_BASE_ID, tableId: MOCK_TABLE_ID })
              })
            ])
          })
        ]));
      });
    });

    it('handles webhook processing errors gracefully', async () => {
      const mockRecord: AirtableRecord = {
        id: 'recError', fields: { Name: 'Error Org'}
      };
      const mockConfig: Config = {
        baseId: MOCK_BASE_ID,
        tableId: MOCK_TABLE_ID,
        slackChannelIds: ['CError123'],
        messageTemplate: 'Error template for {Name}',
        primaryButton: { label: 'Error Button' }
      };
      const mockPayload = { record: mockRecord, config: mockConfig };

      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

      const request = new IncomingRequest('http://example.com', {
        method: 'POST',
        headers: {
          'X-Webhook-Secret': mockEnv.AIRTABLE_WEBHOOK_SECRET
        },
        body: JSON.stringify(mockPayload),
      });

      const ctx = createExecutionContext();
      const response = await worker.fetch(request, mockEnv, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('Webhook processed');
    });

    it('correctly substitutes field values in message templates', async () => {
      // Mock record with various field types
      const mockRecord: AirtableRecord = {
        id: 'recTemplate123',
        fields: {
          Name: 'Test Organization',
          Address: '123 Test Street',
          Postcode: 'TE1 1ST',
          NumberField: 42,
          BooleanField: true,
          // MissingField is intentionally not included
        },
      };

      // Create template with placeholders for all fields, including a missing one
      const messageTemplate = `
*Organization: {Name}*
Location: {Address}, {Postcode}
Number: {NumberField}
Boolean: {BooleanField}
Missing: {MissingField}
`;

      const mockConfig: Config = {
        baseId: MOCK_BASE_ID,
        tableId: MOCK_TABLE_ID,
        slackChannelIds: ['C0123456789'],
        messageTemplate: messageTemplate,
        primaryButton: { label: 'Approve' },
      };

      const mockPayload = { record: mockRecord, config: mockConfig };

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('OK')));

      const request = new IncomingRequest('http://example.com', {
        method: 'POST',
        headers: {
          'X-Webhook-Secret': mockEnv.AIRTABLE_WEBHOOK_SECRET
        },
        body: JSON.stringify(mockPayload),
      });

      const ctx = createExecutionContext();
      const response = await worker.fetch(request, mockEnv, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);

      // Get the actual message body sent to Slack API
      const slackCall = (fetch as Mock).mock.calls.find(
        call => call[0] === 'https://slack.com/api/chat.postMessage'
      );
      if (!slackCall) {
        throw new Error('Slack API call for message not found');
      }
      const slackPayload = JSON.parse(slackCall[1].body);

      // Check that fields were properly substituted
      expect(slackPayload.text).toContain('Organization: Test Organization');
      expect(slackPayload.text).toContain('Location: 123 Test Street, TE1 1ST');
      expect(slackPayload.text).toContain('Number: 42');
      expect(slackPayload.text).toContain('Boolean: true');

      // Check that missing field placeholder remains as is
      expect(slackPayload.text).toContain('Missing: {MissingField}');
    });

  });

  describe('Slack Interaction Handler', () => {
    const baseMessage = {
      ts: '1234567890.123456',
      blocks: [
        { type: 'section', text: { type: 'mrkdwn', text: 'Original message text' } },
        { type: 'actions', elements: [] },
      ],
    };
    const baseUser = { name: 'TestUser' };
    const baseChannel = { id: 'C0123456789' };
    const baseRecordId = 'recInteract123';
    const mockTimestamp = Math.floor(Date.now() / 1000).toString();

    it('handles primary action with Airtable update correctly', async () => {
      const primaryButtonConfig: ButtonConfig = {
        label: 'Do Action A',
        field: 'ActionStatus',
        value: 'A Done'
      };
      const mockSlackPayload = {
        type: 'block_actions',
        actions: [
          {
            action_id: 'primary_action',
            value: JSON.stringify({ recordId: baseRecordId, buttonConfig: primaryButtonConfig, baseId: MOCK_BASE_ID, tableId: MOCK_TABLE_ID }),
          },
        ],
        user: baseUser,
        channel: baseChannel,
        message: baseMessage,
      };

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('OK')));

      const payloadString = JSON.stringify(mockSlackPayload);
      // Construct the raw URL-encoded body string
      const urlEncodedBody = `payload=${encodeURIComponent(payloadString)}`;

      // Generate the correct signature using the raw body string
      const signature = await generateSlackSignature(mockEnv.SLACK_SIGNING_SECRET, mockTimestamp, urlEncodedBody);

      const request = new IncomingRequest('http://example.com', {
        method: 'POST',
        headers: { // Use calculated signature and set Content-Type
            'X-Slack-Signature': signature,
            'X-Slack-Request-Timestamp': mockTimestamp,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: urlEncodedBody // Use the raw string body
      });

      const ctx = createExecutionContext();
      const response = await worker.fetch(request, mockEnv, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);

      // Verify Airtable update
      expect(fetch).toHaveBeenCalledWith(
        `https://api.airtable.com/v0/${MOCK_BASE_ID}/${MOCK_TABLE_ID}/${baseRecordId}`,
        expect.objectContaining({
          method: 'PATCH',
          headers: expect.objectContaining({ Authorization: `Bearer ${mockEnv.AIRTABLE_API_KEY}` }),
          body: JSON.stringify({
            fields: {
              [primaryButtonConfig.field as string]: primaryButtonConfig.value,
            },
          }),
        })
      );

      // Verify Slack message update
      expect(fetch).toHaveBeenCalledWith(
        'https://slack.com/api/chat.update',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({ Authorization: `Bearer ${mockEnv.SLACK_BOT_TOKEN}` }),
          body: expect.stringContaining(`"channel":"${baseChannel.id}"`)
            && expect.stringContaining(`"ts":"${baseMessage.ts}"`)
            && expect.stringContaining(`"type":"context"`)
            && expect.stringContaining(`*${primaryButtonConfig.label}* by ${baseUser.name}`)
        })
      );

      const updateCall = (fetch as Mock).mock.calls.find(call => call[0] === 'https://slack.com/api/chat.update');
      expect(updateCall).toBeDefined();
      if (updateCall) {
        const updateBody = JSON.parse(updateCall[1].body);
        expect(updateBody.blocks).toEqual([
          expect.objectContaining({ type: 'section' }),
          expect.objectContaining({
            type: 'context',
            elements: [expect.objectContaining({ type: 'mrkdwn', text: `*${primaryButtonConfig.label}* by ${baseUser.name}` })]
          })
        ]);
      }
    });

    it('handles secondary action without Airtable update correctly', async () => {
      const secondaryButtonConfig: ButtonConfig = {
        label: 'Just Log It'
      };
      const mockSlackPayload = {
        type: 'block_actions',
        actions: [
          {
            action_id: 'secondary_action',
            value: JSON.stringify({ recordId: baseRecordId, buttonConfig: secondaryButtonConfig, baseId: MOCK_BASE_ID, tableId: MOCK_TABLE_ID }),
          },
        ],
        user: baseUser,
        channel: baseChannel,
        message: baseMessage,
      };

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('OK')));

      const payloadString = JSON.stringify(mockSlackPayload);
      // Construct the raw URL-encoded body string
      const urlEncodedBody = `payload=${encodeURIComponent(payloadString)}`;

      // Generate the correct signature using the raw body string
      const signature = await generateSlackSignature(mockEnv.SLACK_SIGNING_SECRET, mockTimestamp, urlEncodedBody);

      const request = new IncomingRequest('http://example.com', {
          method: 'POST',
          headers: { // Use calculated signature and set Content-Type
              'X-Slack-Signature': signature,
              'X-Slack-Request-Timestamp': mockTimestamp,
              'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: urlEncodedBody // Use the raw string body
      });

      const ctx = createExecutionContext();
      const response = await worker.fetch(request, mockEnv, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);

      // Verify Airtable was NOT updated
      expect(fetch).not.toHaveBeenCalledWith(
        expect.stringContaining('api.airtable.com'),
        expect.objectContaining({ method: 'PATCH' })
      );

      // Verify Slack message update
      expect(fetch).toHaveBeenCalledWith(
        'https://slack.com/api/chat.update',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining(`"type":"context"`)
            && expect.stringContaining(`*${secondaryButtonConfig.label}* by ${baseUser.name}`)
        })
      );

      const updateCall = (fetch as Mock).mock.calls.find(call => call[0] === 'https://slack.com/api/chat.update');
      expect(updateCall).toBeDefined();
      if (updateCall) {
        const updateBody = JSON.parse(updateCall[1].body);
        expect(updateBody.blocks).toEqual([
          expect.objectContaining({ type: 'section' }),
          expect.objectContaining({
            type: 'context',
            elements: [expect.objectContaining({ type: 'mrkdwn', text: `*${secondaryButtonConfig.label}* by ${baseUser.name}` })]
          })
        ]);
      }
    });

    it('handles Slack API errors gracefully when updating message', async () => {
      const primaryButtonConfig: ButtonConfig = { label: 'Test Action', field: 'TestField', value: 'TestValue' };
      const mockSlackPayload = {
        type: 'block_actions',
        actions: [
          {
            action_id: 'primary_action',
            value: JSON.stringify({ recordId: baseRecordId, buttonConfig: primaryButtonConfig, baseId: MOCK_BASE_ID, tableId: MOCK_TABLE_ID }),
          },
        ],
        user: baseUser,
        channel: baseChannel,
        message: baseMessage,
      };

      vi.stubGlobal('fetch', vi.fn().mockImplementation((url) => {
        if (url.includes('api.airtable.com')) {
          return Promise.resolve(new Response('OK'));
        } else if (url.includes('chat.update')) {
          return Promise.resolve(new Response('Error from Slack', { status: 500 }));
        } else {
          return Promise.resolve(new Response('Default OK'));
        }
      }));

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const payloadString = JSON.stringify(mockSlackPayload);
      // Construct the raw URL-encoded body string
      const urlEncodedBody = `payload=${encodeURIComponent(payloadString)}`;

      // Generate the correct signature using the raw body string
      const signature = await generateSlackSignature(mockEnv.SLACK_SIGNING_SECRET, mockTimestamp, urlEncodedBody);

      const request = new IncomingRequest('http://example.com', {
        method: 'POST',
        headers: { // Use calculated signature and set Content-Type
            'X-Slack-Signature': signature,
            'X-Slack-Request-Timestamp': mockTimestamp,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: urlEncodedBody // Use the raw string body
      });

      const ctx = createExecutionContext();
      const response = await worker.fetch(request, mockEnv, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('Interaction handled');

      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('api.airtable.com'),
        expect.objectContaining({ method: 'PATCH' })
      );

      expect(fetch).toHaveBeenCalledWith(
        'https://slack.com/api/chat.update',
        expect.anything()
      );

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining('Failed to update Slack message during interaction handling:'),
        expect.any(Error)
      );

      consoleErrorSpy.mockRestore();
    });

    it('handles Airtable API errors gracefully during interaction', async () => {
      const primaryButtonConfig: ButtonConfig = { label: 'Update Airtable', field: 'AirtableStatus', value: 'Updated' };
      const mockSlackPayload = {
        type: 'block_actions',
        actions: [
          { action_id: 'primary_action', value: JSON.stringify({ recordId: baseRecordId, buttonConfig: primaryButtonConfig, baseId: MOCK_BASE_ID, tableId: MOCK_TABLE_ID }) }
        ],
        user: baseUser, channel: baseChannel, message: baseMessage
      };

      vi.stubGlobal('fetch', vi.fn().mockImplementation((url) => {
        if (url.includes('api.airtable.com')) {
          return Promise.resolve(new Response('Airtable Error', { status: 400 }));
        } else if (url.includes('chat.update')) {
          return Promise.resolve(new Response('OK'));
        }
        return Promise.resolve(new Response('Default OK'));
      }));

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const payloadString = JSON.stringify(mockSlackPayload);
      // Construct the raw URL-encoded body string
      const urlEncodedBody = `payload=${encodeURIComponent(payloadString)}`;

      // Generate the correct signature using the raw body string
      const signature = await generateSlackSignature(mockEnv.SLACK_SIGNING_SECRET, mockTimestamp, urlEncodedBody);

      const request = new IncomingRequest('http://example.com', {
        method: 'POST',
        headers: { // Use calculated signature and set Content-Type
            'X-Slack-Signature': signature,
            'X-Slack-Request-Timestamp': mockTimestamp,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: urlEncodedBody // Use the raw string body
      });

      const ctx = createExecutionContext();
      const response = await worker.fetch(request, mockEnv, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('Interaction handled');

      expect(fetch).toHaveBeenCalledWith(
        expect.stringContaining('api.airtable.com'),
        expect.objectContaining({ method: 'PATCH' })
      );

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Failed to update Airtable record ${baseRecordId}:`),
        expect.any(Error)
      );

      expect(fetch).toHaveBeenCalledWith(
        'https://slack.com/api/chat.update',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining(`*${primaryButtonConfig.label}* by ${baseUser.name}`)
        })
      );

      consoleErrorSpy.mockRestore();
    });
  });

  it('responds with method not allowed for non-POST requests', async () => {
    const request = new IncomingRequest('http://example.com', {
      method: 'GET',
    });

    const ctx = createExecutionContext();
    const response = await worker.fetch(request, mockEnv, ctx);
    await waitOnExecutionContext(ctx);

    expect(response.status).toBe(405);
    expect(await response.text()).toBe('Method not allowed');
  });
});
