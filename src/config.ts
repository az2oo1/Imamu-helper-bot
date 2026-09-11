import dotenv from 'dotenv';
import path from 'path';

// Load .env file
dotenv.config({ path: path.join(__dirname, '../.env') });

export const config = {
  db: {
    url: process.env.DATABASE_URL || 'postgresql://root@100.70.48.23:26257/defaultdb?sslmode=disable',
    host: process.env.SQL_HOST || '100.70.48.23',
    port: parseInt(process.env.SQL_PORT || '26257', 10),
    user: process.env.SQL_USER || 'root',
    password: process.env.SQL_PASSWORD || '',
    database: process.env.SQL_DB_NAME || 'defaultdb',
    ssl: process.env.SQL_SSL === 'true',
  },
  bot: {
    autoRejectUnrecognized: process.env.AUTO_REJECT_UNRECOGNIZED === 'true',
    adminNumbers: (process.env.ADMIN_NUMBERS || '')
      .split(',')
      .map(n => n.trim().replace(/\D/g, ''))
      .filter(Boolean),
    usePairingCode: process.env.USE_PAIRING_CODE === 'true',
    pairingPhoneNumber: (process.env.PAIRING_PHONE_NUMBER || '').replace(/\D/g, ''),
  },
  server: {
    port: parseInt(process.env.PORT || '3001', 10),
  }
};
