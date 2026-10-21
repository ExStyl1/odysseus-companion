import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import { tmpdir } from 'node:os';
import { ChannelBase } from '@nestor/nessy-cli-channel-base';
import type {
  ChannelConfig,
  ChannelBaseOptions,
  Envelope,
  AcpBridge,
  Attachment,
} from '@nestor/nessy-cli-channel-base';
import { splitMessage } from './markdown.js';
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';

/** Minimal Mattermost post shape from API responses. */
interface MmPost {
  id: string;
  channel_id: string;
  user_id: string;
  root_id: string;
  message: string;
  type: string;
  file_ids?: string[];
  props?: Record<string, unknown>;
  create_at: number;
}

interface MmFileInfo {
  id: string;
  name: string;
  extension: string;
  mime_type: string;
  size: number;
}

interface MmReaction {
  emoji_name: string;
  user_id: string;
}

interface MmChannelUnread {
  team_id: string;
  channel_id: string;
  msg_count: number;
  mention_count: number;
  last_viewed_at?: number;
}

interface PendingApproval {
  sessionId: string;
  chatId: string;
  threadId?: string;
  toolName: string;
  description: string;
  resolve: (approve: boolean) => void;
}

export class ChannelTimeAdapter extends ChannelBase {
  private serverUrl: string;
  private token: string;
  private botUserId: string = '';
  private botUsername: string = '';
  private botDisplayName: string = '';
  private typingIntervals = new Map<string, ReturnType<typeof setInterval>>();
  /** Polling for new messages */
  private pollingInterval: ReturnType<typeof setInterval> | null = null;
  private readonly POLL_INTERVAL_MS = 2000; // 2 seconds
  private channelIds: string[] = []; // channels to poll
  /** In-memory tracking of posts currently being processed (prevents race conditions) */
  private processingPostIds = new Set<string>();
  /** Pending approval requests waiting for user response */
  private pendingApprovals = new Map<string, PendingApproval>(); // toolCallId -> approval
  /** Track threadId per chatId for sending replies (updated on each message) */
  private chatThreads = new Map<string, string>(); // chatId -> threadId

  constructor(
    name: string,
    config: ChannelConfig,
    bridge: AcpBridge,
    options?: ChannelBaseOptions,
  ) {
    super(name, config, bridge, options);
    this.serverUrl = (
      (config as ChannelConfig & { serverUrl: string }).serverUrl || ''
    ).replace(/\/+$/, '');
    this.token = config.token;
  }

  // ── REST API helpers ───────────────────────────────────────────────

  private async api<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const url = `${this.serverUrl}/api/v4${path}`;
    const resp = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(
        `Mattermost API ${method} ${path}: ${resp.status} ${text}`,
      );
    }
    return resp.json() as Promise<T>;
  }

  private async apiRaw(
    method: string,
    path: string,
  ): Promise<{ buffer: Buffer; contentType: string }> {
    const url = `${this.serverUrl}/api/v4${path}`;
    const resp = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!resp.ok) {
      throw new Error(`Mattermost API ${method} ${path}: ${resp.status}`);
    }
    return {
      buffer: Buffer.from(await resp.arrayBuffer()),
      contentType:
        resp.headers.get('content-type') || 'application/octet-stream',
    };
  }

  // ── Connect ────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    // Get bot identity
    const me = await this.api<{
      id: string;
      username: string;
      display_name: string;
    }>('GET', '/users/me');
    this.botUserId = me.id;
    this.botUsername = me.username;
    this.botDisplayName = me.display_name || me.username;
    process.stderr.write(
      `[ChannelTime:${this.name}] Connected as @${this.botUsername} (${this.botDisplayName})\n`,
    );
    process.stderr.write(
      `[ChannelTime:${this.name}] Using REST API polling with reaction tracking\n`,
    );

    // Get channels the bot is a member of
    await this.discoverChannels();

    // Start polling for new messages
    this.startPolling();

    process.once('SIGINT', () => this.disconnect());
    process.once('SIGTERM', () => this.disconnect());
  }

  private async discoverChannels(): Promise<void> {
    // Get all channels the bot is a member of (including private channels)
    const channels = await this.api<
      Array<{ id: string; name: string; type?: string }>
    >('GET', '/users/me/channels');

    for (const channel of channels) {
      this.channelIds.push(channel.id);
      process.stderr.write(
        `[ChannelTime:${this.name}] Discovered channel: ${channel.name} (${channel.id}) type=${channel.type}\n`,
      );
    }

    process.stderr.write(
      `[ChannelTime:${this.name}] Bot is a member of ${this.channelIds.length} channels\n`,
    );
  }

  private startPolling(): void {
    process.stderr.write(
      `[ChannelTime:${this.name}] Starting message polling every ${this.POLL_INTERVAL_MS}ms\n`,
    );
    this.pollingInterval = setInterval(() => {
      this.pollMessages().catch((err) => {
        process.stderr.write(
          `[ChannelTime:${this.name}] Polling error: ${err instanceof Error ? err.message : err}\n`,
        );
      });
    }, this.POLL_INTERVAL_MS);
  }

  /** Check if bot has already reacted to a post (meaning it was processed) */
  private async hasBotReaction(postId: string): Promise<boolean> {
    try {
      const reactions = await this.api<MmReaction[]>(
        'GET',
        `/posts/${postId}/reactions`,
      );
      return reactions.some(
        (r) => r.emoji_name === 'eyes' && r.user_id === this.botUserId,
      );
    } catch {
      return false;
    }
  }

  /** Mark post as processed by adding eyes reaction */
  private async markAsProcessed(postId: string): Promise<void> {
    try {
      await this.api('POST', '/reactions', {
        user_id: this.botUserId,
        post_id: postId,
        emoji_name: 'eyes',
      });
    } catch (e) {
      process.stderr.write(
        `[ChannelTime:${this.name}] Failed to mark post ${postId} as processed: ${e instanceof Error ? e.message : e}\n`,
      );
    }
  }

  /**
   * Check if message is addressed to bot by name (without @mention).
   * Examples: "gus привет", "гус как дела", "бот hello", "гусь помоги", "гусу расскажи"
   */
  private isAddressedByName(messageText: string): boolean {
    if (!this.botUsername && !this.botDisplayName) return false;

    const text = messageText.toLowerCase().trim();

    // Create patterns for username and display name
    const patterns: string[] = [];

    // Add username pattern (e.g., "gus")
    if (this.botUsername) {
      patterns.push(this.botUsername.toLowerCase());
    }

    // Add display name pattern (e.g., "Gus Bot" -> "gus bot")
    if (this.botDisplayName && this.botDisplayName !== this.botUsername) {
      patterns.push(this.botDisplayName.toLowerCase());
    }

    // Add Russian transliteration of username (e.g., "gus" -> "гус")
    if (this.botUsername) {
      const ruTranslit = this.transliterateToRussian(
        this.botUsername.toLowerCase(),
      );
      if (ruTranslit !== this.botUsername.toLowerCase()) {
        patterns.push(ruTranslit);

        // Strategy 1: Add Russian variations (soft/hard signs, ё/е)
        const ruVariations = this.getRussianVariations(ruTranslit);
        patterns.push(...ruVariations);

        // Strategy 2: Add Russian declensions (гус -> гусу, гусом, о гусе)
        const ruDeclensions = this.declineRussianName(ruTranslit);
        patterns.push(...ruDeclensions);
      }
    }

    // Check if message starts with any of the patterns
    for (const pattern of patterns) {
      // Match: "pattern" followed by space/punctuation/end
      const regex = new RegExp(
        `^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s:!,.?]|^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`,
        'i',
      );
      if (regex.test(text)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Get Russian name variations (soft/hard signs, ё/е substitution).
   * Example: "гус" -> ["гусь", "гуса", "гусю"]
   */
  private getRussianVariations(name: string): string[] {
    const variations: string[] = [];

    // Add soft sign at the end (гус -> гусь)
    if (!name.endsWith('ь') && !name.endsWith('ъ')) {
      variations.push(name + 'ь');
    }

    // Add hard sign at the end (less common, but possible)
    if (!name.endsWith('ь') && !name.endsWith('ъ')) {
      variations.push(name + 'ъ');
    }

    // Replace ё with е (ё -> е)
    if (name.includes('ё')) {
      variations.push(name.replace(/ё/g, 'е'));
    }

    // Replace е with ё (е -> ё)
    if (name.includes('е')) {
      variations.push(name.replace(/е/g, 'ё'));
    }

    return variations;
  }

  /**
   * Generate common Russian declensions for a name.
   * Examples: "гус" -> ["гуса", "гусу", "гусом", "гусе"]
   */
  private declineRussianName(name: string): string[] {
    const declensions: string[] = [];

    // Only decline short names (1-2 syllables, typically 2-10 characters)
    if (name.length < 2 || name.length > 10) return declensions;

    // Masculine ending with consonant
    if (/[бвгджзклмнпрстфхцчшщ]$/.test(name)) {
      declensions.push(name + 'а'); // Genitive: гуса
      declensions.push(name + 'у'); // Dative: гусу
      declensions.push(name + 'ом'); // Instrumental: гусом
      declensions.push(name + 'е'); // Prepositional: о гусе
    }
    // Masculine ending with -й
    else if (name.endsWith('й')) {
      const stem = name.slice(0, -1);
      declensions.push(stem + 'я'); // Genitive
      declensions.push(stem + 'ю'); // Dative
      declensions.push(stem + 'ем'); // Instrumental
      declensions.push(stem + 'е'); // Prepositional
    }
    // Masculine ending with -о
    else if (name.endsWith('о')) {
      const stem = name.slice(0, -1);
      declensions.push(stem + 'ы'); // Genitive
      declensions.push(stem + 'у'); // Dative
      declensions.push(stem + 'ом'); // Instrumental
      declensions.push(stem + 'е'); // Prepositional
    }
    // Feminine ending with -а
    else if (name.endsWith('а')) {
      const stem = name.slice(0, -1);
      declensions.push(stem + 'ы'); // Genitive
      declensions.push(stem + 'е'); // Dative/Prepositional
      declensions.push(stem + 'у'); // Accusative
      declensions.push(stem + 'ой'); // Instrumental
    }

    return declensions;
  }

  /**
   * Transliterate Latin characters to Russian (simplified).
   * Examples: "gus" -> "гус", "bot" -> "бот"
   */
  private transliterateToRussian(text: string): string {
    const translitMap: Record<string, string> = {
      a: 'а',
      b: 'б',
      v: 'в',
      g: 'г',
      d: 'д',
      e: 'е',
      yo: 'ё',
      zh: 'ж',
      z: 'з',
      i: 'и',
      y: 'ы',
      k: 'к',
      l: 'л',
      m: 'м',
      n: 'н',
      o: 'о',
      p: 'п',
      r: 'р',
      s: 'с',
      t: 'т',
      u: 'у',
      f: 'ф',
      kh: 'х',
      ts: 'ц',
      ch: 'ч',
      sh: 'ш',
      shch: 'щ',
      yu: 'ю',
      ya: 'я',
    };

    let result = text;

    // Replace multi-character patterns first (yo, zh, kh, ts, ch, sh, shch, yu, ya)
    const multiCharPatterns = [
      'shch',
      'yo',
      'zh',
      'kh',
      'ts',
      'ch',
      'sh',
      'yu',
      'ya',
    ];
    for (const pattern of multiCharPatterns) {
      if (translitMap[pattern]) {
        result = result.replace(new RegExp(pattern, 'g'), translitMap[pattern]);
      }
    }

    // Replace single characters
    for (const [latin, cyrillic] of Object.entries(translitMap)) {
      if (latin.length === 1) {
        result = result.replace(new RegExp(latin, 'g'), cyrillic);
      }
    }

    return result;
  }

  /**
   * Get unread message count for a channel.
   * Returns ChannelUnread object with msg_count and mention_count.
   */
  private async getChannelUnread(
    channelId: string,
  ): Promise<MmChannelUnread | null> {
    try {
      const unread = await this.api<MmChannelUnread>(
        'GET',
        `/users/me/channels/${channelId}/unread`,
      );
      return unread;
    } catch (e) {
      process.stderr.write(
        `[ChannelTime:${this.name}] Failed to get unread for channel ${channelId}: ${e instanceof Error ? e.message : e}\n`,
      );
      return null;
    }
  }

  /**
   * Get posts around the last unread post in a channel.
   * This is more efficient than fetching all posts — only returns unread and surrounding posts.
   */
  private async getPostsAroundLastUnread(channelId: string): Promise<MmPost[]> {
    try {
      const response = await this.api<{
        order?: string[];
        posts?: Record<string, MmPost>;
      }>(
        'GET',
        `/users/me/channels/${channelId}/posts/unread?limit_before=60&limit_after=60`,
      );

      // Extract posts array from response
      const postsArray: MmPost[] = [];
      if (response && typeof response === 'object') {
        const order = response.order || [];
        const posts = response.posts || {};
        // Build array in order (newest first from API)
        for (const id of order) {
          const post = posts[id];
          if (post) postsArray.push(post);
        }
      }

      // Sort by create_at ascending (oldest first) for processing
      postsArray.sort((a, b) => a.create_at - b.create_at);

      return postsArray;
    } catch (e) {
      process.stderr.write(
        `[ChannelTime:${this.name}] Failed to get unread posts for channel ${channelId}: ${e instanceof Error ? e.message : e}\n`,
      );
      return [];
    }
  }

  private async pollMessages(): Promise<void> {
    // Poll all channels the bot is a member of
    for (const channelId of this.channelIds) {
      // OPTIMIZATION: First check if there are any unread messages
      const unreadInfo = await this.getChannelUnread(channelId);

      // Skip channel if no unread messages
      if (
        unreadInfo &&
        unreadInfo.msg_count === 0 &&
        unreadInfo.mention_count === 0
      ) {
        continue;
      }

      // Fetch unread posts from this channel
      // This is more efficient than fetching all posts — only returns unread and surrounding posts
      const postsArray = await this.getPostsAroundLastUnread(channelId);

      if (postsArray.length === 0) {
        continue;
      }

      for (const post of postsArray) {
        // Check if already processed (has bot's eyes reaction) - check FIRST and silently skip
        const alreadyProcessed = await this.hasBotReaction(post.id);
        if (alreadyProcessed) {
          continue;
        }

        if (post.user_id === this.botUserId) {
          continue;
        }
        if (post.type && post.type.startsWith('system_')) {
          continue;
        }

        process.stderr.write(
          `[ChannelTime:${this.name}] Post ${post.id}: user=${post.user_id}, create_at=${post.create_at}, text="${post.message?.substring(0, 30) || ''}"\n`,
        );

        // Check if this post is currently being processed (in-memory tracking)
        if (this.processingPostIds.has(post.id)) {
          process.stderr.write(
            `[ChannelTime:${this.name}]   -> SKIP: currently being processed\n`,
          );
          continue;
        }

        // Check if bot is mentioned or this is a reply to bot
        let isMentioned = false;
        const messageText = post.message || '';

        // Check if this is a response to a pending approval request (before mention check)
        const isApprovalResponse = await this.handleApprovalResponse(
          post.channel_id,
          messageText,
        );
        if (isApprovalResponse) {
          // Mark as processed and skip normal handling
          await this.markAsProcessed(post.id);
          continue;
        }
        const mentionsProp = post.props?.['mentions'];

        // In DM channels (type='D'), all messages are addressed to bot
        const isDM = post.type === 'D';
        if (isDM) {
          isMentioned = true;
          process.stderr.write(
            `[ChannelTime:${this.name}]   -> DM channel, isMentioned=true\n`,
          );
        } else if (mentionsProp) {
          try {
            const mentions: string[] = JSON.parse(mentionsProp as string);
            isMentioned = mentions.includes(this.botUserId);
            process.stderr.write(
              `[ChannelTime:${this.name}]   -> mentions prop: ${mentionsProp}, parsed: ${mentions}, botId=${this.botUserId}, isMentioned=${isMentioned}\n`,
            );
          } catch (e) {
            isMentioned = messageText
              .toLowerCase()
              .includes(`@${this.botUsername.toLowerCase()}`);
            process.stderr.write(
              `[ChannelTime:${this.name}]   -> mentions parse failed, fallback to text check: isMentioned=${isMentioned}\n`,
            );
          }
        } else {
          // No mentions prop - check for @mention or name-based address
          const hasAtMention = messageText
            .toLowerCase()
            .includes(`@${this.botUsername.toLowerCase()}`);

          // Also check if addressed to bot by name (e.g., "gus привет")
          const addressedByName = this.isAddressedByName(messageText);

          isMentioned = hasAtMention || addressedByName;

          if (addressedByName && !hasAtMention) {
            process.stderr.write(
              `[ChannelTime:${this.name}]   -> addressed by name: "${messageText.substring(0, 50)}", isMentioned=${isMentioned}\n`,
            );
          } else {
            process.stderr.write(
              `[ChannelTime:${this.name}]   -> no mentions prop, text check: "${messageText.substring(0, 50)}", hasAtMention=${hasAtMention}, addressedByName=${addressedByName}, isMentioned=${isMentioned}\n`,
            );
          }
        }

        // Check if this is a reply to bot's message (thread)
        let isReplyToBot = false;
        let threadRootId: string | undefined = undefined;
        if (post.root_id) {
          // Always find the ROOT of the thread (not just immediate parent)
          try {
            let currentPost = await this.api<MmPost>(
              'GET',
              `/posts/${post.root_id}`,
            );
            threadRootId = currentPost.root_id || post.root_id; // Root is either its own root_id or itself

            // If this post has a root_id, fetch the actual root
            if (currentPost.root_id) {
              threadRootId = currentPost.root_id;
            }

            // Check if root is from bot
            isReplyToBot = currentPost.user_id === this.botUserId;

            // If root is not from bot, check if bot has replied in this thread
            if (!isReplyToBot) {
              // Fetch all posts in the thread to check if bot participated
              const threadPosts = await this.api<{
                order?: string[];
                posts?: Record<string, MmPost>;
              }>('GET', `/posts/${threadRootId}/thread?per_page=60`);
              const threadOrder = threadPosts.order || [];
              const threadPostsMap = threadPosts.posts || {};
              isReplyToBot = threadOrder.some((id) => {
                const p = threadPostsMap[id];
                return p && p.user_id === this.botUserId;
              });
            }

            process.stderr.write(
              `[ChannelTime:${this.name}]   -> reply to root ${threadRootId}, post.root_id=${post.root_id}, botInThread=${isReplyToBot}, isReplyToBot=${isReplyToBot}\n`,
            );
          } catch (e) {
            process.stderr.write(
              `[ChannelTime:${this.name}]   -> reply check failed: ${e instanceof Error ? e.message : e}\n`,
            );
          }
        }

        // Debug: show decision
        process.stderr.write(
          `[ChannelTime:${this.name}]   -> Decision: isMentioned=${isMentioned}, isReplyToBot=${isReplyToBot}, threadRootId=${threadRootId || 'none'}\n`,
        );

        // Skip messages not addressed to bot
        if (!isMentioned && !isReplyToBot) {
          process.stderr.write(
            `[ChannelTime:${this.name}]   -> SKIP: not addressed to bot\n`,
          );
          // Mark as processed even if not addressed to bot (to avoid checking again)
          await this.markAsProcessed(post.id);
          continue;
        }

        process.stderr.write(
          `[ChannelTime:${this.name}]   -> PROCESSING: isMentioned=${isMentioned}, isReplyToBot=${isReplyToBot}\n`,
        );

        // Mark as being processed (in-memory) to prevent race conditions
        this.processingPostIds.add(post.id);

        try {
          // Mark as processed IMMEDIATELY to prevent duplicate processing in next polling cycle
          await this.markAsProcessed(post.id);

          // Then process the post
          // isGroup=false for all channels — bot responds to mentions in any channel type
          const isGroup = false;
          await this.handlePost(
            post,
            isGroup,
            isMentioned,
            isReplyToBot,
            threadRootId,
          );
        } finally {
          // Remove from processing set after handling
          this.processingPostIds.delete(post.id);
        }
      }
    }
  }

  private async handlePost(
    post: MmPost,
    isGroup: boolean,
    isMentioned: boolean,
    isReplyToBot: boolean,
    threadRootId?: string,
  ): Promise<void> {
    // Skip posts without message
    if (!post.message) return;

    // Clean text: strip @mention
    let cleanText = post.message;
    if (isMentioned && this.botUsername) {
      cleanText = cleanText
        .replace(new RegExp(`@${this.botUsername}`, 'gi'), '')
        .trim();
    }

    // Thread handling: get or create session
    // Note: sessionId will be created by router.resolve() in handleInbound
    // We just need to track threadId for sending replies
    let referencedText: string | undefined;
    const threadIdForReply = threadRootId || post.id;

    if (threadRootId) {
      // Existing thread - fetch root post for referenced text
      try {
        const rootPost = await this.api<MmPost>(
          'GET',
          `/posts/${threadRootId}`,
        );
        referencedText = rootPost.message || undefined;
      } catch {
        // Failed to fetch root post — not critical
      }
    }

    // Store threadId for this chat (for sending replies)
    this.chatThreads.set(post.channel_id, threadIdForReply);
    process.stderr.write(
      `[ChannelTime:${this.name}]   -> chatThreads[${post.channel_id}] = ${threadIdForReply}\n`,
    );

    // Sender name
    const senderName = await this.fetchUsername(post.user_id);

    // File attachments
    let imageBase64: string | undefined;
    let imageMimeType: string | undefined;
    const attachments: Attachment[] = [];

    if (post.file_ids && post.file_ids.length > 0) {
      for (const fileId of post.file_ids) {
        try {
          const fileInfo = await this.api<MmFileInfo>(
            'GET',
            `/files/${fileId}/info`,
          );
          const { buffer, contentType } = await this.apiRaw(
            'GET',
            `/files/${fileId}`,
          );

          if (contentType.startsWith('image/') && !imageBase64) {
            imageBase64 = buffer.toString('base64');
            imageMimeType = contentType;
          } else {
            const dir = join(tmpdir(), 'channel-files', randomUUID());
            mkdirSync(dir, { recursive: true });
            const fileName = fileInfo.name || `file_${Date.now()}`;
            const filePath = join(dir, basename(fileName));
            writeFileSync(filePath, buffer);
            attachments.push({
              type: contentType.startsWith('image/')
                ? 'image'
                : contentType.startsWith('audio/')
                  ? 'audio'
                  : contentType.startsWith('video/')
                    ? 'video'
                    : 'file',
              filePath,
              mimeType: contentType,
              fileName,
            });
          }
        } catch (err) {
          process.stderr.write(
            `[ChannelTime:${this.name}] Failed to download file ${fileId}: ${err instanceof Error ? err.message : err}\n`,
          );
          cleanText += `\n\n(User sent a file but download failed)`;
        }
      }
    }

    // Get sessionId from router BEFORE handleInbound (so we can use it for thread tracking)
    const sessionIdForThread = threadRootId || post.id;

    const envelope: Envelope = {
      channelName: this.name,
      senderId: post.user_id,
      senderName,
      chatId: post.channel_id,
      text: cleanText,
      threadId: sessionIdForThread, // Use for session resolution
      messageId: post.id,
      isGroup,
      isMentioned,
      isReplyToBot,
      referencedText,
      imageBase64,
      imageMimeType,
      attachments: attachments.length > 0 ? attachments : undefined,
    };

    process.stderr.write(
      `[ChannelTime:${this.name}] Calling handleInbound: senderId=${post.user_id}, isGroup=${isGroup}, threadId=${threadRootId || 'none'}, text="${cleanText.substring(0, 30)}"\n`,
    );

    // Set approval mode for this session if configured
    if (this.config.approvalMode) {
      process.stderr.write(
        `[ChannelTime:${this.name}] Setting approval mode: ${this.config.approvalMode}\n`,
      );
      // Note: approvalMode is handled by the ACP bridge / CLI config
      // This is just for logging — actual mode is set in the CLI process
    }

    this.handleInbound(envelope).catch((err) => {
      process.stderr.write(
        `[ChannelTime:${this.name}] Error handling message: ${err}\n`,
      );
    });

    process.stderr.write(
      `[ChannelTime:${this.name}] handleInbound called for message ${post.id}\n`,
    );
  }

  private userCache = new Map<string, string>();

  private async fetchUsername(userId: string): Promise<string> {
    const cached = this.userCache.get(userId);
    if (cached) return cached;
    try {
      const user = await this.api<{ username: string }>(
        'GET',
        `/users/${userId}`,
      );
      this.userCache.set(userId, user.username);
      return user.username;
    } catch {
      return userId;
    }
  }

  // ── Outbound: send message ─────────────────────────────────────────

  async sendMessage(
    chatId: string,
    text: string,
    threadId?: string,
  ): Promise<void> {
    process.stderr.write(
      `[ChannelTime:${this.name}] sendMessage called: chatId=${chatId}, threadId=${threadId || 'none'}, text="${text.substring(0, 50)}"\n`,
    );

    const chunks = splitMessage(text);

    for (const chunk of chunks) {
      try {
        await this.api('POST', '/posts', {
          channel_id: chatId,
          message: chunk,
          root_id: threadId, // Reply in thread (or undefined for new thread)
        });
        process.stderr.write(
          `[ChannelTime:${this.name}] Message sent successfully${threadId ? ` in thread ${threadId}` : ''}\n`,
        );
      } catch (err) {
        process.stderr.write(
          `[ChannelTime:${this.name}] Failed to send message: ${err instanceof Error ? err.message : err}\n`,
        );
      }
    }
  }

  // ── Typing indicators ──────────────────────────────────────────────

  protected override onPromptStart(
    chatId: string,
    sessionId: string,
    messageId?: string,
  ): void {
    process.stderr.write(
      `[ChannelTime:${this.name}] onPromptStart: sessionId=${sessionId}\n`,
    );

    const existing = this.typingIntervals.get(chatId);
    if (existing) clearInterval(existing);

    const sendTyping = () => {
      this.api('POST', `/users/${this.botUserId}/typing`, {
        channel_id: chatId,
      }).catch(() => {});
    };
    sendTyping();
    this.typingIntervals.set(chatId, setInterval(sendTyping, 4000));

    if (messageId) {
      this.api('POST', '/reactions', {
        user_id: this.botUserId,
        post_id: messageId,
        emoji_name: 'eyes',
      }).catch(() => {});
    }
  }

  protected override onPromptEnd(
    chatId: string,
    sessionId: string,
    messageId?: string,
  ): void {
    process.stderr.write(
      `[ChannelTime:${this.name}] onPromptEnd: sessionId=${sessionId}\n`,
    );

    const interval = this.typingIntervals.get(chatId);
    if (interval) {
      clearInterval(interval);
      this.typingIntervals.delete(chatId);
    }

    // Clean up chat thread mapping
    this.chatThreads.delete(chatId);

    // DO NOT remove the eyes reaction — it's used to track processed messages
    // The reaction should persist to prevent re-processing on next poll
  }

  protected override onResponseChunk(
    chatId: string,
    chunk: string,
    sessionId: string,
  ): void {
    process.stderr.write(
      `[ChannelTime:${this.name}] onResponseChunk: sessionId=${sessionId}, chunk="${chunk.substring(0, 30)}"\n`,
    );
  }

  protected override async onResponseComplete(
    chatId: string,
    fullText: string,
    sessionId: string,
  ): Promise<void> {
    const threadId = this.chatThreads.get(chatId);
    process.stderr.write(
      `[ChannelTime:${this.name}] onResponseComplete: sessionId=${sessionId}, chatId=${chatId}, threadId=${threadId || 'none'}, text="${fullText.substring(0, 50)}"\n`,
    );
    await this.sendMessage(chatId, fullText, threadId);
  }

  // ── Approval System ────────────────────────────────────────────────

  /**
   * Handle permission request from ACP.
   * Sends approval request to user in Mattermost and waits for response.
   */
  async requestApproval(
    params: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const toolCall = params.toolCall as Record<string, unknown> | undefined;
    const toolName = (toolCall?.['kind'] as string) || 'unknown';
    const title = (toolCall?.['title'] as string) || 'Unknown operation';
    const rawInput = toolCall?.['rawInput'] as
      | Record<string, unknown>
      | undefined;

    // Build description from rawInput
    let description = title;
    if (rawInput) {
      // Try to extract meaningful info
      if (typeof rawInput['command'] === 'string') {
        description = `Execute: ${rawInput['command']}`;
      } else if (typeof rawInput['path'] === 'string') {
        description = `${title}: ${rawInput['path']}`;
      }
    }

    const sessionId = params.sessionId;
    const toolCallId = (toolCall?.['toolCallId'] as string) || '';

    // Find the chatId for this session
    const target = this.router.getTarget(sessionId);
    if (!target) {
      // Can't find chat — auto-reject
      return { outcome: { outcome: 'cancelled' } };
    }

    const chatId = target.chatId;
    const threadId = target.threadId;

    // Send approval request to user
    const approvalMessage = `⚠️ **Permission Request**

**Tool:** ${toolName}
**Operation:** ${description}

Reply with:
• \`yes\` — Approve
• \`no\` — Reject`;

    await this.sendMessage(chatId, approvalMessage, threadId);

    // Wait for user response (with timeout)
    return new Promise<RequestPermissionResponse>((resolve) => {
      const timeout = setTimeout(() => {
        // Timeout — reject
        this.pendingApprovals.delete(toolCallId);
        resolve({ outcome: { outcome: 'cancelled' } });
      }, 60000); // 60 second timeout

      this.pendingApprovals.set(toolCallId, {
        sessionId,
        chatId,
        threadId,
        toolName,
        description,
        resolve: (approve: boolean) => {
          clearTimeout(timeout);
          this.pendingApprovals.delete(toolCallId);

          if (approve) {
            resolve({
              outcome: { outcome: 'selected', optionId: 'proceed_once' },
            });
          } else {
            resolve({ outcome: { outcome: 'cancelled' } });
          }
        },
      });
    });
  }

  /**
   * Handle user response to approval request.
   * Called from pollMessages when user replies to approval request.
   */
  private async handleApprovalResponse(
    chatId: string,
    text: string,
  ): Promise<boolean> {
    const lowerText = text.toLowerCase().trim();

    // Check if this is a response to any pending approval
    for (const [, approval] of this.pendingApprovals.entries()) {
      if (approval.chatId === chatId) {
        const approved =
          lowerText === 'yes' || lowerText === 'y' || lowerText === 'approve';
        const rejected =
          lowerText === 'no' || lowerText === 'n' || lowerText === 'reject';

        if (approved || rejected) {
          approval.resolve(approved);

          // Send confirmation
          const response = approved
            ? '✅ Approved. Executing...'
            : '❌ Rejected.';
          await this.sendMessage(chatId, response, approval.threadId);

          return true;
        }
        break; // Only check first matching approval for this chatId
      }
    }

    return false;
  }

  // ── Disconnect ─────────────────────────────────────────────────────

  disconnect(): void {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval);
      this.pollingInterval = null;
    }

    for (const interval of this.typingIntervals.values()) {
      clearInterval(interval);
    }
    this.typingIntervals.clear();

    // Reject all pending approvals
    for (const [, approval] of this.pendingApprovals.entries()) {
      approval.resolve(false);
    }
    this.pendingApprovals.clear();

    process.stderr.write(`[ChannelTime:${this.name}] Disconnected\n`);
  }
}
