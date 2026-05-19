const admin = require('firebase-admin');
// Ensure this path matches where you saved the downloaded key
const serviceAccount = require('./serviceAccountKey.json'); 

// Initialize the Admin SDK securely
if (!admin.apps.length) {
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

async function runUITest() {
  console.log("🚀 Starting Full End-to-End UI Simulation...");

  try {
    // Step 1: Inject the Resource (Ambulance)
    console.log("🚑 Adding available ambulance to the database...");
    const resourceRef = db.collection('Resources').doc('amb_kashmir_hwy');
    await resourceRef.set({
      type: "ambulance",
      status: "available",
      current_location: {
        latitude: 33.6700,
        longitude: 73.0150
      }
    });
    console.log("✅ Ambulance added! Check your app for a Blue Pin.");

    // Wait 3 seconds so you can physically watch the map update before the crisis hits
    console.log("⏳ Waiting 3 seconds before triggering the crisis...");
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Step 2: Inject the Emergency Signal
    console.log("🚨 Injecting high-severity medical emergency signal...");
    const mockPayload = {
      source: "social_media_twitter",
      payload: "Bara accident hua hai Kashmir Highway par G-10 ke pass, 2 log shadeed zakhmi hain, khoon beh raha hai jaldi ambulance bhejo!!",
      location_lat: 33.6750,
      location_lng: 73.0110,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    };

    const signalRef = await db.collection('IncomingSignals').add(mockPayload);
    console.log(`✅ Success! Injected accident signal with ID: ${signalRef.id}`);

    console.log("\n📱 LOOK AT YOUR PHONE NOW!");
    console.log("You should see the Red Pin drop, and the Live Feed will update within 5-10 seconds as the Swarm processes the data.");

  } catch (error) {
    console.error("❌ Error running UI test:", error);
  }
}

runUITest();