const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json'); 
if (!admin.apps.length) { admin.initializeApp({ credential: admin.credential.cert(serviceAccount) }); }
const db = admin.firestore();

async function runTest() {
  console.log("📢 Injecting benign social media noise...");
  try {
    const mockPayload = {
      source: "social_media_twitter",
      payload: "Aaj mausam bohat acha hai, Islamabad F-7 mein halki barish ho rahi hai pakoray khanay ka mood hai.", // "Weather is great, light rain in F-7, in the mood for snacks"
      location_lat: 33.7180,
      location_lng: 73.0560,
      timestamp: admin.firestore.FieldValue.serverTimestamp()
    };
    await db.collection('IncomingSignals').add(mockPayload);
    console.log("✅ Success! Check Cloud Logs. The Analysis Agent should score this low and NOT declare a crisis.");
  } catch (error) { console.error("Error:", error); }
}
runTest();