import { db } from './db';
import { generatePhoneVariations, extractPhoneNumberFromJid, formatPhoneForDisplay } from './phoneUtils';

async function testSuite() {
  console.log('======================================================');
  console.log('  TESTING PHONE UTILS & DATABASE INTEGRATION');
  console.log('======================================================\n');

  // Test 1: Phone Normalization & Variations
  const sampleJid = '966512345678:42@s.whatsapp.net';
  const extracted = extractPhoneNumberFromJid(sampleJid);
  console.log(`[Test 1] Extract Phone from JID "${sampleJid}":`, extracted);
  console.log(`[Test 1] Display format:`, formatPhoneForDisplay(extracted));

  const variations = generatePhoneVariations(extracted);
  console.log(`[Test 1] Generated Variations for ${extracted}:`, variations);

  // Test 2: Database Connectivity
  console.log('\n[Test 2] Testing Database Connection...');
  const connected = await db.checkConnection();
  console.log(`[Test 2] Database Connection Result: ${connected ? 'SUCCESS ✅' : 'FAILED ❌'}`);

  if (connected) {
    // Test 3: Lookup sample numbers
    console.log('\n[Test 3] Testing User Phone Lookup...');
    const testNumbers = ['966512345678', '0512345678', '+966500000000'];
    for (const num of testNumbers) {
      const result = await db.findUserByPhone(num);
      console.log(`[Test 3] Lookup "${num}": Registered=${result.registered}, User=${result.user ? `${result.user.userName} (${result.user.email})` : 'Not Found'}`);
    }
  }

  await db.close();
  console.log('\n======================================================');
  console.log('  TEST SUITE COMPLETED');
  console.log('======================================================');
}

testSuite().catch(console.error);
