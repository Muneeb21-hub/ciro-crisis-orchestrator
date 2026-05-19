const admin = require('firebase-admin');
// Ensure this path matches where you saved the downloaded key
const serviceAccount = require('./serviceAccountKey.json'); 

// Initialize the Admin SDK securely
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function runTest() {
  console.log("🚀 Injecting mock crisis signal...");
  
  const mockPayload = {
    source: "social_media_twitter",
    payload: "Bhai G-10 markaz mein bohat bura haal hai, road par pani gariyon ke oopar se guzar raha hai. Log phans gaye hain, jaldi koi madad bhejo emergency hai!!",
    location_lat: 33.6730,
    location_lng: 73.0120,
    timestamp: admin.firestore.FieldValue.serverTimestamp()
  };

  try {
    const docRef = await db.collection('IncomingSignals').add(mockPayload);
    console.log(`✅ Success! Injected test signal with ID: ${docRef.id}`);
    console.log("👉 Now check Google Cloud Logs Explorer to watch the Swarm react!");
  } catch (error) {
    console.error("❌ Error injecting signal:", error);
  }
}

runTest();