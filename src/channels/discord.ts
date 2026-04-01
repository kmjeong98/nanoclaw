import {
  Client,
  Events,
  GatewayIntentBits,
  Message,
  TextChannel,
} from 'discord.js';

import { ASSISTANT_NAME, TRIGGER_PATTERN } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

/**
 * A single Discord bot client that handles message intake and sending.
 * In dual-bot mode, the "claude" bot handles intake (listening for messages),
 * while each bot sends messages only for its own agent type channels.
 */
export class DiscordChannel implements Channel {
  name: string;

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  /** Which agent type this bot represents: 'claude' or 'codex' */
  private botRole: 'claude' | 'codex';
  /** Whether this bot instance should listen for incoming messages */
  private isIntakeBot: boolean;

  constructor(
    botToken: string,
    opts: DiscordChannelOpts,
    botRole: 'claude' | 'codex',
    isIntakeBot: boolean,
  ) {
    this.botToken = botToken;
    this.opts = opts;
    this.botRole = botRole;
    this.isIntakeBot = isIntakeBot;
    this.name = `discord-${botRole}`;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    // Only the intake bot listens for messages (to avoid double-processing)
    if (this.isIntakeBot) {
      this.client.on(Events.MessageCreate, async (message: Message) => {
        if (message.author.bot) return;

        const channelId = message.channelId;
        const chatJid = `dc:${channelId}`;
        let content = message.content;
        const timestamp = message.createdAt.toISOString();
        const senderName =
          message.member?.displayName ||
          message.author.displayName ||
          message.author.username;
        const sender = message.author.id;
        const msgId = message.id;

        let chatName: string;
        if (message.guild) {
          const textChannel = message.channel as TextChannel;
          chatName = `${message.guild.name} #${textChannel.name}`;
        } else {
          chatName = senderName;
        }

        // Translate Discord @bot mentions into TRIGGER_PATTERN format
        if (this.client?.user) {
          const botId = this.client.user.id;
          const isBotMentioned =
            message.mentions.users.has(botId) ||
            content.includes(`<@${botId}>`) ||
            content.includes(`<@!${botId}>`);

          if (isBotMentioned) {
            content = content
              .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
              .trim();
            if (!TRIGGER_PATTERN.test(content)) {
              content = `@${ASSISTANT_NAME} ${content}`;
            }
          }
        }

        // Handle attachments
        if (message.attachments.size > 0) {
          const attachmentDescriptions = [...message.attachments.values()].map(
            (att) => {
              const contentType = att.contentType || '';
              if (contentType.startsWith('image/')) {
                return `[Image: ${att.name || 'image'}]`;
              } else if (contentType.startsWith('video/')) {
                return `[Video: ${att.name || 'video'}]`;
              } else if (contentType.startsWith('audio/')) {
                return `[Audio: ${att.name || 'audio'}]`;
              } else {
                return `[File: ${att.name || 'file'}]`;
              }
            },
          );
          if (content) {
            content = `${content}\n${attachmentDescriptions.join('\n')}`;
          } else {
            content = attachmentDescriptions.join('\n');
          }
        }

        // Handle reply context
        if (message.reference?.messageId) {
          try {
            const repliedTo = await message.channel.messages.fetch(
              message.reference.messageId,
            );
            const replyAuthor =
              repliedTo.member?.displayName ||
              repliedTo.author.displayName ||
              repliedTo.author.username;
            content = `[Reply to ${replyAuthor}] ${content}`;
          } catch {
            // Referenced message may have been deleted
          }
        }

        const isGroup = message.guild !== null;
        this.opts.onChatMetadata(
          chatJid,
          timestamp,
          chatName,
          'discord',
          isGroup,
        );

        const group = this.opts.registeredGroups()[chatJid];
        if (!group) {
          logger.debug(
            { chatJid, chatName },
            'Message from unregistered Discord channel',
          );
          return;
        }

        this.opts.onMessage(chatJid, {
          id: msgId,
          chat_jid: chatJid,
          sender,
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
        });

        logger.info(
          { chatJid, chatName, sender: senderName },
          'Discord message stored',
        );
      });
    }

    this.client.on(Events.Error, (err) => {
      logger.error(
        { err: err.message },
        `Discord ${this.botRole} client error`,
      );
    });

    return new Promise<void>((resolve) => {
      this.client!.once(Events.ClientReady, (readyClient) => {
        logger.info(
          {
            username: readyClient.user.tag,
            id: readyClient.user.id,
            role: this.botRole,
            intake: this.isIntakeBot,
          },
          `Discord ${this.botRole} bot connected`,
        );
        console.log(
          `  Discord ${this.botRole} bot: ${readyClient.user.tag}${this.isIntakeBot ? ' (intake)' : ''}`,
        );
        resolve();
      });

      this.client!.login(this.botToken);
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn(`Discord ${this.botRole} client not initialized`);
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await textChannel.send(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await textChannel.send(text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info(
        { jid, length: text.length, bot: this.botRole },
        'Discord message sent',
      );
    } catch (err) {
      logger.error(
        { jid, err },
        `Failed to send Discord ${this.botRole} message`,
      );
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  /**
   * This bot "owns" a JID if:
   * - The channel's agentType matches this bot's role, OR
   * - The channel is 'dual' (both bots can send), OR
   * - This is the intake bot and it's for message reception (claude bot is primary)
   */
  ownsJid(jid: string): boolean {
    if (!jid.startsWith('dc:')) return false;

    const groups = this.opts.registeredGroups();
    const group = groups[jid];
    if (!group) {
      // Unregistered channel — only intake bot claims it
      return this.isIntakeBot;
    }

    const agentType = group.agentType || 'claude';
    if (agentType === 'dual') return true;
    return agentType === this.botRole;
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info(`Discord ${this.botRole} bot stopped`);
    }
  }

  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!this.client) return;

    // Stop existing interval for this JID
    const existing = this.typingIntervals.get(jid);
    if (existing) {
      clearInterval(existing);
      this.typingIntervals.delete(jid);
    }

    if (!isTyping) return;

    const sendOnce = async () => {
      try {
        const channelId = jid.replace(/^dc:/, '');
        const channel = await this.client!.channels.fetch(channelId);
        if (channel && 'sendTyping' in channel) {
          await (channel as TextChannel).sendTyping();
        }
      } catch (err) {
        logger.debug(
          { jid, err },
          `Failed to send Discord ${this.botRole} typing indicator`,
        );
      }
    };

    // Send immediately, then repeat every 8 seconds (Discord typing lasts ~10s)
    await sendOnce();
    const interval = setInterval(sendOnce, 8000);
    this.typingIntervals.set(jid, interval);
  }
}

registerChannel('discord-claude', (opts: ChannelOpts) => {
  const envVars = readEnvFile([
    'DISCORD_BOT_TOKEN_CLAUDE',
    'DISCORD_BOT_TOKEN',
  ]);
  const token =
    process.env.DISCORD_BOT_TOKEN_CLAUDE ||
    envVars.DISCORD_BOT_TOKEN_CLAUDE ||
    process.env.DISCORD_BOT_TOKEN ||
    envVars.DISCORD_BOT_TOKEN ||
    '';
  if (!token) {
    logger.warn('Discord Claude: DISCORD_BOT_TOKEN_CLAUDE not set');
    return null;
  }
  // Claude bot is the intake bot (handles message reception)
  return new DiscordChannel(token, opts, 'claude', true);
});

registerChannel('discord-codex', (opts: ChannelOpts) => {
  const envVars = readEnvFile(['DISCORD_BOT_TOKEN_CODEX']);
  const token =
    process.env.DISCORD_BOT_TOKEN_CODEX ||
    envVars.DISCORD_BOT_TOKEN_CODEX ||
    '';
  if (!token) {
    logger.warn(
      'Discord Codex: DISCORD_BOT_TOKEN_CODEX not set — Codex channels will be unavailable',
    );
    return null;
  }
  return new DiscordChannel(token, opts, 'codex', false);
});
