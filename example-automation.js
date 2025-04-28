// Nest Notifier
// Version 1.2 (dynamic channel fetching)

// =======================================================================
// CONFIGURATION - Modify the values below AND ensure corresponding inputs
//                 are configured in the Airtable Automation UI!
// =======================================================================

// --- Input Variables ---
// Name of the Input Variable holding the triggering record's URL
const RECORD_URL_INPUT = "recordUrl";
// Name of the Input Variable holding the Template ID (e.g., "SLACK1") to use from the Templates table
const TEMPLATE_ID_INPUT = "templateId"; // <-- ADD THIS input variable in the UI
// Name of the INPUT VARIABLE (configured in UI) that holds the linked record IDs from the triggering record
// This input variable should be configured in the Airtable UI to pass the value of the linked record field.
const INPUT_VARIABLE_FOR_LINKED_IDS = "branches"; // <-- CHANGE THIS to match Input Variable Name in UI


// --- Templates Table Configuration ---
// Name of the table containing message templates
const TEMPLATES_TABLE_NAME = "Templates"; // <-- CHANGE THIS if your table name is different
// Field name in the Templates table containing the unique Template ID (e.g., "SLACK1")
const TEMPLATE_ID_FIELD = "ID"; // <-- CHANGE THIS if your ID field name is different
// Field name in the Templates table containing the message body content (can contain placeholders)
// Note: Subject field is not typically needed for Slack messages.
const TEMPLATE_BODY_FIELD = "Body"; // <-- CHANGE THIS if your body field name is different


// --- Buttons ---
// Configure the interactive buttons. Set to null or {} to disable a button.
const PRIMARY_BUTTON_CONFIG = {
    label: "Approve Application", // Text displayed on the button (Required if button is enabled)
    field: "Status",              // Airtable field name to update on click (Optional, case-sensitive)
    value: "Approved"             // Value to set in the specified 'field' (Optional)
}; // <-- CHANGE THIS button configuration
const SECONDARY_BUTTON_CONFIG = {
    label: "Ignore",              // Text displayed on the button (Required if button is enabled)
    field: "Status",              // Airtable field name to update on click (Optional, case-sensitive)
    value: "Ignored"              // Value to set in the specified 'field' (Optional)
}; // <-- CHANGE THIS button configuration

// --- Airtable Setup (Used for Channel Fetching) ---
// Name of the Airtable table where the Slack Channel IDs are stored.
const LINKED_TABLE_NAME = "Branches"; // <-- CHANGE THIS
// Field name in the linked table that holds the actual Slack Channel ID string.
const LINKED_TABLE_CHANNEL_ID_FIELD = "Branch channel ID"; // <-- CHANGE THIS

// --- Webhook Secret ---
const AIRTABLE_WEBHOOK_SECRET = "your_generated_airtable_webhook_secret_here"; // Replace with your actual secret

// =======================================================================
// END OF CONFIGURATION - Do not modify below unless you know what you are doing
// =======================================================================

// --- Initialize the Reusable Template Processor ---
const { processTemplate } = initializeTemplateProcessor();

// --- Script Logic ---

// --- Worker URL ---
// The URL of your deployed Cloudflare Worker
const WORKER_URL = "https://nest-notifier.it-6f6.workers.dev/"; // <-- CHANGE THIS

let inputConfig = input.config();

// --- Validate and Extract from Record URL ---
// Get record URL from input variable
const recordUrl = inputConfig[RECORD_URL_INPUT];
if (!recordUrl || typeof recordUrl !== 'string' || !recordUrl.startsWith('https://airtable.com/')) {
    const errorMsg = `Error: Input variable '${RECORD_URL_INPUT}' is missing or invalid. Configure it in the UI to pass the Airtable Record URL.`;
    console.error(errorMsg);
    throw new Error(errorMsg);
}
const templateId = inputConfig[TEMPLATE_ID_INPUT];
if (!templateId) {
    const errorMsg = `Error: Template ID missing. Configure input variable '${TEMPLATE_ID_INPUT}' in the UI.`;
    console.error(errorMsg);
    throw new Error(errorMsg);
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
    const errorMsg = `Error processing Record URL '${recordUrl}':`;
    console.error(errorMsg, error);
    throw new Error(`${errorMsg} ${error.message}`);
}

if (!recordId) {
    // This check is technically redundant if the regex requires 'rec', but good practice
    const errorMsg = `Error: Could not extract Record ID from Record URL: ${recordUrl}`;
    console.error(errorMsg);
    throw new Error(errorMsg);
}
if (!extractedTableId) {
     // This check is technically redundant if the regex requires 'tbl', but good practice
    const errorMsg = `Error: Could not extract Table ID from Record URL: ${recordUrl}`;
    console.error(errorMsg);
    throw new Error(errorMsg);
}

// We need the base ID and table ID for the payload, so fetch the table object early
let baseId, tableId, table;
try {
    table = base.getTable(extractedTableId);
    baseId = base.id;
    tableId = table.id;
    if (tableId !== extractedTableId) {
        console.warn(`Warning: Extracted table ID (${extractedTableId}) does not match table object ID (${tableId}). Using table object ID.`);
    }
    console.log(`Using Base ID: ${baseId}, Table ID: ${tableId} (Name: ${table.name})`);
} catch (error) {
    const errorMsg = `Error getting table object for table ID '${extractedTableId}':`;
    console.error(errorMsg, error);
    throw new Error(`${errorMsg} ${error.message}`);
}


// --- Process Template using the Reusable Function ---
let processedMessageBody = "";
try {
    const processTemplateConfig = {
        base: base,
        recordUrl: recordUrl,
        templateId: templateId,
        templatesTableName: TEMPLATES_TABLE_NAME,
        templateIdField: TEMPLATE_ID_FIELD,
        templateSubjectField: null, // No subject needed for Slack
        templateBodyField: TEMPLATE_BODY_FIELD
    };

    // The processTemplate function handles fetching the trigger record and resolving placeholders
    const processedResult = await processTemplate(processTemplateConfig);

    processedMessageBody = processedResult.body;

    if (processedMessageBody === "") {
        // Allow empty messages if the template resolves to empty, but log a warning.
        console.warn(`Warning: Processed message body is empty for template ID '${templateId}'. Check the template content and field values.`);
        // Depending on requirements, you might want to throw an error here instead:
        // throw new Error(`Error: Processed message body is empty for template ID '${templateId}'.`);
    }

    console.log(`Template processing complete. Processed Body: "${processedMessageBody}"`);

} catch (error) {
    console.error("Error during template processing:", error);
    // Re-throwing the error ensures the Airtable Automation run fails
    throw error;
}


// --- Process Linked Record IDs for Channels ---
if (typeof inputConfig[INPUT_VARIABLE_FOR_LINKED_IDS] === 'undefined') {
    const errorMsg = `Error: Input variable '${INPUT_VARIABLE_FOR_LINKED_IDS}' is missing. Configure it in the UI.`;
    console.error(errorMsg);
    throw new Error(errorMsg);
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
    const errorMsg = `Error: No valid Slack Channel IDs could be determined for record ${recordId}. Notification not sent.`;
    console.error(errorMsg);
    throw new Error(errorMsg);
}

// --- Prepare Payload ---
// Construct payload for the worker, including the processed message
const workerConfig = {
    baseId: baseId,
    tableId: tableId,
    recordId: recordId, // Pass the record ID for context/updates
    slackChannelIds: slackChannelIds,
    messageText: processedMessageBody, // Send the fully processed message text
    ...(PRIMARY_BUTTON_CONFIG && PRIMARY_BUTTON_CONFIG.label && { primaryButton: PRIMARY_BUTTON_CONFIG }),
    ...(SECONDARY_BUTTON_CONFIG && SECONDARY_BUTTON_CONFIG.label && { secondaryButton: SECONDARY_BUTTON_CONFIG }),
};

// Simplified payload structure - the worker now receives the final message text directly.
let payload = {
    config: workerConfig
    // Removed the 'record' object as field resolution is done here now.
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
        // Throw an error to ensure the automation fails if the worker call fails
        throw new Error(`Webhook request to worker failed with status ${response.status}.`);
    } else {
        console.log(`Webhook sent successfully to ${WORKER_URL}. Status: ${response.status}`);
    }
} catch (error) {
    console.error(`Network or runtime error during fetch call to ${WORKER_URL}:`, error);
    // Re-throw the error to ensure the automation fails
    throw error;
}

// --- Helper Function ---
async function getSlackChannelIdsFromLinkedRecords(linkedRecordIds, linkedTableName, channelIdFieldName) {
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


// =======================================================================
// Reusable Airtable Template Processor
// Version 1.0.0
// Paste this entire script block into your Airtable Automation Script Action.
// Call `initializeTemplateProcessor()` to get the `processTemplate` function.
// =======================================================================

function initializeTemplateProcessor () {

    const MAX_RECURSION_DEPTH = 5; // Prevent infinite loops in linked field resolution

    // --- Helper: Placeholder Parsing ---
    // Parses text to find {{SimpleField}} and {{LinkedField:TargetField}}
    function parsePlaceholders(text) {
        if (!text) return { directFields: new Set(), linkedFields: {} }; // Handle null/empty text

        // Clean whitespace (including NBSP) before parsing
        const cleanedText = text.replace(/[\s\u00A0]+/g, ' ');

        // Regex to find {{Content}}. Note the outer parentheses are for capture.
        const regex = /\{\{([^}]+)\}\}/g;
        let match;
        const placeholders = {
            directFields: new Set(), // Fields directly on the trigger record OR the link field itself
            linkedFields: {}         // Structure: { TriggerLinkedFieldName: Set(TargetFieldName) }
        };

        while ((match = regex.exec(cleanedText)) !== null) { // Use cleanedText
            const fullPlaceholder = match[0];
            const processedContent = match[1].trim(); // Trim the captured content

            if (!processedContent) {
                console.warn(`Skipping empty placeholder found in template: ${fullPlaceholder}`);
                continue;
            }

            if (processedContent.includes(':')) {
                const parts = processedContent.split(':', 2);
                const linkedFieldName = parts[0].trim();
                const targetFieldName = parts[1].trim();
                if (linkedFieldName && targetFieldName) {
                    placeholders.directFields.add(linkedFieldName);
                    if (!placeholders.linkedFields[linkedFieldName]) {
                        placeholders.linkedFields[linkedFieldName] = new Set();
                    }
                    placeholders.linkedFields[linkedFieldName].add(targetFieldName);
                } else {
                    console.error(`Malformed linked placeholder found: ${fullPlaceholder}. Parts after split: [${parts.map(p => `'${p}'`).join(', ')}]`);
                    throw new Error(`Malformed linked placeholder: ${fullPlaceholder}. Ensure format is {{LinkFieldName:TargetFieldName}}.`);
                }
            } else {
                const directFieldName = processedContent;
                placeholders.directFields.add(directFieldName);
            }
        }
        return placeholders;
    }

    // --- Helper: Recursive Linked Value Resolver ---
    /**
     * Recursively resolves a placeholder value by traversing linked records and lookups.
     * Throws errors on failure (e.g., field not found, record not found, max depth).
     * @param {string} fieldName The name of the field to start resolution from on the current record.
     * @param {string} targetFieldName The ultimate field name whose value is needed.
     * @param {object} currentTable The Airtable table object for the current record.
     * @param {object} currentRecord The Airtable record object currently being examined.
     * @param {number} depth The current recursion depth.
     * @param {Set<string>} visited Record IDs visited in this resolution path (tableId:recordId) to detect cycles.
     * @returns {Promise<string>} The resolved string value.
     * @throws {Error} If resolution fails for any reason.
     */
    async function resolveLinkedValue(fieldName, targetFieldName, currentTable, currentRecord, depth, visited) {
        const logPrefix = `[Depth ${depth}]`;
        const currentVisitId = `${currentTable.id}:${currentRecord.id}`;

        // Cycle detection
        if (visited.has(currentVisitId)) {
            throw new Error(`${logPrefix} Cycle detected during linked field resolution for '${fieldName}' -> '${targetFieldName}'. Path included ${currentVisitId}.`);
        }
        visited.add(currentVisitId); // Add current step to visited path

        console.log(`${logPrefix} Resolving: Field='${fieldName}', Target='${targetFieldName}' on Table='${currentTable.name}', Record='${currentRecord.id}'`);

        if (depth > MAX_RECURSION_DEPTH) {
            throw new Error(`${logPrefix} Max recursion depth (${MAX_RECURSION_DEPTH}) reached for field '${fieldName}' -> '${targetFieldName}'. Check for overly complex links or increase MAX_RECURSION_DEPTH.`);
        }

        if (!currentRecord) {
             // This case should ideally be caught before calling, but safety check.
             throw new Error(`${logPrefix} Internal Error: Current record is null/undefined when resolving field '${fieldName}'.`);
        }

        let fieldMeta;
        try {
            fieldMeta = currentTable.getField(fieldName);
        } catch (e) {
            // Catch the specific error thrown by getField for a non-existent field
            throw new Error(`${logPrefix} Field '${fieldName}' not found on table '${currentTable.name}'. Check placeholder name and table structure. (Original error: ${e.message})`);
        }

        // --- Case 1: Direct Link --- (Field on current record links to the record containing the target)
        if (fieldMeta.type === 'multipleRecordLinks') {
            console.log(`${logPrefix} Field '${fieldName}' is multipleRecordLinks.`);
            let linkedTableId = fieldMeta.options?.linkedTableId;
            if (!linkedTableId) {
                throw new Error(`${logPrefix} Cannot get linkedTableId for multipleRecordLinks field '${fieldName}' on table '${currentTable.name}'.`);
            }
            let linkedTable = base.getTable(linkedTableId); // Assumes base is accessible in scope
            let linkedRecordLinks = currentRecord.getCellValue(fieldName);

            if (!Array.isArray(linkedRecordLinks) || linkedRecordLinks.length === 0 || !linkedRecordLinks[0]?.id) {
                console.log(`${logPrefix} No linked records found for field '${fieldName}'. Returning empty string.`);
                visited.delete(currentVisitId); // Backtrack visited path
                return ""; // Not an error, just no value
            }
            // NOTE: Only using the *first* linked record if multiple exist.
            // Consider if joining multiple values is needed in the future.
            let linkedRecordId = linkedRecordLinks[0].id;
            console.log(`${logPrefix} Found first linked record ID: ${linkedRecordId} in table '${linkedTable.name}'. Fetching...`);

            try {
                // Fetch only the target field for efficiency
                const linkedRecord = await linkedTable.selectRecordAsync(linkedRecordId, { fields: [targetFieldName] });
                if (!linkedRecord) {
                     // Should not happen if link exists, but handle defensively
                     throw new Error(`${logPrefix} Linked record ${linkedRecordId} not found in table '${linkedTable.name}', despite link existing.`);
                }
                console.log(`${logPrefix} Fetched linked record ${linkedRecord.id}. Getting target field '${targetFieldName}'...`);

                // Check if the target field exists on the linked table *before* getting value
                try {
                    linkedTable.getField(targetFieldName); // This throws if the field doesn't exist
                } catch (e) {
                     throw new Error(`${logPrefix} Target field '${targetFieldName}' not found on linked table '${linkedTable.name}' (ID: ${linkedTableId}). Check placeholder. (Original error: ${e.message})`);
                }

                const finalValue = linkedRecord.getCellValueAsString(targetFieldName);
                console.log(`${logPrefix} Final value for '${targetFieldName}': "${finalValue !== null ? finalValue : '(null)'}"`);
                visited.delete(currentVisitId); // Backtrack visited path
                return finalValue !== null ? finalValue : ""; // Return empty string for null values
            } catch (e) {
                // Catch selectRecordAsync errors or getCellValueAsString errors
                 if (e.message?.includes("Could not find field")) {
                     // This case is handled above by checking getField, but keep for defense
                     throw new Error(`${logPrefix} Target field '${targetFieldName}' not found on final linked table '${linkedTable.name}'. Check placeholder. (Error: ${e.message})`);
                 }
                throw new Error(`${logPrefix} Error fetching/processing linked record ${linkedRecordId} or target field '${targetFieldName}': ${e.message}`);
            }
        }
        // --- Case 2: Lookup --- (Field on current record looks up a field on an intermediate record)
        else if (fieldMeta.type === 'multipleLookupValues') {
             console.log(`${logPrefix} Field '${fieldName}' is multipleLookupValues.`);
            if (!fieldMeta.options?.isValid) {
                 // An invalid lookup field configuration in Airtable.
                 throw new Error(`${logPrefix} Lookup field '${fieldName}' on table '${currentTable.name}' is improperly configured or invalid.`);
            }
            let recordLinkFieldId = fieldMeta.options?.recordLinkFieldId; // ID of the Link field *on this table* that the lookup uses
            let fieldIdInLinkedTable = fieldMeta.options?.fieldIdInLinkedTable; // ID of the field being looked up *on the intermediate table*

            if (!recordLinkFieldId || !fieldIdInLinkedTable) {
                 throw new Error(`${logPrefix} Lookup field '${fieldName}' on table '${currentTable.name}' is missing configuration (recordLinkFieldId or fieldIdInLinkedTable).`);
            }

            let recordLinkFieldMeta; // Metadata for the Link field on *this* table
            let intermediateTable; // The table linked *to* by the Link field
            let associatedLinkFieldName; // Name of the Link field on *this* table
            let intermediateRecordId; // ID of the record in the intermediate table

            try {
                // Find the *Link* field on the current table that this lookup depends on
                recordLinkFieldMeta = currentTable.getField(recordLinkFieldId); // Use getField, expect it to exist
                 if (!recordLinkFieldMeta || recordLinkFieldMeta.type !== 'multipleRecordLinks') {
                     throw new Error(`Configuration Error: Associated link field (ID: ${recordLinkFieldId}) for lookup '${fieldName}' is not found or not of type multipleRecordLinks on table '${currentTable.name}'.`);
                 }
                let intermediateTableId = recordLinkFieldMeta.options?.linkedTableId;
                 if (!intermediateTableId) {
                     throw new Error(`Configuration Error: Cannot get linkedTableId from associated link field '${recordLinkFieldMeta.name}' (ID: ${recordLinkFieldId}) on table '${currentTable.name}'.`);
                 }
                 intermediateTable = base.getTable(intermediateTableId);
                 associatedLinkFieldName = recordLinkFieldMeta.name; // The name of the link field on the *current* table

                 console.log(`${logPrefix} Lookup uses associated link field '${associatedLinkFieldName}' linking to intermediate table '${intermediateTable.name}'.`);

                 // Get the ID of the intermediate record using the *associated link field name*
                 let intermediateRecordLinks = currentRecord.getCellValue(associatedLinkFieldName);
                 if (!Array.isArray(intermediateRecordLinks) || intermediateRecordLinks.length === 0 || !intermediateRecordLinks[0]?.id) {
                    console.log(`${logPrefix} No intermediate linked records found via field '${associatedLinkFieldName}'. Cannot resolve lookup '${fieldName}'. Returning empty string.`);
                    visited.delete(currentVisitId); // Backtrack visited path
                    return ""; // Not an error, just no value
                 }
                 // NOTE: Using only the *first* intermediate record if multiple links exist.
                 intermediateRecordId = intermediateRecordLinks[0].id;
                 console.log(`${logPrefix} Found intermediate record ID: ${intermediateRecordId} in table '${intermediateTable.name}'.`);

            } catch (e) {
                 // Catch errors finding fields or tables in the lookup structure
                 throw new Error(`${logPrefix} Error resolving lookup structure for '${fieldName}': ${e.message}`);
            }

            // Find the name of the field that the lookup is targeting on the *intermediate* table
            let nextFieldName; // This is the field we need to start resolving from on the intermediate record
            try {
                 const targetFieldMetaOnIntermediate = intermediateTable.getField(fieldIdInLinkedTable); // Use getField, expect it to exist
                 if (!targetFieldMetaOnIntermediate) {
                     // Should be caught by getField, but defensive check
                     throw new Error(`Configuration Error: Looked-up field (ID: '${fieldIdInLinkedTable}') not found on intermediate table '${intermediateTable.name}'.`);
                 }
                 nextFieldName = targetFieldMetaOnIntermediate.name;
                 console.log(`${logPrefix} Lookup targets field '${nextFieldName}' (ID: ${fieldIdInLinkedTable}) on intermediate table '${intermediateTable.name}'.`);
            } catch (e) {
                 throw new Error(`${logPrefix} Error getting next field name for lookup '${fieldName}': ${e.message}`);
            }

            // Fetch the intermediate record (fetching only the 'nextFieldName' might be complex if 'nextFieldName' itself is another link/lookup)
            // Fetching the whole record might be safer for subsequent recursion, though less efficient if the target is simple.
            // Let's fetch the necessary field for the *next* step. This requires knowing if 'nextFieldName' is a link/lookup itself.
            // Simpler approach: Fetch the intermediate record without specific fields first.
            let intermediateRecord;
            try {
                 console.log(`${logPrefix} Fetching intermediate record ${intermediateRecordId} from '${intermediateTable.name}'...`);
                 // We might need more than just 'nextFieldName' if it's a link/lookup itself.
                 // Fetching without fields arg fetches all fetchable fields.
                 intermediateRecord = await intermediateTable.selectRecordAsync(intermediateRecordId);
                  if (!intermediateRecord) {
                     throw new Error(`${logPrefix} Intermediate linked record ${intermediateRecordId} not found in table '${intermediateTable.name}', but link existed.`);
                }
                 console.log(`${logPrefix} Fetched intermediate record ${intermediateRecord.id}.`);
            } catch (e) {
                 throw new Error(`${logPrefix} Error fetching intermediate record ${intermediateRecordId} from table '${intermediateTable.name}': ${e.message}`);
            }

            // Recurse: Use the next field name on the intermediate table/record, passing the *original* targetFieldName down.
            console.log(`${logPrefix} Recursing: Field='${nextFieldName}', Target='${targetFieldName}' on Table='${intermediateTable.name}', Record='${intermediateRecord.id}'`);
            // Pass the *same* targetFieldName down the chain.
            const result = await resolveLinkedValue(nextFieldName, targetFieldName, intermediateTable, intermediateRecord, depth + 1, visited);
            visited.delete(currentVisitId); // Backtrack visited path
            return result;

        }
        // --- Case 3: Base Case --- Field is a simple value type on the current record
        else if (fieldName === targetFieldName) {
            console.log(`${logPrefix} Field '${fieldName}' is the target field on the current record '${currentRecord.id}'. Getting value.`);
            const finalValue = currentRecord.getCellValueAsString(fieldName);
            console.log(`${logPrefix} Final value for '${targetFieldName}': "${finalValue !== null ? finalValue : '(null)'}"`);
            visited.delete(currentVisitId); // Backtrack visited path
            return finalValue !== null ? finalValue : "";
        }
        // --- Case 4: Unsupported / Non-Traversable --- Field type cannot be traversed further
        else {
            throw new Error(`${logPrefix} Field '${fieldName}' on table '${currentTable.name}' has an unsupported type ('${fieldMeta.type}') for linked value resolution, or it's not the target field ('${targetFieldName}'). Cannot continue resolution path.`);
        }
    }


    // --- Helper: Replace Placeholders ---
    function replaceAllPlaceholders(text, data) {
        if (!text) return ""; // Return empty string if template text is null/undefined
        // Regex to find {{SimpleField}} or {{LinkedField:TargetField}}
        // It includes trim() around the key inside the brackets for robustness {{ Key }}
        return text.replace(/\{\{([^}]+)\}\}/g, (match, key) => {
            const cleanedKey = key.trim();
            const hasKey = data.hasOwnProperty(cleanedKey);

            // Use the value from resolved data if it exists (even if empty string), otherwise keep the original placeholder
            if (hasKey) {
                // Ensure value is a string; handle potential non-string values if data source changes
                return String(data[cleanedKey]);
            } else {
                console.warn(`Placeholder {{${cleanedKey}}} found in template but missing from resolved data. Leaving placeholder unchanged.`);
                return match; // Keep original placeholder like {{UnresolvedField}}
            }
        });
    }


    /**
     * Fetches and processes a template record from Airtable, resolves all {{placeholders}}
     * (including direct, linked, and lookup fields recursively), and returns the final text.
     * Throws errors if any step fails (e.g., missing config, record not found, field not found).
     *
     * @param {object}   params - Configuration object.
     * @param {object}   params.base - The Airtable `base` object (required).
     * @param {string}   params.recordUrl - The URL of the triggering record (required).
     * @param {string}   params.templateId - The ID of the template record to use (required).
     * @param {string}   params.templatesTableName - Name of the table containing templates (required).
     * @param {string}   params.templateIdField - Field name in Templates table holding the unique ID (required).
     * @param {string}   [params.templateSubjectField] - Field name for the subject line (optional).
     * @param {string}   params.templateBodyField - Field name for the main body content (required).
     *
     * @returns {Promise<{subject: string|null, body: string}>} An object containing the processed subject
     *          (or null if no templateSubjectField provided) and body.
     * @throws {Error} If any validation, fetching, or processing step fails.
     */
    async function processTemplate(params) {
        const {
            base,
            recordUrl,
            templateId,
            templatesTableName,
            templateIdField,
            templateSubjectField, // Optional
            templateBodyField
        } = params;

        // --- 1. Validate Core Inputs ---
        if (!base) throw new Error("Configuration Error: 'base' object is required.");
        if (!recordUrl || typeof recordUrl !== 'string' || !recordUrl.startsWith('https://airtable.com/')) {
            throw new Error(`Configuration Error: 'recordUrl' is missing, invalid, or not a valid Airtable record URL. Value: ${recordUrl}`);
        }
        if (!templateId || typeof templateId !== 'string') {
            throw new Error(`Configuration Error: 'templateId' is missing or not a string. Value: ${templateId}`);
        }
        if (!templatesTableName || typeof templatesTableName !== 'string') {
            throw new Error(`Configuration Error: 'templatesTableName' is missing or not a string. Value: ${templatesTableName}`);
        }
        if (!templateIdField || typeof templateIdField !== 'string') {
            throw new Error(`Configuration Error: 'templateIdField' is missing or not a string. Value: ${templateIdField}`);
        }
        // Body field is mandatory for having content
        if (!templateBodyField || typeof templateBodyField !== 'string') {
            throw new Error(`Configuration Error: 'templateBodyField' is missing or not a string. Value: ${templateBodyField}`);
        }
        // Subject field is optional, but if provided must be a string
        if (templateSubjectField && typeof templateSubjectField !== 'string') {
            throw new Error(`Configuration Error: 'templateSubjectField' was provided but is not a string. Value: ${templateSubjectField}`);
        }

        // --- 2. Extract Trigger Record Info ---
        let triggerTableId = null;
        let triggerRecordId = null;
        try {
            // Regex: Match /tbl.../rec... pattern in the URL
            const urlMatch = recordUrl.match(/\/(tbl[a-zA-Z0-9]{14})\/(rec[a-zA-Z0-9]{14})/);
            if (urlMatch && urlMatch[1] && urlMatch[2]) {
                triggerTableId = urlMatch[1];
                triggerRecordId = urlMatch[2];
            } else {
                throw new Error('Could not extract Table ID (tbl...) and Record ID (rec...) from Record URL.');
            }
        } catch (error) {
            console.error(`Error processing Record URL '${recordUrl}':`, error);
            throw error; // Re-throw the specific error
        }

        // --- 3. Fetch Template Record ---
        let templateSubjectText = null; // Default to null
        let templateBodyText = "";
        let allPlaceholders = { directFields: new Set(), linkedFields: {} };

        try {
            const templatesTable = base.getTable(templatesTableName);

            // Ensure the required fields exist on the templates table using try/catch with getField
            try {
                templatesTable.getField(templateIdField);
                if (templateSubjectField) {
                    templatesTable.getField(templateSubjectField);
                }
                templatesTable.getField(templateBodyField);
            } catch (e) {
                // Catch error if any of the essential template fields are missing
                throw new Error(`Configuration Error: A required template field ('${templateIdField}'${templateSubjectField ? `, '${templateSubjectField}'` : ''} or '${templateBodyField}') not found on table '${templatesTableName}'. Check field names. (Original error: ${e.message})`);
            }

            // Query for the specific template record
            // NOTE: This might be inefficient if the Templates table is huge.
            // Consider querying by formula `{[ID Field Name]} = 'TemplateID'` if performance becomes an issue.
            // However, selectRecordsAsync() with a loop is standard for scripting actions.
            const queryFields = [templateIdField, templateBodyField];
            if (templateSubjectField) {
                queryFields.push(templateSubjectField);
            }
            const potentialTemplates = await templatesTable.selectRecordsAsync({ fields: queryFields });
            let templateRecord = null;
            for (let record of potentialTemplates.records) {
                if (record.getCellValueAsString(templateIdField) === templateId) {
                    templateRecord = record;
                    break;
                }
            }

            if (!templateRecord) {
                 throw new Error(`Template Not Found: Template with ID '${templateId}' not found in table '${templatesTableName}' (checked field '${templateIdField}').`);
            }

            // Get Subject (optional) and Body
            if (templateSubjectField) {
                templateSubjectText = templateRecord.getCellValueAsString(templateSubjectField);
                // Clean non-breaking spaces (ASCII 160)
                templateSubjectText = templateSubjectText ? templateSubjectText.replace(/\\u00A0/g, ' ') : null;
            }
            templateBodyText = templateRecord.getCellValueAsString(templateBodyField);
            templateBodyText = templateBodyText ? templateBodyText.replace(/\\u00A0/g, ' ') : ""; // Ensure body is at least ""

            // --- 4. Parse Placeholders ---
            const subjectPlaceholders = templateSubjectField ? parsePlaceholders(templateSubjectText) : { directFields: new Set(), linkedFields: {} };
            const bodyPlaceholders = parsePlaceholders(templateBodyText);

            // Combine placeholders from subject and body
            subjectPlaceholders.directFields.forEach(f => allPlaceholders.directFields.add(f));
            bodyPlaceholders.directFields.forEach(f => allPlaceholders.directFields.add(f));
            for (const linkedField in subjectPlaceholders.linkedFields) {
                if (!allPlaceholders.linkedFields[linkedField]) allPlaceholders.linkedFields[linkedField] = new Set();
                subjectPlaceholders.linkedFields[linkedField].forEach(tf => allPlaceholders.linkedFields[linkedField].add(tf));
            }
            for (const linkedField in bodyPlaceholders.linkedFields) {
                if (!allPlaceholders.linkedFields[linkedField]) allPlaceholders.linkedFields[linkedField] = new Set();
                bodyPlaceholders.linkedFields[linkedField].forEach(tf => allPlaceholders.linkedFields[linkedField].add(tf));
            }

            console.log("Parsed Placeholders:", JSON.stringify({
                direct: [...allPlaceholders.directFields],
                linked: Object.fromEntries(Object.entries(allPlaceholders.linkedFields).map(([k, v]) => [k, [...v]]))
            }));

            if (allPlaceholders.directFields.size === 0) {
                 console.warn(`Warning: No placeholder fields found in template '${templateId}'. Only static content will be used.`);
            }

        } catch (error) {
            console.error("Error fetching or parsing email template:", error);
            throw error; // Re-throw
        }


        // --- 5. Fetch Trigger Record Data ---
        let triggerRecord = null;
        let triggerTable = null;
        let placeholderData = {}; // Stores ALL resolved placeholder values { "PlaceholderKey": "Value" }

        // Only fetch if there are placeholders to fill
        if (allPlaceholders.directFields.size > 0) {
            try {
                triggerTable = base.getTable(triggerTableId);

                // Initial set of fields to fetch based on direct placeholders
                const fieldsToFetch = new Set([...allPlaceholders.directFields]);

                // Ensure all needed direct fields exist and identify lookup dependencies
                const missingFields = [];
                for (const fieldName of fieldsToFetch) {
                    let fieldMeta;
                    try {
                        fieldMeta = triggerTable.getField(fieldName);
                    } catch (e) {
                        // This field doesn't exist on the trigger table
                        missingFields.push(fieldName);
                        continue; // Skip to next field
                    }

                    // If it's a lookup, we also need the underlying Link field
                    if (fieldMeta.type === 'multipleLookupValues') {
                        const recordLinkFieldId = fieldMeta.options?.recordLinkFieldId;
                        if (recordLinkFieldId) {
                            try {
                                const linkFieldMeta = triggerTable.getField(recordLinkFieldId);
                                if (linkFieldMeta) {
                                    console.log(`Placeholder '${fieldName}' is a lookup depending on link field '${linkFieldMeta.name}'. Adding '${linkFieldMeta.name}' to fetch list.`);
                                    fieldsToFetch.add(linkFieldMeta.name);
                                } else {
                                    // This case should be rare if getField worked
                                    console.warn(`Could not find link field metadata for ID ${recordLinkFieldId} associated with lookup '${fieldName}', though the ID was present.`);
                                }
                            } catch(linkE) {
                                // The dependent link field doesn't exist!
                                throw new Error(`Configuration Error: Lookup field '${fieldName}' depends on a linked record field (ID: ${recordLinkFieldId}) which does not exist on table '${triggerTable.name}'. (Error: ${linkE.message})`);
                            }
                        } else {
                            // Lookup is missing its link field ID configuration
                            throw new Error(`Configuration Error: Lookup field '${fieldName}' on table '${triggerTable.name}' is missing its dependent record link field ID in its configuration.`);
                        }
                    }
                }

                if (missingFields.length > 0) {
                    throw new Error(`Configuration Error: The following placeholder field(s) do not exist on trigger table '${triggerTable.name}' (ID: ${triggerTableId}): ${missingFields.join(', ')}`);
                }

                // Fetch the trigger record with the potentially expanded set of fields
                triggerRecord = await triggerTable.selectRecordAsync(triggerRecordId, { fields: [...fieldsToFetch] });
                if (!triggerRecord) {
                     throw new Error(`Data Fetch Error: Trigger record with ID ${triggerRecordId} not found in table '${triggerTable.name}'.`);
                }

                // --- 6. Resolve Placeholder Values ---

                // --- Populate Direct Placeholder Data ---
                for (const fieldName of allPlaceholders.directFields) {
                    // If this fieldName is *only* used as a direct value (not a link field name for linked resolution)
                    if (!allPlaceholders.linkedFields[fieldName]) {
                        const cellValue = triggerRecord.getCellValueAsString(fieldName);
                        placeholderData[fieldName] = cellValue !== null ? cellValue : ""; // Use empty string for null
                    }
                    // If it IS a link field name used for linked resolution, its value will be resolved below.
                    // We still needed to fetch it directly above.
                }

                // --- Resolve Linked/Lookup Data Recursively ---
                const linkedPlaceholdersToResolve = Object.entries(allPlaceholders.linkedFields); // [ [linkFieldName, Set<targetFieldName>], ... ]

                for (const [linkFieldName, targetFieldSet] of linkedPlaceholdersToResolve) {
                     // Check if the link field itself has a value on the trigger record
                     const linkFieldValue = triggerRecord.getCellValue(linkFieldName);
                     if (!linkFieldValue || (Array.isArray(linkFieldValue) && linkFieldValue.length === 0)) {
                         console.warn(`Link field '${linkFieldName}' on trigger record ${triggerRecordId} is empty. Cannot resolve linked placeholders starting with {{${linkFieldName}:...}}. Setting them to empty string.`);
                         for (const targetFieldName of targetFieldSet) {
                             const placeholderKey = `${linkFieldName}:${targetFieldName}`;
                             placeholderData[placeholderKey] = "";
                         }
                         continue; // Skip resolution for this link field
                     }

                    for (const targetFieldName of targetFieldSet) {
                        const placeholderKey = `${linkFieldName}:${targetFieldName}`;
                        try {
                            // Initial call to the recursive function
                            const visited = new Set(); // Initialize visited set for cycle detection per resolution path
                            placeholderData[placeholderKey] = await resolveLinkedValue(
                                linkFieldName,      // Field on the *current* record to start from (initially, the trigger record's link field)
                                targetFieldName,    // The ultimate target field name we want the value of
                                triggerTable,       // Initial table (trigger table)
                                triggerRecord,      // Initial record (trigger record)
                                0,                  // Initial depth
                                visited             // Pass the visited set
                            );
                        } catch (error) {
                            // Errors from resolveLinkedValue should be descriptive and thrown
                            console.error(`Error during linked value resolution for {{${placeholderKey}}}:`, error);
                            // Re-throw the error to ensure the automation fails as requested
                            throw new Error(`Failed to resolve placeholder {{${placeholderKey}}}: ${error.message}`);
                        }
                    }
                }

            } catch (error) {
                console.error("Error fetching trigger record or resolving placeholder data:", error);
                throw error; // Re-throw
            }
        } else {
             console.log("No placeholders require data fetching from the trigger record.");
        }


        // --- 7. Replace Placeholders in Template ---
        const finalSubject = templateSubjectField ? replaceAllPlaceholders(templateSubjectText, placeholderData) : null;
        const finalBody = replaceAllPlaceholders(templateBodyText, placeholderData);

        // --- 8. Return Result ---
        return {
            subject: finalSubject,
            body: finalBody
        };
    }

    // Return the main function so it can be used externally
    return { processTemplate };

}; // End of initializeTemplateProcessor wrapper function
