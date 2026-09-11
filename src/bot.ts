import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
  GroupMetadata,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
import { config } from './config';
import { db } from './db';
import { extractPhoneNumberFromJid, formatPhoneForDisplay } from './phoneUtils';

export class WhatsAppBot {
  private sock: WASocket | null = null;
  private isConnected: boolean = false;
  private logger = pino({ level: 'info' });
  private authFolder = path.join(__dirname, '../auth_info_baileys');

  constructor() {
    if (!fs.existsSync(this.authFolder)) {
      fs.mkdirSync(this.authFolder, { recursive: true });
    }
  }

  public async start(): Promise<void> {
    console.log('[WhatsApp Bot] Initializing authentication state...');
    const { state, saveCreds } = await useMultiFileAuthState(this.authFolder);

    this.sock = makeWASocket({
      auth: state,
      printQRInTerminal: !config.bot.usePairingCode,
      logger: this.logger as any,
    });

    this.sock.ev.on('creds.update', saveCreds);

    // Connection update handler (QR code, pairing, reconnect)
    this.sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr && !config.bot.usePairingCode) {
        console.log('\n======================================================');
        console.log('  SCAN QR CODE BELOW TO AUTHORIZE WHATSAPP BOT');
        console.log('======================================================\n');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'close') {
        this.isConnected = false;
        const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(`[WhatsApp Bot] Connection closed. Reason: ${lastDisconnect?.error || 'Unknown'}. Reconnecting: ${shouldReconnect}`);

        if (shouldReconnect) {
          setTimeout(() => this.start(), 5000);
        } else {
          console.error('[WhatsApp Bot] Session logged out. Please clear auth_info_baileys folder and restart.');
        }
      } else if (connection === 'open') {
        this.isConnected = true;
        console.log('\n======================================================');
        console.log('  [WhatsApp Bot] SUCCESSFULLY CONNECTED TO WHATSAPP!');
        console.log(`  Bot Phone JID: ${this.sock?.user?.id}`);
        console.log('======================================================\n');

        // Trigger an initial check of pending requests in all groups
        await this.scanAndProcessAllPendingRequests();
      }
    });

    // Handle Pairing Code option if configured
    if (config.bot.usePairingCode && config.bot.pairingPhoneNumber && !state.creds.registered) {
      setTimeout(async () => {
        try {
          if (this.sock) {
            const code = await this.sock.requestPairingCode(config.bot.pairingPhoneNumber);
            console.log('\n======================================================');
            console.log(`  WHATSAPP PAIRING CODE: ${code}`);
            console.log('======================================================\n');
          }
        } catch (err: any) {
          console.error('[WhatsApp Bot] Error requesting pairing code:', err.message);
        }
      }, 3000);
    }

    // Event Listener: Group Join Requests (Real-time membership approval event)
    this.sock.ev.on('group-membership-request' as any, async (requests: any) => {
      const requestList = Array.isArray(requests) ? requests : [requests];
      for (const req of requestList) {
        await this.handleSingleJoinRequest(req.id, req.participant, req.action || 'add');
      }
    });

    // Event Listener: Admin Chat Commands
    this.sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        if (!msg.message || msg.key.fromMe) continue;
        await this.handleIncomingMessage(msg);
      }
    });
  }

  /**
   * Process a single participant group join request.
   */
  private async handleSingleJoinRequest(groupJid: string, participantJid: string, action: string): Promise<boolean> {
    if (!this.sock) return false;

    const phone = extractPhoneNumberFromJid(participantJid);
    const displayPhone = formatPhoneForDisplay(phone);

    console.log(`\n[WhatsApp Bot] 📥 Join Request detected in group ${groupJid}`);
    console.log(`[WhatsApp Bot] Candidate Phone: ${displayPhone} (${participantJid})`);

    // Lookup user in Imamu Helper DB
    const lookup = await db.findUserByPhone(phone);

    if (lookup.registered && lookup.user) {
      console.log(`[WhatsApp Bot] ✅ User FOUND in Database! Name: "${lookup.user.userName || 'N/A'}", Email: ${lookup.user.email}`);
      try {
        await this.sock.groupRequestParticipantsUpdate(groupJid, [participantJid], 'approve');
        console.log(`[WhatsApp Bot] 🎉 AUTOMATICALLY APPROVED join request for ${displayPhone}!`);

        await db.logActivity('AUTO_APPROVE_SUCCESS', `Approved ${displayPhone} for group ${groupJid}`, {
          groupJid,
          participantJid,
          phone,
          userId: lookup.user.id,
          userEmail: lookup.user.email,
        });
        return true;
      } catch (err: any) {
        console.error(`[WhatsApp Bot] ❌ Failed to approve participant ${participantJid}:`, err.message);
      }
    } else if (lookup.banned) {
      console.log(`[WhatsApp Bot] ⚠️ User is BANNED in Database. Rejecting request.`);
      try {
        await this.sock.groupRequestParticipantsUpdate(groupJid, [participantJid], 'reject');
        await db.logActivity('AUTO_REJECT_BANNED', `Rejected banned user ${displayPhone} for group ${groupJid}`, {
          groupJid,
          participantJid,
          phone,
        });
      } catch (e) {}
    } else {
      console.log(`[WhatsApp Bot] ❌ User NOT found in Database.`);

      if (config.bot.autoRejectUnrecognized) {
        try {
          await this.sock.groupRequestParticipantsUpdate(groupJid, [participantJid], 'reject');
          console.log(`[WhatsApp Bot] 🚫 Auto-rejected request for ${displayPhone} (AUTO_REJECT_UNRECOGNIZED is enabled).`);
          await db.logActivity('AUTO_REJECT_UNRECOGNIZED', `Rejected unregistered user ${displayPhone} for group ${groupJid}`, {
            groupJid,
            participantJid,
            phone,
          });
        } catch (err: any) {
          console.error(`[WhatsApp Bot] ❌ Failed to reject participant:`, err.message);
        }
      } else {
        console.log(`[WhatsApp Bot] ⏳ Request left PENDING for manual admin review.`);
      }
    }

    return false;
  }

  /**
   * Scan all admin groups for existing pending join requests and process them.
   */
  public async scanAndProcessAllPendingRequests(): Promise<{ totalGroups: number; totalApproved: number; totalPending: number }> {
    if (!this.sock || !this.isConnected) {
      return { totalGroups: 0, totalApproved: 0, totalPending: 0 };
    }

    console.log('[WhatsApp Bot] 🔍 Scanning all participating groups for pending join requests...');
    let totalGroups = 0;
    let totalApproved = 0;
    let totalPending = 0;

    try {
      const groups = await this.sock.groupFetchAllParticipating();
      const groupList = Object.values(groups);
      totalGroups = groupList.length;

      for (const group of groupList) {
        try {
          const pendingList = await this.sock.groupRequestParticipantsList(group.id);
          if (pendingList && pendingList.length > 0) {
            console.log(`[WhatsApp Bot] Found ${pendingList.length} pending request(s) in group: "${group.subject}" (${group.id})`);
            totalPending += pendingList.length;

            for (const req of pendingList) {
              const approved = await this.handleSingleJoinRequest(group.id, req.jid, 'add');
              if (approved) totalApproved++;
            }
          }
        } catch (err: any) {
          // Group might not have join approval turned on or bot is not admin
        }
      }
    } catch (err: any) {
      console.error('[WhatsApp Bot] Error fetching group list:', err.message);
    }

    console.log(`[WhatsApp Bot] Scan Complete. Managed Groups: ${totalGroups}, Approved: ${totalApproved}, Total Pending Remaining: ${totalPending - totalApproved}`);
    return { totalGroups, totalApproved, totalPending };
  }

  /**
   * Admin Chat Commands Handler
   */
  private async handleIncomingMessage(msg: any): Promise<void> {
    if (!this.sock) return;

    const senderJid = msg.key.remoteJid || '';
    const senderPhone = extractPhoneNumberFromJid(senderJid);
    const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';

    if (!body.startsWith('!')) return;

    // Check admin permissions if admin numbers are specified in .env
    if (config.bot.adminNumbers.length > 0 && !config.bot.adminNumbers.includes(senderPhone)) {
      return; // Ignore commands from non-admin users
    }

    const parts = body.trim().split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);

    console.log(`[WhatsApp Bot] Command received: "${body}" from ${senderPhone}`);

    if (command === '!status') {
      const dbConnected = await db.checkConnection();
      const text = `🤖 *Imamu Helper WhatsApp Bot Status*\n\n` +
        `• Status: *Connected* ✅\n` +
        `• DB Connection: *${dbConnected ? 'Online ✅' : 'Offline ❌'}*\n` +
        `• Auto Reject Unrecognized: *${config.bot.autoRejectUnrecognized ? 'Enabled 🔴' : 'Disabled (Pending Mode) 🟡'}*\n` +
        `• Bot JID: \`${this.sock.user?.id}\``;
      await this.sock.sendMessage(senderJid, { text });
    } else if (command === '!approveall') {
      await this.sock.sendMessage(senderJid, { text: '⏳ Scanning all groups for pending join requests and approving users...' });
      const stats = await this.scanAndProcessAllPendingRequests();
      const reply = `✅ *Scan Complete*\n\n` +
        `• Total Managed Groups: *${stats.totalGroups}*\n` +
        `• Automatically Approved: *${stats.totalApproved}*\n` +
        `• Remaining Pending: *${stats.totalPending - stats.totalApproved}*`;
      await this.sock.sendMessage(senderJid, { text: reply });
    } else if (command === '!check' && args.length > 0) {
      const phoneToCheck = args[0];
      const lookup = await db.findUserByPhone(phoneToCheck);
      let reply = `🔎 *Database Lookup for ${phoneToCheck}*\n\n`;
      if (lookup.registered && lookup.user) {
        reply += `✅ *STATUS: REGISTERED*\n` +
          `• Name: ${lookup.user.userName || 'N/A'}\n` +
          `• Email: ${lookup.user.email}\n` +
          `• UID: ${lookup.user.uid}\n` +
          `• Stored Phone: ${lookup.user.phone}`;
      } else if (lookup.banned) {
        reply += `⚠️ *STATUS: BANNED USER*`;
      } else {
        reply += `❌ *STATUS: NOT FOUND* in Imamu Helper database.`;
      }
      await this.sock.sendMessage(senderJid, { text: reply });
    } else if (command === '!pending') {
      let responseText = `📋 *Pending Group Join Requests*\n\n`;
      try {
        const groups = await this.sock.groupFetchAllParticipating();
        let totalCount = 0;
        for (const group of Object.values(groups)) {
          try {
            const pending = await this.sock.groupRequestParticipantsList(group.id);
            if (pending && pending.length > 0) {
              responseText += `👥 *${group.subject}* (${pending.length} pending):\n`;
              for (const req of pending) {
                const phone = extractPhoneNumberFromJid(req.jid);
                responseText += `   - +${phone}\n`;
                totalCount++;
              }
              responseText += `\n`;
            }
          } catch (e) {}
        }
        if (totalCount === 0) {
          responseText += `No pending join requests found across managed groups.`;
        }
      } catch (err: any) {
        responseText += `Error fetching pending requests: ${err.message}`;
      }
      await this.sock.sendMessage(senderJid, { text: responseText });
    } else if (command === '!help') {
      const helpText = `🤖 *Imamu Helper WhatsApp Bot Commands*\n\n` +
        `• \`!status\` - Check bot status and DB connection.\n` +
        `• \`!pending\` - List all pending join requests across groups.\n` +
        `• \`!approveall\` - Scan and auto-approve pending verified users.\n` +
        `• \`!check <phone>\` - Manually check if a phone number exists in DB.\n` +
        `• \`!help\` - Display this menu.`;
      await this.sock.sendMessage(senderJid, { text: helpText });
    }
  }

  public getStatus() {
    return {
      connected: this.isConnected,
      botJid: this.sock?.user?.id || null,
    };
  }
}
