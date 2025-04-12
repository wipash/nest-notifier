// =======================================================================
// CONFIGURATION - Modify the values below AND ensure corresponding inputs
//                 are configured in the Airtable Automation UI!
// =======================================================================

// --- Message Content ---
// The template for the Slack message.
// Use {FieldName} placeholders, where FieldName matches your Airtable field name exactly (case-sensitive).
// The script will automatically fetch these fields from the triggering record.
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

// --- Airtable Setup ---
// Name of the INPUT VARIABLE (configured in UI) that holds the name of the table this automation is running on.
const INPUT_VARIABLE_FOR_TABLE_NAME = "triggeringTableName"; // <-- CHANGE THIS to match Input Variable Name in UI

// --- Slack Channels (Fetched from Linked Records) ---
// Name of the INPUT VARIABLE (configured in UI) that holds the linked record IDs from the triggering record.
// This input variable should be configured in the Airtable UI to pass the value of the linked record field.
const INPUT_VARIABLE_FOR_LINKED_IDS = "branches"; // <-- CHANGE THIS to match Input Variable Name in UI

// Name of the Airtable table where the Slack Channel IDs are stored.
const LINKED_TABLE_NAME = "Branches"; // <-- CHANGE THIS

// Field name in the linked table that holds the actual Slack Channel ID string.
const LINKED_TABLE_CHANNEL_ID_FIELD = "Slack channel ID"; // <-- CHANGE THIS

// --- Record ID ---
// Name of the INPUT VARIABLE (configured in UI) that holds the Record ID of the triggering record.
const INPUT_VARIABLE_FOR_RECORD_ID = "recordId"; // <-- CHANGE THIS to match Input Variable Name in UI

// --- Webhook Secret ---
const AIRTABLE_WEBHOOK_SECRET = "your_generated_airtable_webhook_secret_here"; // Replace with your actual secret

// =======================================================================
// END OF CONFIGURATION - Do not modify below unless you know what you are doing
// =======================================================================

// --- Script Logic ---

// --- Worker URL ---
// The URL of your deployed Cloudflare Worker
const WORKER_URL = "https://nest-notifier.your-domain.workers.dev/"; // <-- CHANGE THIS

let inputConfig = input.config();

// --- Validate Record ID Input ---
if (!inputConfig[INPUT_VARIABLE_FOR_RECORD_ID] || typeof inputConfig[INPUT_VARIABLE_FOR_RECORD_ID] !== 'string' || !inputConfig[INPUT_VARIABLE_FOR_RECORD_ID].startsWith('rec')) {
    console.error(`Error: Input variable '${INPUT_VARIABLE_FOR_RECORD_ID}' is missing or invalid. Configure it in the UI to pass the Airtable Record ID.`);
    return;
}
const recordId = inputConfig[INPUT_VARIABLE_FOR_RECORD_ID];

// --- Fetch the Triggering Record Object ---
// Get table name from input variable
const triggeringTableName = inputConfig[INPUT_VARIABLE_FOR_TABLE_NAME];
if (!triggeringTableName) {
    console.error(`Error: Input variable '${INPUT_VARIABLE_FOR_TABLE_NAME}' is missing. Configure it in the UI to pass the Airtable Table Name.`);
    return;
}

console.log(`Fetching data for record: ${recordId} from table '${triggeringTableName}'...`);
let triggeringRecord;
let table; // Declare table variable here to access it later
let baseId, tableId;
try {
    table = base.getTable(triggeringTableName);
    baseId = base.id;
    tableId = table.id;

    // Fetch the record object. We don't need to specify fields here.
    triggeringRecord = await table.selectRecordAsync(recordId);

    if (!triggeringRecord) {
        throw new Error(`Record with ID ${recordId} not found in table '${triggeringTableName}'.`);
    }
    console.log(`Successfully fetched record object.`);
    console.log(`Base ID: ${baseId}, Table ID: ${tableId}`);

} catch (error) {
    console.error(`Error fetching record ${recordId} from table '${triggeringTableName}':`, error);
    return;
}

// --- Build the Fields Object Manually ---
console.log("Building fields object from fetched record...");
let recordFields = {};
try {
    // Iterate through all fields defined for the table
    for (const field of table.fields) {
        const fieldName = field.name;
        // Get the value as a string - safer for templates
        const cellValue = triggeringRecord.getCellValueAsString(fieldName);
        // Assign to our fields object. Use empty string if null/undefined for safety.
        recordFields[fieldName] = cellValue || "";
    }
    console.log("Successfully built fields object.");
} catch (error) {
    console.error(`Error building fields object for record ${recordId}:`, error);
    return;
}

// --- Process Linked Record IDs for Channels ---
if (typeof inputConfig[INPUT_VARIABLE_FOR_LINKED_IDS] === 'undefined') {
    console.error(`Error: Input variable '${INPUT_VARIABLE_FOR_LINKED_IDS}' is missing. Configure it in the UI.`);
    return;
}
const linkedRecordIdsInput = inputConfig[INPUT_VARIABLE_FOR_LINKED_IDS];
let validLinkedRecordIds = [];
if (Array.isArray(linkedRecordIdsInput) && linkedRecordIdsInput.length > 0) {
    validLinkedRecordIds = linkedRecordIdsInput.filter(id => typeof id === 'string' && id.startsWith('rec'));
} else {
    console.warn(`Warning: Input variable '${INPUT_VARIABLE_FOR_LINKED_IDS}' is empty or not an array for record ${recordId}.`);
}

// --- Fetch Channel IDs ---
let slackChannelIds = [];
if (validLinkedRecordIds.length > 0) {
    slackChannelIds = await getSlackChannelIdsFromLinkedRecords(validLinkedRecordIds, LINKED_TABLE_NAME, LINKED_TABLE_CHANNEL_ID_FIELD);
} else {
    console.warn(`Warning: No valid linked record IDs found in input variable '${INPUT_VARIABLE_FOR_LINKED_IDS}' to fetch channel IDs from.`);
}

// Stop if no valid Slack channels were found
if (!slackChannelIds || slackChannelIds.length === 0) {
    console.error(`Error: No valid Slack Channel IDs could be determined for record ${recordId}. Notification not sent.`);
    return;
}

// --- Prepare Payload ---
const workerConfig = {
    baseId: baseId, // Add base ID
    tableId: tableId, // Add table ID
    slackChannelIds: slackChannelIds,
    messageTemplate: MESSAGE_TEMPLATE,
    ...(PRIMARY_BUTTON_CONFIG && PRIMARY_BUTTON_CONFIG.label && { primaryButton: PRIMARY_BUTTON_CONFIG }),
    ...(SECONDARY_BUTTON_CONFIG && SECONDARY_BUTTON_CONFIG.label && { secondaryButton: SECONDARY_BUTTON_CONFIG }),
};

// Use the manually constructed recordFields object
let payload = {
    record: {
        id: recordId,
        fields: recordFields // Use the object built by iterating through fields
    },
    config: workerConfig
};

// --- Send Webhook ---
console.log(`Sending notification for record ${recordId} to channels: ${slackChannelIds.join(', ')}...`);
try {
    let response = await fetch(WORKER_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-Webhook-Secret': AIRTABLE_WEBHOOK_SECRET
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

// --- Helper Function (remains the same) ---
async function getSlackChannelIdsFromLinkedRecords(linkedRecordIds, linkedTableName, channelIdFieldName) {
    // ... (helper function code is unchanged) ...
    if (!Array.isArray(linkedRecordIds) || linkedRecordIds.length === 0) { console.warn("Helper: No linked IDs."); return []; }
    try {
        console.log(`Fetching Slack IDs from table '${linkedTableName}' (field '${channelIdFieldName}') for ${linkedRecordIds.length} linked records.`);
        let table = base.getTable(linkedTableName);
        let query = await table.selectRecordsAsync({ recordIds: linkedRecordIds, fields: [channelIdFieldName] });
        const channelIds = query.records
            .map(record => record.getCellValueAsString(channelIdFieldName))
            .filter(channelId => channelId && (channelId.trim().startsWith('C') || channelId.trim().startsWith('G')));
        if (channelIds.length === 0) { console.warn(`Warning: No valid Slack Channel IDs found in field '${channelIdFieldName}' of table '${linkedTableName}'.`); }
        else { console.log(`Found ${channelIds.length} valid Slack Channel ID(s).`); }
        return channelIds;
    } catch (error) { console.error(`Error fetching Slack IDs from table '${linkedTableName}':`, error); return []; }
}
