# Nest Notifier - Cloudflare Worker

## Overview

Nest Notifier is a Cloudflare Worker that acts as an intelligent bridge between Airtable and Slack. It allows you to trigger notifications in Slack based on Airtable data, complete with interactive buttons that can update the original Airtable record and modify the Slack message itself to reflect the action taken.

This worker listens for incoming webhooks (typically triggered by an Airtable Automation), formats the data into a customizable Slack message using Block Kit, posts it to specified channels, and handles user interactions (button clicks) on those messages.

## Features

*   **Webhook Listener:** Accepts `POST` requests containing Airtable record data and configuration.
*   **Dynamic Slack Message Formatting:** Uses Slack's Block Kit and a configurable template to create rich messages.
*   **Interactive Buttons:** Adds configurable primary and secondary buttons to Slack messages.
*   **Airtable Integration:** Updates specified fields in an Airtable record when an interactive button is clicked (if configured).
*   **Slack Message Updates:** Modifies the original Slack message after an interaction to show the action taken and remove the buttons.
*   **Multi-Channel Support:** Can send notifications to multiple Slack channels simultaneously.
*   **Configurable via Payload:** Message templates, target channels, and button actions are defined within the incoming webhook payload, making the worker flexible.


## Workflow

1.  **Trigger:** An external system (e.g., an Airtable Automation Script) sends a `POST` request to the deployed Cloudflare Worker URL. The request body contains Airtable `record` data and a `config` object.
2.  **Format & Post:** The Worker receives the webhook, uses the `config.messageTemplate` and `record.fields` to format a Slack message, adds buttons based on `config.primaryButton` / `config.secondaryButton`, and posts it to the channels listed in `config.slackChannelIds` using the Slack `chat.postMessage` API.
3.  **Interaction:** A user in Slack clicks one of the buttons on the message.
4.  **Handle Interaction:** Slack sends a `POST` request (with interaction details) to the Worker's interactivity URL (which should be the same Worker URL).
5.  **Update Airtable (Optional):** If the clicked button's `config` included a `field` and `value`, the Worker makes a `PATCH` request to the Airtable API to update the corresponding record.
6.  **Update Slack:** The Worker uses the Slack `chat.update` API to modify the original message, replacing the buttons with a context message indicating which button was clicked and by whom.

## Prerequisites

*   [Node.js](https://nodejs.org/)
*   [pnpm](https://pnpm.io/installation)
*   A [Cloudflare Account](https://dash.cloudflare.com/sign-up)
*   [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install/) installed and authenticated (`wrangler login`)
*   An [Airtable Account](https://airtable.com/)
*   A [Slack Workspace](https://slack.com/) where you can install apps.

## Setup

1.  **Clone the repository:**
    ```bash
    git clone https://github.com/wipash/nest-notifier
    cd nest-notifier
    ```

2.  **Install dependencies:**
    ```bash
    pnpm install
    ```

## Configuration

The worker relies on environment variables and secrets.

**1. Local Development (`.dev.vars`)**

For local development using `wrangler dev`, create a `.dev.vars` file in the project root. **Do not commit this file to version control.**

```ini
# .dev.vars
SLACK_BOT_TOKEN=xoxb-your-slack-bot-token
AIRTABLE_API_KEY=patYourAirtablePersonalAccessTokenOrApiKey
SLACK_SIGNING_SECRET=your_slack_signing_secret_here
AIRTABLE_WEBHOOK_SECRET=your_generated_airtable_webhook_secret_here
# AIRTABLE_BASE_ID and AIRTABLE_TABLE_NAME can also be put here
# for local dev if you prefer, overriding wrangler.toml values locally.
# AIRTABLE_BASE_ID=appXXXXXXXXXXXXXX
# AIRTABLE_TABLE_NAME=YourTableName
```

**2. Production Configuration (`wrangler.toml` and Secrets)**

*   **`wrangler.toml`:** This file contains non-sensitive configuration like the worker name, entry point, compatibility settings.

*   **Cloudflare Secrets:** Sensitive information like API keys **must** be stored as encrypted secrets using Wrangler.

    ```bash
    wrangler secret put SLACK_BOT_TOKEN
    # Paste your Slack Bot Token when prompted

    wrangler secret put AIRTABLE_API_KEY
    # Paste your Airtable API Key/Personal Access Token when prompted

    wrangler secret put SLACK_SIGNING_SECRET
    wrangler secret put AIRTABLE_WEBHOOK_SECRET
    ```

**Required Variables/Secrets Summary:**

*   `SLACK_BOT_TOKEN`: Your Slack Bot User OAuth Token (starts with `xoxb-`). **Store as Cloudflare Secret.**
*   `AIRTABLE_API_KEY`: Your Airtable Personal Access Token (preferred) or legacy API Key. **Store as Cloudflare Secret.**
*   `SLACK_SIGNING_SECRET`: Your Slack App's Signing Secret (from Slack App settings -> Basic Information). **Store as Cloudflare Secret.**
*   `AIRTABLE_WEBHOOK_SECRET`: A strong, random secret you generate for authenticating requests from Airtable. This secret must be included in the `X-Webhook-Secret` header of requests from your Airtable automation script. **Store as Cloudflare Secret.**
## Running Locally

To run the worker locally for development and testing:

```bash
pnpm run dev
```

Wrangler will start a local server, typically on `http://localhost:8787`. It will use the variables defined in your `.dev.vars` file. You can send test webhook requests to this local URL.

## Running Tests

To run the automated tests:

```bash
pnpm test
```

This command executes the test suite defined in `src/**/*.spec.ts` using `vitest` within a simulated Cloudflare Workers environment.

## Deployment

Ensure you have configured your production secrets using `wrangler secret put`.

To deploy the worker to your Cloudflare account:

```bash
pnpm run deploy
```

Wrangler will build and upload your worker. After deployment, it will output the URL where your worker is accessible (e.g., `https://nest-notifier.<your-account-subdomain>.workers.dev`). Use this URL for setting up Airtable Automations and Slack Interactivity.

## Usage

To use the deployed worker, you need to configure Airtable and Slack, and then trigger the worker with the correct payload.

**1. Airtable Setup**

*   **Base and Table:** The worker interacts with the specific Base and Table determined by the `recordUrl` provided in the Airtable Automation script. Ensure your Airtable API Key has the necessary permissions for the target Base(s).
*   **Fields:** Your trigger table should contain:
    *   The fields you want to display in Slack (referenced like `{FieldName}` in the `MESSAGE_TEMPLATE` within the automation script).
    *   Any fields you intend to update via button clicks (referenced in `PRIMARY_BUTTON_CONFIG.field` / `SECONDARY_BUTTON_CONFIG.field` within the automation script, e.g., a `Status` field).
    *   A linked record field connecting to another table that stores Slack Channel IDs.
*   **API Key/Personal Access Token:**
    *   Go to your Airtable Account Developer Hub: [https://airtable.com/developers/web/guides/personal-access-tokens](https://airtable.com/developers/web/guides/personal-access-tokens)
    *   Create a new Personal Access Token.
    *   Grant it the following scopes for your target Base(s):
        *   `data.records:read` (Required by the script to fetch record data)
        *   `data.records:write` (Required by the worker to update records via buttons)
        *   `schema.bases:read` (Required by the script to read table/field info)
    *   Copy the generated token (e.g., `patXXXXXXXXXXXXXX`) and store it as the `AIRTABLE_API_KEY` secret using Wrangler (`wrangler secret put AIRTABLE_API_KEY`).
*   **Triggering the Webhook (Airtable Automation):**
    *   Go to the "Automations" tab in your Airtable Base.
    *   Create a new Automation. Choose a trigger (e.g., "When record matches conditions", "When record enters view", "When record updated").
    *   Add an action: "Run script".
    *   **Configure Script Input Variables:** This is critical for the script to identify the correct record, table, and linked channels. In the "Input variables" section on the right panel of the "Run script" action:
        *   Click "+ Add input variable".
        *   Set the **Name** to match the `INPUT_VARIABLE_FOR_RECORD_URL` constant in the script (e.g., `recordUrl` by default). This URL will be used to extract both the Table ID and the Record ID.
        *   Set the **Value** using the blue "+" button -> select the trigger record -> `Airtable record URL`.
        *   Click "+ Add input variable" again.
        *   Set the **Name** to match the `INPUT_VARIABLE_FOR_LINKED_IDS` constant in the script (e.g., `branches` by default).
        *   Set the **Value** using the blue "+" button -> select the trigger record -> `Insert value from field` -> choose the field that links to your table containing Slack Channel IDs (e.g., the "Branches" field) -> `Make a new list of...` -> choose 'Linked record' -> ID
    *   **Paste the Script:** Copy the contents of `example-automation.js` into the script editor.
    *   **Customize Script Configuration:** Modify the `CONFIGURATION` block at the top of the pasted script:
        *   Set `WORKER_URL` to your deployed Cloudflare Worker URL.
        *   Customize `MESSAGE_TEMPLATE` with your desired Slack message format and `{FieldName}` placeholders (e.g., `{Name}`, `{Street}`, `{City}`, `{Postcode}`, `{Services offered}`).
        *   Configure `PRIMARY_BUTTON_CONFIG` and `SECONDARY_BUTTON_CONFIG` as needed (e.g., set `value` for primary button to `"Approved"`, leave secondary button with only `label: "Ignore"`).
        *   Ensure `INPUT_VARIABLE_FOR_RECORD_URL`, and `INPUT_VARIABLE_FOR_LINKED_IDS` match the names you gave the input variables in the UI.
        *   Ensure `LINKED_TABLE_NAME`, and `LINKED_TABLE_CHANNEL_ID_FIELD` correctly point to how your Slack Channel IDs are stored and linked (e.g., `LINKED_TABLE_CHANNEL_ID_FIELD = "Branch channel ID"`).
        *   Configure `AIRTABLE_WEBHOOK_SECRET` to match what was deployed to CloudFlare. This secret will be sent in the `X-Webhook-Secret` header of the webhook request to authenticate it.
    *   **Test:** Use the "Test action" button to run the script with a sample record. Check the output logs for success messages or errors (e.g., verifying extracted Table ID and Record ID). Ensure the payload looks correct and the subsequent webhook call works.
**2. Slack Setup**

*   **Create a Slack App:**
    *   Go to [https://api.slack.com/apps](https://api.slack.com/apps) and click "Create New App".
    *   Choose "From scratch", name it (e.g., "Airtable Notifier"), and select your workspace.
*   **Add Bot Token Scopes:**
    *   Navigate to "OAuth & Permissions" in the sidebar.
    *   Scroll down to "Scopes" -> "Bot Token Scopes".
    *   Add the following scopes:
        *   `chat:write`: Allows the bot to post and update messages.
*   **Install App to Workspace:**
    *   Scroll back up on the "OAuth & Permissions" page and click "Install to Workspace".
    *   Authorize the installation.
    *   Copy the "Bot User OAuth Token" (starts with `xoxb-`). This is your `SLACK_BOT_TOKEN`. Store it as a secret using Wrangler.
*   **Enable Interactivity:**
    *   Navigate to "Interactivity & Shortcuts" in the sidebar.
    *   Toggle Interactivity ON.
    *   In the "Request URL" field, enter your deployed Cloudflare Worker URL (e.g., `https://nest-notifier.<your-account-subdomain>.workers.dev`).
    *   Click "Save Changes".
*   **Get Channel IDs:**
    *   For each public channel you want the bot to post in: Right-click the channel name in Slack, select "Copy Link". The last part of the URL (starting with `C`) is the Channel ID.
    *   For private channels: You might need to view page source or use other methods, but copying the link often works too. The ID will start with `G`.
    *   Use these IDs in the `slackChannelIds` array within your Airtable Automation script's `config`.
*   **Invite Bot to Channels:** Manually invite the bot user (e.g., `@Airtable Notifier`) to each Slack channel listed in `slackChannelIds`. The bot cannot post messages in channels it hasn't joined.

**3. Sending the Webhook Payload**

As demonstrated in the Airtable Automation script, you need to send a `POST` request to your worker's URL with a JSON body structured like this:

```json
{
  "record": {
    "id": "recXXXXXXXXXXXXXX", // The Airtable Record ID
    "fields": {
      // Key-value pairs of field names and their values from Airtable
      "Name": "Example Org Application",
      "Street": "123 Main St",
      "Suburb": "Newtown",
      "City": "Anytown",
      "Postcode": "12345",
      "Services offered": "Service A, Service B",
      "Status": "Pending Verification"
      // ... other fields ...
    }
  },
  "config": {
    "baseId": "appXXXXXXXXXXXXXX", // Added: The Airtable Base ID
    "tableId": "tblXXXXXXXXXXXXXX", // Added: The Airtable Table ID
    "slackChannelIds": ["C0123456789", "C9876543210"], // Array of Slack Channel IDs
    "messageTemplate": ":page_facing_up: *New Organization Application for Verification*\\n\\n*Organization:* {Name}\\n\\n*Address:*\\n> {Street}\\n> {Suburb}\\n> {City}\\n> {Postcode}\\n\\n*Services Offered:*\\n> {Services offered}", // Message format with {FieldName} placeholders matching example-automation.js
    "primaryButton": { // Optional
      "label": "Approve Application", // Button text
      "field": "Status", // Airtable field to update
      "value": "Approved" // Value to set in the field (matching example-automation.js)
    },
    "secondaryButton": { // Optional - Example without Airtable update (matching example-automation.js)
      "label": "Ignore"
    }
  }
}
```

**4. Interaction Flow**

When a user clicks a button ("Approve Application" or "Ignore" in the example above):

1.  Slack sends the interaction data to your worker's Request URL.
2.  The worker extracts the `recordId`, `baseId`, `tableId`, and `buttonConfig` (label, field, value) from the interaction payload.
3.  If `field` and `value` are present in the `buttonConfig` (like for "Approve Application"), the worker updates the Airtable record (`recXXXXXXXXXXXXXX` in the example, using the provided `baseId` and `tableId`) by setting the `Status` field to "Approved". If `field` and `value` are missing (like for "Ignore"), no Airtable update occurs.
4.  The worker updates the original Slack message, replacing the buttons with text like "`*Approve Application* by SlackUserName`".

## Contributing

Contributions are welcome! Please feel free to submit pull requests or open issues.

## License

MIT
