const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json'); 
if (!admin.apps.length) { admin.initializeApp({ credential: admin.credential.cert(serviceAccount) }); }
const db = admin.firestore();

async function runTest() {
  console.log("🌊 Starting Flood Constraint Test...");
  try {
    // 1. Ensure an ambulance is available
    await db.collection('Resources').doc('amb_g10_rescue').set({
      type: "ambulance", status: "available", current_location: { latitude: 33.6700, longitude: 73.0150 }
    });
    console.log("🚑 Ambulance spawned on map. Waiting 3 seconds...");
    await new Promise(res => setTimeout(res, 3000));

    // 2. Trigger the Flood
    console.log("🚨 Injecting Severe Urban Flood signal...");
    await db.collection('IncomingSignals').add({
      source: "social_media_facebook",
      payload: "G-10 markaz mein road par pani gariyon ke oopar se guzar raha hai. Log phans gaye hain, jaldi boats bhejo!!",
      location_lat: 33.6730,
      location_lng: 73.0120,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log("✅ Success! Watch the logs: Orchestrator should return [] (empty deployment) and escalate.");
  } catch (error) { console.error("Error:", error); }
}
runTest();