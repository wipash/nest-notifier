// =======================================================================
// CONFIGURATION - Modify the values below for your specific notification
// =======================================================================

// --- Message Content ---
// The template for the Slack message.
// Use {FieldName} placeholders, where FieldName matches your Airtable field name exactly (case-sensitive).
const MESSAGE_TEMPLATE = `
:page_facing_up: *New Organization Application for Verification*

*Organization:* {Name}

*Location Details:*
> {Address}
> {Postcode}

*Services Offered:*
> {Services}
`; // <-- CHANGE THIS template as needed

// --- Buttons ---
// Configure the interactive buttons. Set to null or {} to disable a button.
const PRIMARY_BUTTON_CONFIG = {
    label: "Approve Application", // Text displayed on the button (Required if button is enabled)
    field: "Status",              // Airtable field name to update on click (Optional, case-sensitive)
    value: "approved"             // Value to set in the specified 'field' (Optional)
}; // <-- CHANGE THIS button configuration

const SECONDARY_BUTTON_CONFIG = {
    label: "Ignore",              // Text displayed on the button (Required if button is enabled)
    field: "Status",              // Airtable field name to update on click (Optional, case-sensitive)
    value: "ignored"             // Value to set in the specified 'field' (Optional)
}; // <-- CHANGE THIS button configuration
// Example: Button with no Airtable update: { label: "Acknowledge" }
// Example: Disable secondary button: const SECONDARY_BUTTON_CONFIG = null;

// --- Slack Channels (Fetched from Linked Records) ---
// Field name in *this* table that links to the table containing channel IDs.
// This field should contain linked record references (usually an array).
const TRIGGERING_RECORD_LINKED_FIELD = "Branches"; // <-- CHANGE THIS

// Name of the Airtable table where the Slack Channel IDs are stored.
const LINKED_TABLE_NAME = "Branches"; // <-- CHANGE THIS

// Field name in the linked table (specified above) that holds the actual Slack Channel ID string (e.g., C0XXXXXXX).
const LINKED_TABLE_CHANNEL_ID_FIELD = "Slack channel ID"; // <-- CHANGE THIS

// =======================================================================
// END OF CONFIGURATION - Do not modify below unless you know what you are doing
// =======================================================================

// --- Script Logic ---

// --- Worker URL ---
// The URL of your deployed Cloudflare Worker
const WORKER_URL = "https://nest-notifier.your-domain.workers.dev/";

// Get the triggering record data passed from the Airtable automation step
let inputRecord = input.config();

// Basic validation of the input record data
if (!inputRecord || !inputRecord.id || !inputRecord.fields) {
  console.error("Error: Invalid or missing record data (id or fields) from trigger step. Check automation configuration.");
  return; // Stop execution
}

// Get the linked record IDs from the specified field in the triggering record
const linkedRecordIdsRaw = inputRecord.fields[TRIGGERING_RECORD_LINKED_FIELD];
let linkedRecordIds = [];

// Process the linked record field (it's usually an array of objects with an 'id' property)
if (Array.isArray(linkedRecordIdsRaw) && linkedRecordIdsRaw.length > 0) {
    linkedRecordIds = linkedRecordIdsRaw.map(item => item && item.id).filter(id => id); // Extract IDs safely
} else {
    console.warn(`Warning: Field '${TRIGGERING_RECORD_LINKED_FIELD}' is empty or not an array of linked records for record ${inputRecord.id}.`);
}

// Fetch Slack Channel IDs using the helper function if we have linked record IDs
let slackChannelIds = [];
if (linkedRecordIds.length > 0) {
    slackChannelIds = await getSlackChannelIdsFromLinkedRecords(linkedRecordIds, LINKED_TABLE_NAME, LINKED_TABLE_CHANNEL_ID_FIELD);
} else {
     console.warn(`Warning: No linked record IDs found in field '${TRIGGERING_RECORD_LINKED_FIELD}' to fetch channel IDs from.`);
}


// Stop if no valid Slack channels were found
if (!slackChannelIds || slackChannelIds.length === 0) {
    console.error(`Error: No valid Slack Channel IDs could be determined for record ${inputRecord.id}. Notification not sent.`);
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
      // This case is handled before calling, but added for safety
      console.warn("Helper Function: No linked record IDs provided.");
      return [];
  }

  try {
    console.log(`Fetching Slack IDs from table '${linkedTableName}' (field '${channelIdFieldName}') for ${linkedRecordIds.length} linked records.`);
    let table = base.getTable(linkedTableName);
    let query = await table.selectRecordsAsync({
        recordIds: linkedRecordIds, // Filter by specific record IDs
        fields: [channelIdFieldName] // Only fetch the necessary field
    });

    // Map results to channel IDs and filter out empty/invalid values
    const channelIds = query.records
      .map(record => record.getCellValueAsString(channelIdFieldName))
      .filter(channelId => channelId && (channelId.trim().startsWith('C') || channelId.trim().startsWith('G'))); // Basic Slack ID validation (Public/Private Channel)

    if (channelIds.length === 0) {
        console.warn(`Warning: No valid Slack Channel IDs found in field '${channelIdFieldName}' of table '${linkedTableName}' for the provided linked records.`);
    } else {
         console.log(`Found ${channelIds.length} valid Slack Channel ID(s).`);
    }
    return channelIds;

  } catch (error) {
      console.error(`Error fetching Slack Channel IDs from table '${linkedTableName}':`, error);
      return []; // Return empty array on error
  }
}
