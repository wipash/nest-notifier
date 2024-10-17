import { env, createExecutionContext, waitOnExecutionContext, SELF } from 'cloudflare:test';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import worker from '../src/index';
import { Config, AirtableRecord } from '../src/types';
import { mockEnv } from './mockEnv';

const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

describe('Cloudflare Worker', () => {
  beforeEach(() => {
    // Reset all mocks before each test
    vi.resetAllMocks();
  });

  it('handles Airtable webhook (unit style)', async () => {
    const mockRecord: AirtableRecord = {
      id: 'rec123',
      fields: {
        Name: 'John Doe',
        Email: 'john@example.com',
      },
    };

    const mockConfig: Config = {
      slackChannelId: 'C0123456789',
      messageTemplate: 'New application from {Name}. Email: {Email}',
      buttonText: 'Approve Application',
      includedFields: ['Name', 'Email'],
      statusFieldName: 'Status',
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

    // Check if fetch was called with correct Slack API parameters
    expect(global.fetch).toHaveBeenCalledWith(
      'https://slack.com/api/chat.postMessage',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: `Bearer ${mockEnv.SLACK_BOT_TOKEN}`,
          'Content-Type': 'application/json',
        }),
        body: expect.stringContaining('New application from John Doe. Email: john@example.com'),
      })
    );
  });

  it('handles Slack interaction (unit style)', async () => {
    const mockSlackPayload = {
      type: 'block_actions',
      actions: [
        {
          action_id: 'approve_application',
          value: JSON.stringify({ recordId: 'rec123', statusFieldName: 'Status' }),
        },
      ],
      container: {
        channel_id: 'C0123456789',
        message_ts: '1234567890.123456',
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

    // Check if fetch was called to update Airtable
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

    // Check if fetch was called to update Slack message
    expect(global.fetch).toHaveBeenCalledWith(
      'https://slack.com/api/chat.update',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: `Bearer ${mockEnv.SLACK_BOT_TOKEN}`,
          'Content-Type': 'application/json',
        }),
        body: expect.stringContaining('Application approved!'),
      })
    );
  });

  it('responds with method not allowed for non-POST requests (integration style)', async () => {
    const response = await SELF.fetch('https://example.com');
    expect(response.status).toBe(405);
    expect(await response.text()).toBe('Method not allowed');
  });
});
