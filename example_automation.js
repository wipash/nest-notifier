// =======================================================================
// CONFIGURATION - Modify the values below for your specific notification
// =======================================================================

// --- Worker ---
// The URL of your deployed Cloudflare Worker
const WORKER_URL = "https://nest-notifier.your-domain.workers.dev/"; // <-- CHANGE THIS

// --- Message Content ---
// The template for the Slack message.
// Use {FieldName} placeholders, where FieldName matches your Airtable field name exactly (case-sensitive).
const MESSAGE_TEMPLATE = `
:sparkles: *New Organization Application Received* :sparkles:

:office: *Organization Name:* {Name}

:round_pushpin: *Address:* {Address}
:postbox: *Postcode:* {Postcode}

:gear: *Services Offered:*
{Services}`; // <-- CHANGE THIS template as needed

// --- Buttons ---
// Configure the interactive buttons. Set to null or {} to disable a button.
const PRIMARY_BUTTON_CONFIG = {
    label: "Approve Application", // Text displayed on the button (Required if button is enabled)
    field: "Status",              // Airtable field name to update on click (Optional, case-sensitive)
    value: "Approved"             // Value to set in the specified 'field' (Optional)
}; // <-- CHANGE THIS button configuration

const SECONDARY_BUTTON_CONFIG = {
    label: "Reject",              // Text displayed on the button (Required if button is enabled)
    field: "Status",              // Airtable field name to update on click (Optional, case-sensitive)
    value: "Rejected"             // Value to set in the specified 'field' (Optional)
}; // <-- CHANGE THIS button configuration
// Example: Button with no Airtable update: { label: "Acknowledge" }
// Example: Disable secondary button: const SECONDARY_BUTTON_CONFIG = null;

// --- Slack Channels ---
// How to determine the Slack channels? Choose ONE method:

// Method 1: Static List of Channel IDs (if using this, set USE_LINKED_RECORDS_FOR_CHANNELS = false below)
const STATIC_SLACK_CHANNEL_IDS = ["C0XXXXXXX", "C0YYYYYYY"]; // <-- CHANGE THIS if using Method 1

// Method 2: Get Channel IDs from Linked Records (Recommended for flexibility)
const USE_LINKED_RECORDS_FOR_CHANNELS = true; // Set to true to use Method 2, false for Method 1
const TRIGGERING_RECORD_LINKED_FIELD = "Branches"; // <-- CHANGE THIS: Field name in *this* table that links to the table below
const LINKED_TABLE_NAME = "Branches"; // <-- CHANGE THIS: Name of the table containing the Slack Channel IDs
const LINKED_TABLE_CHANNEL_ID_FIELD = "Slack channel ID"; // <-- CHANGE THIS: Field name in the linked table that holds the Slack Channel ID

// =======================================================================
// END OF CONFIGURATION - Do not modify below unless you know what you are doing
// =======================================================================

// --- Script Logic ---

// Get the triggering record data passed from the Airtable automation step
let inputRecord = input.config();

// Basic validation of the input record data
if (!inputRecord || !inputRecord.id || !inputRecord.fields) {
  console.error("Error: Invalid or missing record data (id or fields) from trigger step. Check automation configuration.");
  return; // Stop execution
}

// Determine Slack Channel IDs based on the chosen method
let slackChannelIds = [];
if (USE_LINKED_RECORDS_FOR_CHANNELS) {
    // Method 2: Get IDs from linked records
    const linkedRecordIds = inputRecord.fields[TRIGGERING_RECORD_LINKED_FIELD];
    if (Array.isArray(linkedRecordIds) && linkedRecordIds.length > 0) {
        // Extract just the record IDs if the trigger provides linked record objects
        const finalLinkedIds = linkedRecordIds.map(item => item.id || item);
        slackChannelIds = await getSlackChannelIdsFromLinkedRecords(finalLinkedIds, LINKED_TABLE_NAME, LINKED_TABLE_CHANNEL_ID_FIELD);
    } else {
        console.warn(`Warning: Field '${TRIGGERING_RECORD_LINKED_FIELD}' is empty or not an array of linked records for record ${inputRecord.id}.`);
    }
} else {
    // Method 1: Use static list
    if (Array.isArray(STATIC_SLACK_CHANNEL_IDS) && STATIC_SLACK_CHANNEL_IDS.length > 0) {
        slackChannelIds = STATIC_SLACK_CHANNEL_IDS;
    } else {
         console.warn("Warning: Static Slack Channel ID list is empty or invalid.");
    }
}

// Stop if no valid Slack channels were found
if (!slackChannelIds || slackChannelIds.length === 0) {
    console.error(`Error: No valid Slack Channel IDs found for record ${inputRecord.id}. Notification not sent.`);
    return; // Stop execution
}

// Prepare the configuration part of the payload for the Cloudflare Worker
const workerConfig = {
  slackChannelIds: slackChannelIds,
  messageTemplate: MESSAGE_TEMPLATE,
  // Only include button configs if they are not null/empty and have a label
  ...(PRIMARY_BUTTON_CONFIG && PRIMARY_BUTTON_CONFIG.label && { primaryButton: PRIMARY_BUTTON_CONFIG }),
  ...(SECONDARY_BUTTON_CONFIG && SECONDARY_BUTTON_CONFIG.label && { secondaryButton: SECONDARY_BUTTON_CONFIG }),
};

// Prepare the full payload
// IMPORTANT: This assumes inputRecord.fields contains all necessary fields for the template.
let payload = {
  record: {
    id: inputRecord.id,
    fields: inputRecord.fields // Pass all fields from the trigger; worker will use what it needs
  },
  config: workerConfig
};

// Send the webhook POST request to the Cloudflare Worker
console.log(`Sending notification for record ${inputRecord.id} to channels: ${slackChannelIds.join(', ')}...`);
try {
    let response = await fetch(WORKER_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`Error sending webhook to ${WORKER_URL}. Status: ${response.status} ${response.statusText}. Response Body: ${errorBody}`);
    } else {
      console.log(`Webhook sent successfully to ${WORKER_URL}. Status: ${response.status}`);
    }
} catch (error) {
    console.error(`Network or runtime error during fetch call to ${WORKER_URL}:`, error);
}

// --- Helper Function ---

// Fetches Slack Channel IDs for given Record IDs from a specified linked table
async function getSlackChannelIdsFromLinkedRecords(linkedRecordIds, linkedTableName, channelIdFieldName) {
  // Ensure linkedRecordIds is a non-empty array
  if (!Array.isArray(linkedRecordIds) || linkedRecordIds.length === 0) {
      console.warn("No linked record IDs provided to helper function.");
      return [];
  }

  try {
    console.log(`Fetching Slack IDs from table '${linkedTableName}' for ${linkedRecordIds.length} linked records.`);
    let table = base.getTable(linkedTableName);
    let query = await table.selectRecordsAsync({
        recordIds: linkedRecordIds, // Filter by specific record IDs
        fields: [channelIdFieldName] // Only fetch the necessary field
    });

    // Map results to channel IDs and filter out empty/invalid values
    const channelIds = query.records
      .map(record => record.getCellValueAsString(channelIdFieldName))
      .filter(channelId => channelId && channelId.trim().startsWith('C') || channelId.trim().startsWith('G')); // Basic Slack ID validation

    if (channelIds.length === 0) {
        console.warn(`No valid Slack Channel IDs found in field '${channelIdFieldName}' of table '${linkedTableName}' for the provided linked records.`);
    }
    return channelIds;

  } catch (error) {
      console.error(`Error fetching Slack Channel IDs from table '${linkedTableName}':`, error);
      return []; // Return empty array on error
  }
}
