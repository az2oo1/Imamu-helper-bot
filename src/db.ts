import { Pool, PoolConfig } from 'pg';
import { config } from './config';
import { generatePhoneVariations, sanitizePhone } from './phoneUtils';

export interface UserRecord {
  id: number;
  uid: string;
  userName: string | null;
  email: string;
  phone: string | null;
  isBanned: boolean | null;
}

export interface UserLookupResult {
  registered: boolean;
  banned?: boolean;
  user?: UserRecord;
}

class DatabaseService {
  private pool: Pool | null = null;
  private isConnected: boolean = false;

  constructor() {
    this.initPool();
  }

  private initPool() {
    try {
      const poolConfig: PoolConfig = {
        connectionString: config.db.url,
        connectionTimeoutMillis: 5000,
      };

      if (config.db.ssl) {
        poolConfig.ssl = { rejectUnauthorized: false };
      }

      this.pool = new Pool(poolConfig);

      this.pool.on('error', (err) => {
        console.error('[DB] Unexpected error on idle database client:', err.message);
        this.isConnected = false;
      });
    } catch (err: any) {
      console.error('[DB] Failed to initialize connection pool:', err.message);
    }
  }

  /**
   * Check connection to the Imamu Helper database.
   */
  public async checkConnection(): Promise<boolean> {
    if (!this.pool) return false;
    try {
      const client = await this.pool.connect();
      const res = await client.query('SELECT NOW()');
      client.release();
      this.isConnected = true;
      return true;
    } catch (err: any) {
      console.error('[DB] Connection check failed:', err.message);
      this.isConnected = false;
      return false;
    }
  }

  /**
   * Search for a user in the imamu-helper database by phone number.
   */
  public async findUserByPhone(rawPhone: string): Promise<UserLookupResult> {
    if (!this.pool) {
      return { registered: false };
    }

    const cleanDigits = sanitizePhone(rawPhone);
    if (!cleanDigits) {
      return { registered: false };
    }

    const variations = generatePhoneVariations(rawPhone);

    try {
      // 1. Direct query matching phone column against generated variations or stripped digits
      const query = `
        SELECT id, uid, user_name AS "userName", email, phone, is_banned AS "isBanned"
        FROM users
        WHERE phone = ANY($1::text[])
           OR REGEXP_REPLACE(phone, '[^0-9]', '', 'g') = $2
        LIMIT 1;
      `;

      const result = await this.pool.query(query, [variations, cleanDigits]);

      if (result.rows.length > 0) {
        const user = result.rows[0] as UserRecord;
        if (user.isBanned) {
          return { registered: false, banned: true, user };
        }
        return { registered: true, user };
      }

      return { registered: false };
    } catch (err: any) {
      console.error('[DB] Error querying user by phone:', err.message);
      return { registered: false };
    }
  }

  /**
   * Log bot actions into imamu-helper activity_logs table if available.
   */
  public async logActivity(action: string, message: string, metadata?: any): Promise<void> {
    if (!this.pool) return;
    try {
      const query = `
        INSERT INTO activity_logs (level, category, action, message, metadata, created_at)
        VALUES ($1, $2, $3, $4, $5, NOW())
      `;
      await this.pool.query(query, [
        'info',
        'WHATSAPP_BOT',
        action,
        message,
        metadata ? JSON.stringify(metadata) : null,
      ]);
    } catch (err: any) {
      // Activity logging error is non-fatal
      console.warn('[DB] Optional activity logging skipped:', err.message);
    }
  }

  public async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
    }
  }
}

export const db = new DatabaseService();
