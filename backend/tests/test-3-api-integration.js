const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json'); 
if (!admin.apps.length) { admin.initializeApp({ credential: admin.credential.cert(serviceAccount) }); }
const db = admin.firestore();

async function runTest() {
  console.log("📡 Injecting Simulated Google Maps Traffic API Payload...");
  try {
    // Note: The payload is stringified JSON simulating an API webhook
    const mockPayload = {
      source: "google_maps_api_mock",
      payload: JSON.stringify({
          status: "severe_congestion_anomaly",
          speed_kmh: 0,
          road: "Srinagar Highway",
          cause: "Unknown obstruction"
      }),
      location_lat: 33.6844,
      location_lng: 73.0479,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    };
    await db.collection('IncomingSignals').add(mockPayload);
    console.log("✅ API Signal Injected! The Swarm will now process raw JSON instead of text.");
  } catch (error) { console.error("Error:", error); }
}
runTest();