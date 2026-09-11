import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  WASocket,
  getBinaryNodeChild,
  getBinaryNodeChildren,
  S_WHATSAPP_NET,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import path from 'path';
import fs from 'fs';
import { config } from './config';
import { db } from './db';
import { extractPhoneNumberFromJid, formatPhoneForDisplay, isLidJid } from './phoneUtils';

export class WhatsAppBot {
  private sock: WASocket | null = null;
  private isConnected: boolean = false;
  private logger = pino({ level: 'warn' });
  private authFolder = path.join(__dirname, '../auth_info_baileys');

  // In-memory cache mapping WhatsApp LID JIDs (e.g. 113164452651106@lid) -> Phone Numbers
  private lidToPnMap: Map<string, string> = new Map();

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
      syncFullHistory: false,    // Disable full history download to prevent 408 init query timeouts
      fireInitQueries: false,    // Skip optional init queries for faster & stable connection
      connectTimeoutMs: 60000,
      defaultQueryTimeoutMs: 60000,
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

        // Populate LID -> Phone map from existing group metadata
        await this.refreshLidMapFromGroups();

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
        await this.handleSingleJoinRequest(req.id, req.participant || req.jid, req.action || 'add', req);
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
   * Refreshes in-memory LID to Phone Number map by fetching group metadata across all participating groups.
   */
  private async refreshLidMapFromGroups(): Promise<void> {
    if (!this.sock || !this.isConnected) return;
    try {
      const groups = await this.sock.groupFetchAllParticipating();
      for (const group of Object.values(groups)) {
        if (group.participants) {
          for (const p of group.participants) {
            const phone = extractPhoneNumberFromJid(p.id || p.jid || '');
            if (p.lid && phone) {
              this.lidToPnMap.set(p.lid, phone);
            }
          }
        }
      }
      console.log(`[WhatsApp Bot] 📇 Cached ${this.lidToPnMap.size} LID-to-Phone mapping(s) from groups.`);
    } catch (err: any) {
      console.warn('[WhatsApp Bot] Warning: Could not cache LID map from groups:', err.message);
    }
  }

  /**
   * Resolves a JID (which may be an LID or a standard @s.whatsapp.net JID) into a numeric phone number.
   */
  private async resolvePhoneFromJid(jid: string, rawRequestObj?: any): Promise<string> {
    if (!jid) return '';

    // 1. If extra properties contain explicit phone number / PN attribute
    if (rawRequestObj) {
      const explicitPn = rawRequestObj.phone_number || rawRequestObj.pn || rawRequestObj.participant_pn || rawRequestObj.jid_pn || rawRequestObj.user_pn;
      if (explicitPn) {
        const phone = extractPhoneNumberFromJid(explicitPn);
        if (phone) return phone;
      }
    }

    // 2. If JID is a standard user JID (@s.whatsapp.net or @c.us)
    if (!isLidJid(jid)) {
      return extractPhoneNumberFromJid(jid);
    }

    // 3. If JID is an LID (@lid), check in-memory cached map
    if (this.lidToPnMap.has(jid)) {
      return this.lidToPnMap.get(jid)!;
    }

    // 4. Perform USync IQ query to WhatsApp server to resolve LID -> Phone Number
    if (this.sock) {
      try {
        const result = await this.sock.query({
          tag: 'iq',
          attrs: {
            to: S_WHATSAPP_NET,
            type: 'get',
            xmlns: 'usync'
          },
          content: [
            {
              tag: 'usync',
              attrs: {
                context: 'interactive',
                mode: 'query',
                sid: this.sock.generateMessageTag(),
                last: 'true',
                index: '0'
              },
              content: [
                { tag: 'query', attrs: {}, content: [{ tag: 'contact', attrs: {} }] },
                {
                  tag: 'list',
                  attrs: {},
                  content: [
                    {
                      tag: 'user',
                      attrs: { jid },
                      content: [{ tag: 'contact', attrs: {} }]
                    }
                  ]
                }
              ]
            }
          ]
        });

        const usyncNode = getBinaryNodeChild(result, 'usync');
        const listNode = getBinaryNodeChild(usyncNode, 'list');
        const userNode = getBinaryNodeChild(listNode, 'user');
        const contactNode = getBinaryNodeChild(userNode, 'contact');

        const phoneAttr = contactNode?.attrs?.phone || userNode?.attrs?.jid || userNode?.attrs?.phone_number;
        if (phoneAttr) {
          const phone = extractPhoneNumberFromJid(phoneAttr);
          if (phone) {
            this.lidToPnMap.set(jid, phone);
            return phone;
          }
        }
      } catch (err: any) {
        console.warn(`[WhatsApp Bot] USync LID lookup notice for ${jid}:`, err.message);
      }
    }

    return '';
  }

  /**
   * Process a single participant group join request.
   */
  private async handleSingleJoinRequest(groupJid: string, participantJid: string, action: string, rawReq?: any): Promise<boolean> {
    if (!this.sock) return false;

    console.log(`\n[WhatsApp Bot] 📥 Join Request detected in group ${groupJid}`);
    console.log(`[WhatsApp Bot] Raw Participant JID: ${participantJid} ${isLidJid(participantJid) ? '(LID Privacy Mode)' : ''}`);

    // Resolve real phone number from JID / LID
    const phone = await this.resolvePhoneFromJid(participantJid, rawReq);

    if (!phone) {
      console.log(`[WhatsApp Bot] ⚠️ Could not resolve Phone Number from LID "${participantJid}". Leaving request pending for admin review.`);
      return false;
    }

    const displayPhone = formatPhoneForDisplay(phone);
    console.log(`[WhatsApp Bot] Candidate Resolved Phone: ${displayPhone}`);

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
      console.log(`[WhatsApp Bot] ❌ User (${displayPhone}) NOT found in Database.`);

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
              const approved = await this.handleSingleJoinRequest(group.id, req.jid || req.participant, 'add', req);
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
    const senderPhone = await this.resolvePhoneFromJid(senderJid, msg.key);
    const body = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';

    if (!body.startsWith('!')) return;

    // Check admin permissions if admin numbers are specified in .env
    if (config.bot.adminNumbers.length > 0 && !config.bot.adminNumbers.includes(senderPhone)) {
      return; // Ignore commands from non-admin users
    }

    const parts = body.trim().split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1);

    console.log(`[WhatsApp Bot] Command received: "${body}" from ${senderPhone || senderJid}`);

    if (command === '!status') {
      const dbConnected = await db.checkConnection();
      const text = `🤖 *Imamu Helper WhatsApp Bot Status*\n\n` +
        `• Status: *Connected* ✅\n` +
        `• DB Connection: *${dbConnected ? 'Online ✅' : 'Offline ❌'}*\n` +
        `• Cached LIDs: *${this.lidToPnMap.size}*\n` +
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
                const rawJid = req.jid || req.participant;
                const phone = await this.resolvePhoneFromJid(rawJid, req);
                responseText += `   - ${phone ? formatPhoneForDisplay(phone) : rawJid}\n`;
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
      cachedLids: this.lidToPnMap.size,
    };
  }
}
