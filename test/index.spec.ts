import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import worker from '../src/index';
import { Config, AirtableRecord, ButtonConfig } from '../src/types';
import { mockEnv } from './mockEnv';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Cloudflare Worker', () => {
  beforeEach(() => {
    // Reset all mocks before each test
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
        slackChannelIds: ['C0123456789', 'C9876543210'],
        messageTemplate: `:sparkles: *New Request* :sparkles:\nName: {Name}\nAddress: {Address}`,
        primaryButton: mockPrimaryButton,
        secondaryButton: mockSecondaryButton
      };

      const mockPayload = { record: mockRecord, config: mockConfig };

      global.fetch = vi.fn().mockResolvedValue(new Response('OK'));

      const request = new IncomingRequest('http://example.com', {
        method: 'POST',
        body: JSON.stringify(mockPayload),
      });

      const ctx = createExecutionContext();
      const response = await worker.fetch(request, mockEnv, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('Webhook processed');

      // Verify messages were sent to all channels
      expect(global.fetch).toHaveBeenCalledTimes(mockConfig.slackChannelIds.length);

      mockConfig.slackChannelIds.forEach(channelId => {
        const matchingCall = (global.fetch as Mock).mock.calls.find((call: any[]) => {
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
                value: JSON.stringify({ recordId: mockRecord.id, buttonConfig: mockPrimaryButton })
              }),
              expect.objectContaining({
                action_id: 'secondary_action',
                text: expect.objectContaining({ text: mockSecondaryButton.label }),
                value: JSON.stringify({ recordId: mockRecord.id, buttonConfig: mockSecondaryButton })
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
        slackChannelIds: ['CError123'],
        messageTemplate: 'Error template for {Name}',
        primaryButton: { label: 'Error Button' }
      };
      const mockPayload = { record: mockRecord, config: mockConfig };

      global.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const request = new IncomingRequest('http://example.com', {
        method: 'POST',
        body: JSON.stringify(mockPayload),
      });

      const ctx = createExecutionContext();
      const response = await worker.fetch(request, mockEnv, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(500);
      expect(await response.text()).toBe('Error processing webhook');
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
            value: JSON.stringify({ recordId: baseRecordId, buttonConfig: primaryButtonConfig }),
          },
        ],
        user: baseUser,
        channel: baseChannel,
        message: baseMessage,
      };

      global.fetch = vi.fn().mockResolvedValue(new Response('OK'));

      const formData = new FormData();
      formData.append('payload', JSON.stringify(mockSlackPayload));
      const request = new IncomingRequest('http://example.com', { method: 'POST', headers: {'X-Slack-Signature': 'v0=mock'}, body: formData });

      const ctx = createExecutionContext();
      const response = await worker.fetch(request, mockEnv, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);

      // Verify Airtable update
      expect(global.fetch).toHaveBeenCalledWith(
        `https://api.airtable.com/v0/${mockEnv.AIRTABLE_BASE_ID}/${mockEnv.AIRTABLE_TABLE_NAME}/${baseRecordId}`,
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
      expect(global.fetch).toHaveBeenCalledWith(
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

      const updateCall = (global.fetch as Mock).mock.calls.find(call => call[0] === 'https://slack.com/api/chat.update');
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
            value: JSON.stringify({ recordId: baseRecordId, buttonConfig: secondaryButtonConfig }),
          },
        ],
        user: baseUser,
        channel: baseChannel,
        message: baseMessage,
      };

      global.fetch = vi.fn().mockResolvedValue(new Response('OK'));

      const formData = new FormData();
      formData.append('payload', JSON.stringify(mockSlackPayload));
      const request = new IncomingRequest('http://example.com', { method: 'POST', headers: {'X-Slack-Signature': 'v0=mock'}, body: formData });

      const ctx = createExecutionContext();
      const response = await worker.fetch(request, mockEnv, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);

      // Verify Airtable was NOT updated
      expect(global.fetch).not.toHaveBeenCalledWith(
        expect.stringContaining('api.airtable.com'),
        expect.objectContaining({ method: 'PATCH' })
      );

      // Verify Slack message update
      expect(global.fetch).toHaveBeenCalledWith(
        'https://slack.com/api/chat.update',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining(`"type":"context"`)
            && expect.stringContaining(`*${secondaryButtonConfig.label}* by ${baseUser.name}`)
        })
      );

      const updateCall = (global.fetch as Mock).mock.calls.find(call => call[0] === 'https://slack.com/api/chat.update');
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
            value: JSON.stringify({ recordId: baseRecordId, buttonConfig: primaryButtonConfig }),
          },
        ],
        user: baseUser,
        channel: baseChannel,
        message: baseMessage,
      };

      global.fetch = vi.fn().mockImplementation((url) => {
        if (url.includes('api.airtable.com')) {
          return Promise.resolve(new Response('OK'));
        } else if (url.includes('chat.update')) {
          return Promise.resolve(new Response('Error from Slack', { status: 500 }));
        } else {
          return Promise.resolve(new Response('Default OK'));
        }
      });

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const formData = new FormData();
      formData.append('payload', JSON.stringify(mockSlackPayload));
      const request = new IncomingRequest('http://example.com', { method: 'POST', headers: {'X-Slack-Signature': 'v0=mock'}, body: formData });

      const ctx = createExecutionContext();
      const response = await worker.fetch(request, mockEnv, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('Interaction handled');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('api.airtable.com'),
        expect.objectContaining({ method: 'PATCH' })
      );

      expect(global.fetch).toHaveBeenCalledWith(
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
          { action_id: 'primary_action', value: JSON.stringify({ recordId: baseRecordId, buttonConfig: primaryButtonConfig }) }
        ],
        user: baseUser, channel: baseChannel, message: baseMessage
      };

      global.fetch = vi.fn().mockImplementation((url) => {
        if (url.includes('api.airtable.com')) {
          return Promise.resolve(new Response('Airtable Error', { status: 400 }));
        } else if (url.includes('chat.update')) {
          return Promise.resolve(new Response('OK'));
        }
        return Promise.resolve(new Response('Default OK'));
      });

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const formData = new FormData();
      formData.append('payload', JSON.stringify(mockSlackPayload));
      const request = new IncomingRequest('http://example.com', { method: 'POST', headers: {'X-Slack-Signature': 'v0=mock'}, body: formData });

      const ctx = createExecutionContext();
      const response = await worker.fetch(request, mockEnv, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('Interaction handled');

      expect(global.fetch).toHaveBeenCalledWith(
        expect.stringContaining('api.airtable.com'),
        expect.objectContaining({ method: 'PATCH' })
      );

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        expect.stringContaining(`Failed to update Airtable record ${baseRecordId}:`),
        expect.any(Error)
      );

      expect(global.fetch).toHaveBeenCalledWith(
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
