/**
 * baileysCompat.js — Compatibility shim for migrating from whatsapp-web.js to Baileys.
 *
 * Exposes a wwebjs-like API surface so that existing event handlers, commands,
 * and stores can remain largely unchanged.
 *
 * Correctly preserves @lid, @c.us, @s.whatsapp.net, and @g.us JIDs without destructive string replacement.
 */

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const EventEmitter = require('events');

const groupMetadataCache = new Map();

// ─── MessageMedia Shim ──────────────────────────────────────────────
class MessageMedia {
    constructor(mimetype, data, filename, filesize) {
        this.mimetype = mimetype;
        this.data = data;
        this.filename = filename || null;
        this.filesize = filesize || null;
    }

    static fromFilePath(filePath) {
        const absolutePath = path.resolve(filePath);
        const data = fs.readFileSync(absolutePath).toString('base64');
        const ext = path.extname(absolutePath).slice(1).toLowerCase();
        const mimeMap = {
            png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
            gif: 'image/gif', webp: 'image/webp', mp4: 'video/mp4',
            mp3: 'audio/mpeg', ogg: 'audio/ogg', pdf: 'application/pdf',
        };
        const mimetype = mimeMap[ext] || 'application/octet-stream';
        return new MessageMedia(mimetype, data, path.basename(absolutePath));
    }

    static async fromUrl(url) {
        const res = await axios.get(url, { responseType: 'arraybuffer', timeout: 30000 });
        const data = Buffer.from(res.data).toString('base64');
        const contentType = res.headers['content-type'] || 'application/octet-stream';
        const mimetype = contentType.split(';')[0].trim();
        const urlPath = new URL(url).pathname;
        const filename = path.basename(urlPath) || 'download';
        return new MessageMedia(mimetype, data, filename);
    }

    toBaileysContent(options = {}) {
        const buf = Buffer.from(this.data, 'base64');
        const mt = this.mimetype || '';

        if (mt.startsWith('image/')) {
            return {
                image: buf,
                mimetype: mt,
                caption: options.caption || undefined,
                mentions: options.mentions || undefined,
            };
        }
        if (mt.startsWith('video/')) {
            return {
                video: buf,
                mimetype: mt,
                caption: options.caption || undefined,
                gifPlayback: options.sendVideoAsGif || false,
                mentions: options.mentions || undefined,
            };
        }
        if (mt.startsWith('audio/')) {
            return {
                audio: buf,
                mimetype: mt,
                ptt: options.ptt || false,
            };
        }
        return {
            document: buf,
            mimetype: mt,
            fileName: this.filename || 'file',
            caption: options.caption || undefined,
            mentions: options.mentions || undefined,
        };
    }
}

// ─── JID helpers ────────────────────────────────────────────────────
function toJid(id) {
    if (!id) return id;
    if (id.includes('@')) return id;
    return `${id}@s.whatsapp.net`;
}

function toGroupJid(id) {
    if (!id) return id;
    if (id.includes('@g.us')) return id;
    return `${id}@g.us`;
}

/** Convert a Baileys JID to wwebjs-style serialized id while preserving @lid and @g.us */
function jidToSerialized(jid) {
    if (!jid) return '';
    if (jid.endsWith('@lid')) return jid;
    if (jid.endsWith('@g.us')) return jid;
    return jid.replace('@s.whatsapp.net', '@c.us');
}

/** Convert a wwebjs-style id to a Baileys JID preserving @lid and @g.us */
function serializedToJid(serialized) {
    if (!serialized) return '';
    if (serialized.endsWith('@lid')) return serialized;
    if (serialized.endsWith('@g.us')) return serialized;
    if (serialized.includes('@c.us')) return serialized.replace('@c.us', '@s.whatsapp.net');
    return `${serialized.split('@')[0]}@s.whatsapp.net`;
}

/** Extract user number or raw ID from any JID format. */
function extractUser(jid) {
    if (!jid) return '';
    return jid.split('@')[0].split(':')[0];
}

// ─── Contact Wrapper ────────────────────────────────────────────────
function wrapContact(jid, store, sock) {
    const user = extractUser(jid);
    const serialized = jidToSerialized(jid);
    const isLid = jid && jid.endsWith('@lid');

    let storeContact = null;
    if (store && store.contacts) {
        storeContact = store.contacts[jid] || store.contacts[serialized] || null;
    }

    return {
        id: {
            user: user,
            _serialized: serialized,
        },
        pushname: storeContact?.pushName || storeContact?.notify || '',
        name: storeContact?.name || storeContact?.verifiedName || '',
        shortName: storeContact?.short || '',
        verifiedName: storeContact?.verifiedName || '',
        number: isLid ? '' : user,
        isGroup: jid ? jid.endsWith('@g.us') : false,
        isLid,

        async getProfilePicUrl() {
            try {
                return await sock.profilePictureUrl(jid, 'image');
            } catch {
                return null;
            }
        },
    };
}

// ─── Chat Wrapper ───────────────────────────────────────────────────
async function wrapChat(jid, sock, store) {
    const isGroup = jid && jid.endsWith('@g.us');
    const serialized = jidToSerialized(jid);
    let _groupMetadata = null;

    const chat = {
        id: { _serialized: serialized },
        name: '',
        isGroup,
        participants: [],

        async sendMessage(content, options = {}) {
            const targetJid = serializedToJid(serialized);

            const mentions = (options.mentions || [])
                .map(m => {
                    if (typeof m === 'string') return serializedToJid(m);
                    if (m && m.id && m.id._serialized) return serializedToJid(m.id._serialized);
                    return null;
                })
                .filter(Boolean);

            if (content instanceof MessageMedia) {
                const baileysContent = content.toBaileysContent({ ...options, mentions });
                if (options.quotedMessageId) {
                    baileysContent.quoted = store?.messages?.[targetJid]?.get(options.quotedMessageId) || undefined;
                }
                const sent = await sock.sendMessage(targetJid, baileysContent);
                return wrapSentMessage(sent, targetJid);
            }

            const baileysContent = { text: String(content), mentions: mentions.length ? mentions : undefined };
            if (options.quotedMessageId) {
                baileysContent.quoted = store?.messages?.[targetJid]?.get(options.quotedMessageId) || undefined;
            }
            const sent = await sock.sendMessage(targetJid, baileysContent);
            return wrapSentMessage(sent, targetJid);
        },

        async removeParticipants(ids) {
            if (!isGroup) return;
            const jids = ids.map(id => serializedToJid(id));
            await sock.groupParticipantsUpdate(serializedToJid(serialized), jids, 'remove');
        },

        async promoteParticipants(ids) {
            if (!isGroup) return;
            const jids = ids.map(id => serializedToJid(id));
            await sock.groupParticipantsUpdate(serializedToJid(serialized), jids, 'promote');
        },

        async demoteParticipants(ids) {
            if (!isGroup) return;
            const jids = ids.map(id => serializedToJid(id));
            await sock.groupParticipantsUpdate(serializedToJid(serialized), jids, 'demote');
        },
    };

    if (isGroup) {
        const loadMeta = async () => {
            if (_groupMetadata) return _groupMetadata;
            
            const now = Date.now();
            const cached = groupMetadataCache.get(serialized);
            if (cached && now - cached.timestamp < 5 * 60 * 1000) {
                _groupMetadata = cached.data;
            } else {
                try {
                    _groupMetadata = await sock.groupMetadata(serializedToJid(serialized));
                    groupMetadataCache.set(serialized, { data: _groupMetadata, timestamp: now });
                } catch (err) {
                    console.warn('[BaileysCompat] Failed to get group metadata:', err.message);
                }
            }
            
            if (_groupMetadata) {
                chat.name = _groupMetadata.subject || '';
                chat.participants = (_groupMetadata.participants || []).map(p => ({
                    id: { _serialized: jidToSerialized(p.id) },
                    isAdmin: p.admin === 'admin' || p.admin === 'superadmin',
                    isSuperAdmin: p.admin === 'superadmin',
                }));
            }
            return _groupMetadata;
        };

        await loadMeta();
    }

    return chat;
}

// ─── Message Wrapper ────────────────────────────────────────────────
function wrapMessage(rawMsg, sock, store) {
    const key = rawMsg.key || {};
    const msgContent = rawMsg.message || {};
    const jid = key.remoteJid || '';
    const isGroup = jid.endsWith('@g.us');
    const fromMe = key.fromMe || false;

    const participant = key.participant || '';
    const from = jidToSerialized(jid);
    const author = isGroup ? jidToSerialized(participant) : from;

    const body = extractBody(msgContent);

    const hasMedia = !!(
        msgContent.imageMessage ||
        msgContent.videoMessage ||
        msgContent.audioMessage ||
        msgContent.documentMessage ||
        msgContent.stickerMessage
    );

    const contextInfo = extractContextInfo(msgContent);
    const hasQuotedMsg = !!(contextInfo && contextInfo.quotedMessage);

    const msgId = key.id || '';
    const serializedId = `${fromMe ? 'true' : 'false'}_${from}_${msgId}`;

    const timestamp = rawMsg.messageTimestamp
        ? (typeof rawMsg.messageTimestamp === 'object'
            ? rawMsg.messageTimestamp.low || rawMsg.messageTimestamp.toNumber?.() || 0
            : Number(rawMsg.messageTimestamp))
        : Math.floor(Date.now() / 1000);

    const type = hasMedia
        ? (msgContent.imageMessage ? 'image' :
           msgContent.videoMessage ? 'video' :
           msgContent.audioMessage ? 'audio' :
           msgContent.documentMessage ? 'document' :
           msgContent.stickerMessage ? 'sticker' : 'chat')
        : 'chat';

    const msg = {
        id: { _serialized: serializedId, id: msgId },
        from,
        author,
        body,
        fromMe,
        hasMedia,
        hasQuotedMsg,
        timestamp,
        type,
        _data: { quotedMsg: hasQuotedMsg ? { body: extractBody(contextInfo.quotedMessage) } : null },
        _rawKey: key,
        _rawMsg: rawMsg,

        async getChat() {
            return wrapChat(jid, sock, store);
        },

        async getContact() {
            const senderJid = isGroup ? participant : jid;
            return wrapContact(senderJid, store, sock);
        },

        async getMentions() {
            if (!contextInfo || !contextInfo.mentionedJid) return [];
            return contextInfo.mentionedJid
                .filter(Boolean)
                .map(mJid => wrapContact(mJid, store, sock));
        },

        async getQuotedMessage() {
            if (!hasQuotedMsg) return null;
            const quotedBody = extractBody(contextInfo.quotedMessage);
            return {
                id: { _serialized: contextInfo.stanzaId || '' },
                from,
                body: quotedBody,
                fromMe: contextInfo.participant ? false : true,
                hasMedia: !!(
                    contextInfo.quotedMessage?.imageMessage ||
                    contextInfo.quotedMessage?.videoMessage ||
                    contextInfo.quotedMessage?.audioMessage ||
                    contextInfo.quotedMessage?.documentMessage
                ),
                type: 'chat',
            };
        },

        async reply(text, chatId, options = {}) {
            const targetJid = serializedToJid(jid);

            const mentions = (options.mentions || [])
                .map(m => {
                    if (typeof m === 'string') return serializedToJid(m);
                    if (m && m.id && m.id._serialized) return serializedToJid(m.id._serialized);
                    return null;
                })
                .filter(Boolean);

            if (text instanceof MessageMedia) {
                const baileysContent = text.toBaileysContent({ ...options, mentions });
                baileysContent.quoted = rawMsg;
                const sent = await sock.sendMessage(targetJid, baileysContent);
                return wrapSentMessage(sent, targetJid);
            }

            const sent = await sock.sendMessage(targetJid, {
                text: String(text),
                mentions: mentions.length ? mentions : undefined,
            }, { quoted: rawMsg });
            return wrapSentMessage(sent, targetJid);
        },

        async react(emoji) {
            const targetJid = serializedToJid(jid);
            await sock.sendMessage(targetJid, {
                react: { text: emoji, key: key }
            });
        },

        async downloadMedia() {
            if (!hasMedia) return null;
            const { downloadMediaMessage } = require('@whiskeysockets/baileys');
            try {
                const buffer = await downloadMediaMessage(rawMsg, 'buffer', {});
                const mediaMsg = msgContent.imageMessage || msgContent.videoMessage ||
                                 msgContent.audioMessage || msgContent.documentMessage ||
                                 msgContent.stickerMessage;
                const mimetype = mediaMsg?.mimetype || 'application/octet-stream';
                const data = buffer.toString('base64');
                return new MessageMedia(mimetype, data, mediaMsg?.fileName || 'media');
            } catch (err) {
                console.error('[BaileysCompat] downloadMedia failed:', err.message);
                return null;
            }
        },
    };

    return msg;
}

function wrapSentMessage(sent, jid) {
    if (!sent) return null;
    const key = sent.key || {};
    return {
        id: {
            _serialized: `true_${jidToSerialized(jid)}_${key.id || ''}`,
            id: key.id || '',
        },
        key: sent.key,
    };
}

function extractBody(msgContent) {
    if (!msgContent) return '';
    return (
        msgContent.conversation ||
        msgContent.extendedTextMessage?.text ||
        msgContent.imageMessage?.caption ||
        msgContent.videoMessage?.caption ||
        msgContent.documentMessage?.caption ||
        msgContent.buttonsResponseMessage?.selectedDisplayText ||
        msgContent.listResponseMessage?.singleSelectReply?.selectedRowId ||
        msgContent.templateButtonReplyMessage?.selectedId ||
        ''
    );
}

function extractContextInfo(msgContent) {
    if (!msgContent) return null;
    return (
        msgContent.extendedTextMessage?.contextInfo ||
        msgContent.imageMessage?.contextInfo ||
        msgContent.videoMessage?.contextInfo ||
        msgContent.audioMessage?.contextInfo ||
        msgContent.documentMessage?.contextInfo ||
        msgContent.stickerMessage?.contextInfo ||
        msgContent.conversation?.contextInfo ||
        null
    );
}

function wrapSocket(sock, store) {
    const emitter = new EventEmitter();
    emitter.setMaxListeners(50);

    const botJid = sock.user?.id || '';
    const botUser = extractUser(botJid);
    const botSerialized = jidToSerialized(botJid);

    const client = {
        info: {
            wid: {
                user: botUser,
                _serialized: botSerialized,
            },
            pushname: sock.user?.name || 'Kitsune',
        },

        commands: new Map(),
        categories: new Map(),

        on: (event, fn) => emitter.on(event, fn),
        once: (event, fn) => emitter.once(event, fn),
        emit: (event, ...args) => emitter.emit(event, ...args),
        removeAllListeners: (event) => emitter.removeAllListeners(event),

        async sendMessage(chatId, content, options = {}) {
            const targetJid = serializedToJid(chatId);

            const mentions = (options.mentions || [])
                .map(m => {
                    if (typeof m === 'string') return serializedToJid(m);
                    if (m && m.id && m.id._serialized) return serializedToJid(m.id._serialized);
                    return null;
                })
                .filter(Boolean);

            if (content instanceof MessageMedia) {
                const baileysContent = content.toBaileysContent({ ...options, mentions });
                if (options.quotedMessageId) {
                    baileysContent.quoted = store?.messages?.[targetJid]?.get(options.quotedMessageId) || undefined;
                }
                const sent = await sock.sendMessage(targetJid, baileysContent);
                return wrapSentMessage(sent, targetJid);
            } else if (typeof content === 'object' && content !== null) {
                const baileysContent = { ...content, mentions: mentions.length ? mentions : undefined };
                if (options.quotedMessageId) {
                    baileysContent.quoted = store?.messages?.[targetJid]?.get(options.quotedMessageId) || undefined;
                }
                const sent = await sock.sendMessage(targetJid, baileysContent);
                return wrapSentMessage(sent, targetJid);
            }

            const baileysContent = { text: String(content), mentions: mentions.length ? mentions : undefined };
            if (options.quotedMessageId) {
                baileysContent.quoted = store?.messages?.[targetJid]?.get(options.quotedMessageId) || undefined;
            }
            const sent = await sock.sendMessage(targetJid, baileysContent);
            return wrapSentMessage(sent, targetJid);
        },

        async getContacts() {
            if (!store || !store.contacts) return [];
            return Object.entries(store.contacts).map(([jid, contact]) =>
                wrapContact(jid, store, sock)
            );
        },

        async getContactById(id) {
            const jid = serializedToJid(id);
            return wrapContact(jid, store, sock);
        },

        async getChatById(id) {
            const jid = serializedToJid(id);
            return wrapChat(jid, sock, store);
        },

        async getMessageById(id) {
            return null;
        },

        async destroy() {
            sock.end(undefined);
        },

        _sock: sock,
        _store: store,
    };

    return { client, emitter };
}

module.exports = {
    MessageMedia,
    wrapSocket,
    wrapMessage,
    wrapChat,
    wrapContact,
    toJid,
    toGroupJid,
    jidToSerialized,
    serializedToJid,
    extractUser,
};
