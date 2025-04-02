import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach, Mock } from 'vitest';
import worker from '../src/index';
import { Config, AirtableRecord } from '../src/types';
import { mockEnv } from './mockEnv';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Cloudflare Worker', () => {
  beforeEach(() => {
    // Reset all mocks before each test
    vi.resetAllMocks();
  });

  describe('Airtable Webhook Handler', () => {
    it('successfully processes webhook and sends messages to multiple channels', async () => {
      const mockRecord: AirtableRecord = {
        id: 'rec123',
        fields: {
          Name: 'Test Organization',
          Address: '123 Test Street',
          Postcode: 'TE1 1ST',
          Services: 'Service 1\nService 2\nService 3',
        },
      };

      const mockConfig: Config = {
        slackChannelIds: ['C0123456789', 'C9876543210'],
        messageTemplate: `:sparkles: *New Organization Application Received* :sparkles:


:office: *Organization Name:* {Name}


:round_pushpin: *Address:* {Address}
:postbox: *Postcode:* {Postcode}


:gear: *Services Offered:*
{Services}`,
        approveButtonText: "Approve Application",
        includedFields: ["Name", "Address", "Postcode", "Services"],
        statusFieldName: "Status",
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
      expect(global.fetch).toHaveBeenCalledTimes(2);
      mockConfig.slackChannelIds.forEach(channelId => {
        expect(global.fetch).toHaveBeenCalledWith(
          'https://slack.com/api/chat.postMessage',
          expect.objectContaining({
            method: 'POST',
            headers: expect.objectContaining({
              Authorization: `Bearer ${mockEnv.SLACK_BOT_TOKEN}`,
              'Content-Type': 'application/json',
            }),
            body: expect.stringContaining(`"channel":"${channelId}"`),
          })
        );
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
        expect(bodyJson.text).toContain('123 Test Street');
        expect(bodyJson.blocks).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: 'section', text: expect.objectContaining({ type: 'mrkdwn' }) }),
          expect.objectContaining({ 
            type: 'actions', 
            elements: expect.arrayContaining([
              expect.objectContaining({ action_id: 'approve', text: expect.objectContaining({ text: 'Approve Application' }) }),
              expect.objectContaining({ action_id: 'ignore', text: expect.objectContaining({ text: 'Ignore' }) })
            ]) 
          })
        ]));
      });
    });

    it('handles webhook processing errors gracefully', async () => {
      const mockRecord: AirtableRecord = {
        id: 'rec123',
        fields: {
          Name: 'Test Organization',
          Address: '123 Test Street',
          Postcode: 'TE1 1ST',
          Services: 'Service 1\nService 2\nService 3',
        },
      };

      const mockConfig: Config = {
        slackChannelIds: ['C0123456789'],
        messageTemplate: `:sparkles: *New Organization Application Received* :sparkles:


:office: *Organization Name:* {Name}


:round_pushpin: *Address:* {Address}
:postbox: *Postcode:* {Postcode}


:gear: *Services Offered:*
{Services}`,
        approveButtonText: "Approve Application",
        includedFields: ["Name", "Address", "Postcode", "Services"],
        statusFieldName: "Status",
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
    it('handles approve action correctly', async () => {
      const mockSlackPayload = {
        type: 'block_actions',
        actions: [
          {
            action_id: 'approve',
            value: JSON.stringify({ recordId: 'rec123', statusFieldName: 'Status' }),
          },
        ],
        user: { name: 'TestUser' },
        channel: { id: 'C0123456789' },
        message: {
          ts: '1234567890.123456',
          blocks: [
            {
              type: 'section',
              text: { 
                type: 'mrkdwn', 
                text: ':sparkles: *New Organization Application Received* :sparkles:\n\n:office: *Organization Name:* Test Organization' 
              },
            },
            {
              type: 'actions',
              elements: [],
            },
          ],
        },
      };

      global.fetch = vi.fn().mockResolvedValue(new Response('OK'));

      const formData = new FormData();
      formData.append('payload', JSON.stringify(mockSlackPayload));

      const request = new IncomingRequest('http://example.com', {
        method: 'POST',
        headers: {
          'X-Slack-Signature': 'v0=mock_signature',
        },
        body: formData,
      });

      const ctx = createExecutionContext();
      const response = await worker.fetch(request, mockEnv, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('Interaction handled');

      // Verify Airtable update
      expect(global.fetch).toHaveBeenCalledWith(
        `https://api.airtable.com/v0/${mockEnv.AIRTABLE_BASE_ID}/${mockEnv.AIRTABLE_TABLE_NAME}/rec123`,
        expect.objectContaining({
          method: 'PATCH',
          headers: expect.objectContaining({
            Authorization: `Bearer ${mockEnv.AIRTABLE_API_KEY}`,
            'Content-Type': 'application/json',
          }),
          body: JSON.stringify({
            fields: {
              Status: 'Approved',
            },
          }),
        })
      );

      // Verify Slack message update
      expect(global.fetch).toHaveBeenCalledWith(
        'https://slack.com/api/chat.update',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: `Bearer ${mockEnv.SLACK_BOT_TOKEN}`,
            'Content-Type': 'application/json',
          }),
          body: expect.stringContaining('*Approved* by TestUser'),
        })
      );
    });

    it('handles ignore action correctly', async () => {
      const mockSlackPayload = {
        type: 'block_actions',
        actions: [
          {
            action_id: 'ignore',
            value: JSON.stringify({ recordId: 'rec123', statusFieldName: 'Status' }),
          },
        ],
        user: { name: 'TestUser' },
        channel: { id: 'C0123456789' },
        message: {
          ts: '1234567890.123456',
          blocks: [
            {
              type: 'section',
              text: { 
                type: 'mrkdwn', 
                text: ':sparkles: *New Organization Application Received* :sparkles:\n\n:office: *Organization Name:* Test Organization' 
              },
            },
            {
              type: 'actions',
              elements: [],
            },
          ],
        },
      };

      global.fetch = vi.fn().mockResolvedValue(new Response('OK'));

      const formData = new FormData();
      formData.append('payload', JSON.stringify(mockSlackPayload));

      const request = new IncomingRequest('http://example.com', {
        method: 'POST',
        headers: {
          'X-Slack-Signature': 'v0=mock_signature',
        },
        body: formData,
      });

      const ctx = createExecutionContext();
      const response = await worker.fetch(request, mockEnv, ctx);
      await waitOnExecutionContext(ctx);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe('Interaction handled');

      // Verify Slack message update
      expect(global.fetch).toHaveBeenCalledWith(
        'https://slack.com/api/chat.update',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            Authorization: `Bearer ${mockEnv.SLACK_BOT_TOKEN}`,
            'Content-Type': 'application/json',
          }),
          body: expect.stringContaining('*Ignored* by TestUser'),
        })
      );

      // Verify Airtable was not updated for ignore action
      expect(global.fetch).not.toHaveBeenCalledWith(
        `https://api.airtable.com/v0/${mockEnv.AIRTABLE_BASE_ID}/${mockEnv.AIRTABLE_TABLE_NAME}/rec123`,
        expect.any(Object)
      );
    });

    it('handles Slack API errors gracefully', async () => {
      const mockSlackPayload = {
        type: 'block_actions',
        actions: [
          {
            action_id: 'approve',
            value: JSON.stringify({ recordId: 'rec123', statusFieldName: 'Status' }),
          },
        ],
        user: { name: 'TestUser' },
        channel: { id: 'C0123456789' },
        message: {
          ts: '1234567890.123456',
          blocks: [
            {
              type: 'section',
              text: { 
                type: 'mrkdwn', 
                text: ':sparkles: *New Organization Application Received* :sparkles:\n\n:office: *Organization Name:* Test Organization' 
              },
            },
            {
              type: 'actions',
              elements: [],
            },
          ],
        },
      };

      // Use vi.spyOn for console.error
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      // Mock fetch to reject for Slack API calls
      global.fetch = vi.fn().mockImplementation((url) => {
        if (url.includes('slack.com')) {
          return Promise.reject(new Error('Slack API error'));
        }
        return Promise.resolve(new Response('OK'));
      });

      const formData = new FormData();
      formData.append('payload', JSON.stringify(mockSlackPayload));

      const request = new IncomingRequest('http://example.com', {
        method: 'POST',
        headers: {
          'X-Slack-Signature': 'v0=mock_signature',
        },
        body: formData,
      });

      const ctx = createExecutionContext();
      const response = await worker.fetch(request, mockEnv, ctx);
      await waitOnExecutionContext(ctx);

      // Verify that fetch was called at least once
      expect(global.fetch).toHaveBeenCalled();
      
      // Verify that the error was logged
      expect(errorSpy).toHaveBeenCalled();

      // Restore console.error AFTER checking the mock
      errorSpy.mockRestore();

      expect(response.status).toBe(200); // Still returns 200 as we don't want to retry
      expect(await response.text()).toBe('Interaction handled');
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
