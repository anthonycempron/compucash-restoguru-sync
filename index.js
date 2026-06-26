const fs = require('fs');
const axios = require('axios');
const path = require('path');

// File paths on your local C: Drive
//const CONFIG_FILE = 'C:\\compucash-sync\\clients.json';
//const CACHE_DIR = 'C:\\compucash-sync\\states\\';

// Render production paths
const CONFIG_FILE = '/data/clients.json';
const CACHE_DIR = '/data/states/';

// Dynamic, runtime memory space to hold live authentication keys per client
// This prevents us from having to read/write tokens back to the JSON file
const tokenMemoryStore = {};

function hasDataChanged(oldData, newData) {
    return JSON.stringify(oldData) !== JSON.stringify(newData);
}

function getQueryDates() {
    const today = new Date();
    const tomorrow = new Date();
    tomorrow.setDate(today.getDate() + 1);
    const formatDate = (date) => date.toISOString().split('T')[0];
    return { startDate: formatDate(today), endDate: formatDate(tomorrow) };
}

// 1. Dynamic OAuth2 Client Credentials Flow Handler
async function getClientAccessToken(client) {
    const currentTime = Date.now();
    
    // Initialize memory footprint for client tokens if it doesn't exist yet
    if (!tokenMemoryStore[client.name]) {
        tokenMemoryStore[client.name] = { oauthToken: null, tokenExpiryTime: 0 };
    }

    const cached = tokenMemoryStore[client.name];
    if (cached.oauthToken && currentTime < (cached.tokenExpiryTime - 60000)) {
        return cached.oauthToken;
    }

    console.log(`[${client.name}] Token stale or missing. Fetching fresh OAuth2 token...`);
    try {
        const params = new URLSearchParams();
        params.append('grant_type', 'client_credentials');
        params.append('client_id', client.compucash_client_id);
        params.append('client_secret', client.compucash_client_secret);
        params.append('scope', 'cc5api');

        const response = await axios.post('https://identityserver.ektaco.ee/connect/token', params, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });

        cached.oauthToken = response.data.access_token;
        cached.tokenExpiryTime = Date.now() + (response.data.expires_in * 1000);
        return cached.oauthToken;
    } catch (error) {
        console.error(`[${client.name}] Authentication with CompuCash failed:`, error.response?.data || error.message);
        return null;
    }
}

async function fetchInvoiceDetails(invoiceId, token) {
    try {
        const response = await axios.get(`https://www.compucash5.ae/cc5partners/Invoice/OpenInvoices/${invoiceId}`, {
            headers: { 'Authorization': `Bearer ${token}`, 'accept': 'application/json', 'Content-Type': 'application/json' }
        });
        return response.data?.data || response.data;
    } catch (error) {
        return null;
    }
}

// 2. Synchronization Processor per Client Identity Configuration
async function syncSingleClient(client) {
    try {
        const token = await getClientAccessToken(client);
        if (!token) return;

        // --- PART A: OPEN INVOICES ---
        const compucashListResponse = await axios.get('https://www.compucash5.ae/cc5partners/Invoice/OpenInvoices', {
            headers: { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' }
        });

        const openInvoices = compucashListResponse.data?.data?.results || [];
        const detailedInvoicesPromises = openInvoices.map(async (invoice) => {
            const id = invoice.invoice || invoice.invoiceId || invoice.id;
            if (!id) return null;
            const details = await fetchInvoiceDetails(id, token);
            return {
                table_id: id,
                table_number: details?.tableId || invoice.tableId || `Invoice #${id}`,
                is_occupied: true,
                status: "OPEN",
                current_bill_total: details?.sum || details?.totalSum || invoice.sum || 0,
                initial_payment: details?.paid || invoice.paid || 0,
                covers: details?.guestsCount || invoice.guestsCount || 0,
                items: details?.rows || details?.products || []
            };
        });
        const mappedOpenTables = (await Promise.all(detailedInvoicesPromises)).filter(item => item !== null);

        // --- PART B: CLOSED INVOICES ---
        const { startDate, endDate } = getQueryDates();
        const closedInvoicesResponse = await axios.get(`https://www.compucash5.ae/cc5partners/Invoice?StartDate=${startDate}&EndDate=${endDate}`, {
            headers: { 'Authorization': `Bearer ${token}`, 'accept': 'application/json' }
        });

        const closedInvoices = closedInvoicesResponse.data?.data?.results || [];
        const mappedClosedTables = closedInvoices.map(invoice => {
            const id = invoice.invoice || invoice.invoiceId || invoice.id;
            return {
                table_id: id,
                table_number: invoice.tableId || `Invoice #${id}`,
                is_occupied: false,
                status: "PAID",
                current_bill_total: invoice.sum || invoice.totalSum || 0,
                initial_payment: invoice.paid || 0,
                covers: invoice.guestsCount || 0,
                items: invoice.rows || invoice.products || []
            };
        });

        // --- PART C: EVALUATE & POST STATE CHANGES ---
        const currentLiveState = [...mappedOpenTables, ...mappedClosedTables];
        const stateFile = path.join(CACHE_DIR, `last_state_${client.name}.json`);

        let lastSentState = [];
        if (fs.existsSync(stateFile)) {
            try {
                lastSentState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
            } catch (e) {
                // fall back gracefully
            }
        }

        if (!hasDataChanged(lastSentState, currentLiveState)) {
            console.log(`[${client.name}] Floor plan matches cache. Skipping update.`);
            return;
        }

        console.log(`[${client.name}] Changes detected! Pushing payload to Restoguru...`);
        await axios.post('https://us-central1-waitlist-app-3154b.cloudfunctions.net/compuCash/webhooks', {
            provider: "compucash",
            client_identity: client.name,
            updated_at: new Date().toISOString(),
            tables: currentLiveState
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${client.restoguru_token}`
            }
        });

        if (!fs.existsSync(CACHE_DIR)){
            fs.mkdirSync(CACHE_DIR, { recursive: true });
        }
        fs.writeFileSync(stateFile, JSON.stringify(currentLiveState, null, 2));
        console.log(`[${client.name}] Sync successfully updated.`);

    } catch (error) {
        console.error(`[${client.name}] Sync process encountered an error:`, error.message);
    }
}

// 3. Orchestration Routine (Dynamically extracts configs every 60s)
async function runMasterSync() {
    console.log(`\n--- Starting Dynamic Master Iteration [${new Date().toISOString()}] ---`);
    
    // Check if the configuration file exists
    if (!fs.existsSync(CONFIG_FILE)) {
        console.error(`Configuration manager file missing at ${CONFIG_FILE}. Skipping run.`);
        return;
    }

    try {
        // Read configuration file live on every iteration loop
        const configRaw = fs.readFileSync(CONFIG_FILE, 'utf8');
        const activeClients = JSON.parse(configRaw);

        if (!Array.isArray(activeClients) || activeClients.length === 0) {
            console.log('No registered clients found in configuration file.');
            return;
        }

        console.log(`Loaded ${activeClients.length} clients from API configurations.`);

        // Launch all synchronization requests in parallel
        const syncPromises = activeClients.map(client => syncSingleClient(client));
        await Promise.allSettled(syncPromises);

    } catch (error) {
        console.error('Failed to parse clients.json configurations file:', error.message);
    }
    
    console.log(`--- Dynamic Master Iteration Complete ---`);
}

// Setup execution interval
const SYNC_INTERVAL = 60000;
setInterval(runMasterSync, SYNC_INTERVAL);
runMasterSync();