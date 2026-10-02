// Node.js server integration. Never import this file or secret into a browser bundle.
import { createHmac, randomUUID } from 'node:crypto';
export async function sendUltraCRMEvent({ endpoint, secret, event, eventId = randomUUID() }) {
  // Preserve eventId and activityAt when retrying a business event across process restarts.
  const raw = JSON.stringify(event);
  for (let attempt = 0; attempt < 5; attempt++) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    let response;
    try {
      response = await fetch(endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'Content-Type': 'application/json', 'X-UltraCRM-Timestamp': timestamp, 'X-UltraCRM-Event-Id': eventId,
          'X-UltraCRM-Signature': createHmac('sha256', secret).update(`${timestamp}.${eventId}.${raw}`).digest('base64') }, body: raw });
    } catch (error) { if (attempt === 4) throw error; }
    if (response?.ok) return response.json(); // 202 means durably queued, not yet processed.
    if (response && response.status < 500 && response.status !== 429) throw new Error(`UltraCRM HTTP ${response.status}: ${await response.text()}`);
    if (attempt < 4) await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
  }
  throw new Error(`UltraCRM delivery failed; persist and retry event ${eventId}`);
}
