import express from 'express';
import { config } from './config';
import { db } from './db';
import { WhatsAppBot } from './bot';

async function main() {
  console.log('======================================================');
  console.log('  STARTING IMAMU HELPER WHATSAPP BOT SERVICE');
  console.log('======================================================\n');

  // 1. Verify Database Connection
  console.log('[Init] Checking connection to Imamu Helper database...');
  const dbOk = await db.checkConnection();
  if (dbOk) {
    console.log('[Init] ✅ Successfully connected to Imamu Helper Database!');
  } else {
    console.warn('[Init] ⚠️ Database connection failed or unreachable. Bot will retry on operations.');
  }

  // 2. Start WhatsApp Bot
  const bot = new WhatsAppBot();
  await bot.start();

  // 3. Express Health Check Server
  const app = express();
  app.use(express.json());

  app.get('/health', async (_req, res) => {
    const dbStatus = await db.checkConnection();
    const botStatus = bot.getStatus();
    res.json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      databaseConnected: dbStatus,
      whatsappConnected: botStatus.connected,
      botJid: botStatus.botJid,
      autoRejectUnrecognized: config.bot.autoRejectUnrecognized,
    });
  });

  app.post('/api/approve-all', async (_req, res) => {
    try {
      const stats = await bot.scanAndProcessAllPendingRequests();
      res.json({ success: true, stats });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/check/:phone', async (req, res) => {
    const { phone } = req.params;
    const lookup = await db.findUserByPhone(phone);
    res.json(lookup);
  });

  app.listen(config.server.port, () => {
    console.log(`[Init] 🚀 Health check & API server listening on http://localhost:${config.server.port}/health\n`);
  });
}

main().catch((err) => {
  console.error('[Init] Fatal startup error:', err);
  process.exit(1);
});
