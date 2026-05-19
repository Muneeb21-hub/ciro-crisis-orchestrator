const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json'); 
if (!admin.apps.length) { admin.initializeApp({ credential: admin.credential.cert(serviceAccount) }); }
const db = admin.firestore();

async function runTest() {
  console.log("🔥 Starting the Golden Demo (Industrial Fire)...");
  try {
    // 1. Spawn Multiple Resources
    console.log("🚒 Spawning Firetruck and Police Unit...");
    await db.collection('Resources').doc('fire_engine_i9').set({
      type: "firetruck", status: "available", current_location: { latitude: 33.6600, longitude: 73.0400 }
    });
    await db.collection('Resources').doc('police_unit_i9').set({
      type: "police", status: "available", current_location: { latitude: 33.6620, longitude: 73.0450 }
    });
    
    await new Promise(res => setTimeout(res, 3000));

    // 2. Trigger the Fire
    console.log("🚨 Injecting I-9 Industrial Fire signal...");
    await db.collection('IncomingSignals').add({
      source: "emergency_call_transcript",
      payload: "I-9 Industrial area mein factory mein aag lag gayi hai. Bohat dhuaan hai aur aag tezi se phel rahi hai. Foran fire brigade aur police bhejein crowd control ke liye!",
      location_lat: 33.6650,
      location_lng: 73.0420,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    });
    console.log("✅ Success! Look at your app. Both resources should be dispatched, and the logs will reflect a multi-unit coordinated response.");
  } catch (error) { console.error("Error:", error); }
}
runTest();