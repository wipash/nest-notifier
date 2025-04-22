// Nest Notifier
// Version 1.1.0 (hardcoded channel ID)

// =======================================================================
// CONFIGURATION - Modify the values below AND ensure corresponding inputs
//                 are configured in the Airtable Automation UI!
// =======================================================================

// --- Slack Channel ---
// The specific Slack Channel ID where the notification should be sent.
const SLACK_CHANNEL_ID = "C0XXXXXXXXX"; // <-- CHANGE THIS to your actual Slack Channel ID (e.g., C0123456789)

// --- Message Content ---
// The template for the Slack message.
// Use {FieldName} placeholders, where FieldName matches your Airtable field name exactly (case-sensitive).
// The script will automatically fetch these fields from the triggering record.
const MESSAGE_TEMPLATE = `
:page_facing_up: *New Organization Application for Verification*

*Organization:* {Name}

*Address:*
> {Street}
> {Suburb}
> {City}
> {Postcode}

*Services Offered:*
> {Services offered}
`; // <-- CHANGE THIS template as needed

// --- Buttons ---
// Configure the interactive buttons. Set to null or {} to disable a button.
const PRIMARY_BUTTON_CONFIG = {
    label: "Approve Application", // Text displayed on the button (Required if button is enabled)
    field: "Status",              // Airtable field name to update on click (Optional, case-sensitive)
    value: "Approved"             // Value to set in the specified 'field' (Optional)
}; // <-- CHANGE THIS button configuration
const SECONDARY_BUTTON_CONFIG = {
    label: "Ignore",              // Text displayed on the button (Required if button is enabled)
    //field: "Status",            // Airtable field name to update on click (Optional, case-sensitive)
    //value: "ignored"            // Value to set in the specified 'field' (Optional)
}; // <-- CHANGE THIS button configuration

// --- Airtable Setup ---
// Name of the INPUT VARIABLE (configured in UI) that holds the Record URL of the triggering record.
const INPUT_VARIABLE_FOR_RECORD_URL = "recordUrl"; // <-- CHANGE THIS to match Input Variable Name in UI

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

// --- Validate and Extract from Record URL ---
// Get record URL from input variable
const recordUrl = inputConfig[INPUT_VARIABLE_FOR_RECORD_URL];
if (!recordUrl || typeof recordUrl !== 'string' || !recordUrl.startsWith('https://airtable.com/')) {
    console.error(`Error: Input variable '${INPUT_VARIABLE_FOR_RECORD_URL}' is missing or invalid. Configure it in the UI to pass the Airtable Record URL.`);
    return;
}

let extractedTableId = null;
let recordId = null;
try {
    // Example URL: https://airtable.com/appt3vDzlFooenzk2/tblSGUVoWYt3SOGKH/reczd1N9MerOH0lIp
    const urlMatch = recordUrl.match(/\/+(tbl[a-zA-Z0-9]{14})\/+(rec[a-zA-Z0-9]{14})/);
    if (urlMatch && urlMatch[1] && urlMatch[2]) {
        extractedTableId = urlMatch[1];
        recordId = urlMatch[2];
    } else {
        throw new Error('Could not extract Table ID (tbl...) and Record ID (rec...) from Record URL.');
    }
} catch (error) {
    console.error(`Error processing Record URL '${recordUrl}':`, error);
    return;
}

if (!recordId) {
    // This check is technically redundant if the regex requires 'rec', but good practice
    console.error(`Error: Could not extract Record ID from Record URL: ${recordUrl}`);
    return;
}
if (!extractedTableId) {
     // This check is technically redundant if the regex requires 'tbl', but good practice
    console.error(`Error: Could not extract Table ID from Record URL: ${recordUrl}`);
    return;
}

// --- Fetch the Triggering Record Object ---
console.log(`Fetching data for record: ${recordId} from table ID: ${extractedTableId}...`);
let triggeringRecord;
let table;
let baseId, tableId;
try {
    // Use the extracted table ID
    table = base.getTable(extractedTableId);
    baseId = base.id;
    tableId = table.id; // table.id should match extractedTableId

    // Optional: Verify extracted ID matches table object ID
    if (tableId !== extractedTableId) {
        console.warn(`Warning: Extracted table ID (${extractedTableId}) does not match table object ID (${tableId}). Using table object ID.`);
    }

    // Fetch the record object using the extracted record ID.
    triggeringRecord = await table.selectRecordAsync(recordId); // Use extracted recordId

    if (!triggeringRecord) {
        throw new Error(`Record with ID ${recordId} not found in table with ID '${tableId}'.`);
    }
    console.log(`Successfully fetched record object from table '${table.name}' (ID: ${tableId}).`); // Log name too
    console.log(`Base ID: ${baseId}, Table ID: ${tableId}`);

} catch (error) {
    console.error(`Error fetching record ${recordId} from table ID '${extractedTableId}':`, error);
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

// --- Validate Hardcoded Channel ID ---
if (!SLACK_CHANNEL_ID || typeof SLACK_CHANNEL_ID !== 'string' || !(SLACK_CHANNEL_ID.startsWith('C') || SLACK_CHANNEL_ID.startsWith('G'))) {
    console.error(`Error: The configured SLACK_CHANNEL_ID ('${SLACK_CHANNEL_ID}') is missing or invalid. It should start with 'C' or 'G'.`);
    return;
}

// --- Prepare Payload ---
const workerConfig = {
    baseId: baseId, // Add base ID
    tableId: tableId, // Add table ID
    slackChannelIds: [SLACK_CHANNEL_ID],
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
console.log(`Sending notification for record ${recordId} to channel: ${SLACK_CHANNEL_ID}...`);
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
