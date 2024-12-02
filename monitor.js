const WebSocket = require('ws');
const { JSDOM } = require("jsdom");
const axios = require('axios');
const { exec } = require('child_process');

// WebSocket server URL
const SERVER_URL = 'ws://192.168.110.93:8083/graphql';
const HA_TOKEN = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiIzMjU3MzZmODNhYzA0ODMxYmM2MzJmMmJkZmE5NWFkNCIsImlhdCI6MTczMzEzMzgzNiwiZXhwIjoyMDQ4NDkzODM2fQ.K22l3sQdaNB5xbUZn6Y5-V_Tsx8UJIUSbNhCN6_Ar28';
const HA_URL = 'http://192.168.110.11:8123/api/services/tts/cloud_say';
const HA_DEVICE = 'media_player.ke_ting';
const RECONNECT_INTERVAL = 5 * 60 * 1000; // 5 minutes

// Threshold distance to trigger notification
const THRESHOLD_DISTANCE = 21;
const THRESHOLD_RESET = 40;

const WS_HEADERS = {
    'Upgrade': 'websocket',
    'Origin': 'http://192.168.110.93:8083',
    'Cache-Control': 'no-cache',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    'Pragma': 'no-cache',
    'Connection': 'Upgrade',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    'Sec-WebSocket-Version': '13',
    'Sec-WebSocket-Protocol': 'graphql-ws',
    'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits',
};

// Variable to track whether notification has already been triggered
let notificationTriggered = false;

function speak(message) {
    const command = `say "${message}"`;
    exec(command, (error, stdout, stderr) => {
        if (error) {
            console.error('Error speaking:', error);
        }
    });
}

// not using this now, as it will interrupt the music playing on HomePod and remove the HomePod from its group
async function sendNotificationToHomePod(message) {
    try {
        const response = await axios.post(
            HA_URL,
            {
                entity_id: HA_DEVICE, // Replace with your HomePod entity ID
                message: message,
            },
            {
                headers: {
                    Authorization: `Bearer ${HA_TOKEN}`,
                    'Content-Type': 'application/json',
                },
            }
        );
        console.log('Notification sent to HomePod:', response.data);
    } catch (err) {
        console.error('Error sending notification to HomePod:', err);
    }
}

// Placeholder notification method
async function notifyDistanceBelowThreshold(distance) {
    const message = `Attention, please get prepared for descending.`;
    console.log('Sending notification:', message);
    // await sendNotificationToHomePod(message);
    speak(message);
}

// Parse MCDU display data
function parseMCDUData(value) {
    try {
        // Parse the XML-like structure
        const dom = new JSDOM(value, { contentType: "text/xml" });
        const root = dom.window.document.documentElement;

        // Get all <line> elements
        const lines = Array.from(root.getElementsByTagName("line"));

        for (let i = 0; i < lines.length; i++) {
            const currentLine = lines[i].textContent.trim();

            // Look for the line containing DIST
            if (currentLine.includes("DIST") && i + 1 < lines.length) {
                // Get the next line and extract the distance value
                const nextLine = lines[i + 1].textContent.trim();
                const match = nextLine.match(/(\d+)w/);
                if (match) {
                    return parseInt(match[1], 10);
                }
            }
        }
    } catch (err) {
        console.error("Error parsing MCDU data:", err);
    }
    return null;
}

function connectWebSocket() {
    // Connect to WebSocket server
    const ws = new WebSocket(SERVER_URL, 'graphql-ws', { headers: WS_HEADERS });

    // Handle WebSocket connection open
    ws.on('open', () => {
        console.log('Connected to WebSocket server.');

        // Initialize the GraphQL connection
        ws.send(
            JSON.stringify({
                type: 'connection_init',
            })
        );

        // Subscribe to MCDU display updates
        ws.send(
            JSON.stringify({
                id: '1',
                type: 'start',
                payload: {
                    variables: {
                        names: [
                            "aircraft.mcdu1.display"
                        ],
                    },
                    extensions: {},
                    operationName: "OnDataRefChanged",
                    query: `
                    subscription OnDataRefChanged($names: [String!]!) {
                        dataRefs(names: $names) {
                            name
                            value
                            __typename
                        }
                    }
                `,
                },
            })
        );

        console.log('Subscription to MCDU display data sent.');
    });

    // Handle WebSocket messages
    ws.on('message', (data) => {
        try {
            const message = JSON.parse(data);
            // console.log('Received message:', JSON.stringify(message, null, 2));

            if (
                message.type === 'data' &&
                message.payload?.data?.dataRefs?.name === 'aircraft.mcdu1.display'
            ) {
                const mcduValue = message.payload.data.dataRefs.value;
                const distance = parseMCDUData(mcduValue);

                if (distance !== null) {
                    console.log(`Distance to T/D: ${distance} nm`);

                    // Trigger notification if distance falls below threshold
                    if (!notificationTriggered && distance < THRESHOLD_DISTANCE) {
                        notifyDistanceBelowThreshold(distance);
                        notificationTriggered = true;
                    }

                    if (notificationTriggered && distance > THRESHOLD_RESET) {
                        notificationTriggered = false;
                    }
                }
            }
        } catch (err) {
            console.error('Error processing WebSocket message:', err);
        }
    });

    // Handle WebSocket errors
    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
    });

    // Handle WebSocket closure
    ws.on('close', (code, reason) => {
        console.log('WebSocket connection closed: code:', code, ', reason:', reason);
        setTimeout(connectWebSocket, RECONNECT_INTERVAL);
    });
}

// Start the WebSocket connection
connectWebSocket();
