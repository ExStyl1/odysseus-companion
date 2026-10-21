import type { Message, PersistedMessage, SessionAttachmentDto, StoredAttachment, StoredMessage } from './message.ts';

function attachmentDto(attachment: StoredAttachment): SessionAttachmentDto {
  return {
    handleId: attachment.id,
    type: attachment.type,
    name: attachment.name,
    mimeType: attachment.mimeType,
    size: attachment.size,
    ...(attachment.thumbnailBase64
      ? { previewUrl: `data:image/png;base64,${attachment.thumbnailBase64}` }
      : {}),
  };
}

/**
 * Convert runtime Message to StoredMessage for persistence.
 *
 * Excludes transient runtime-only fields:
 * - isStreaming
 * - isPending
 */
export function messageToStored(msg: PersistedMessage): StoredMessage {
  const { role, isStreaming, isPending, ...rest } = msg;
  return { ...rest, type: role } as StoredMessage;
}

/**
 * Convert StoredMessage to runtime Message.
 *
 * Adds a timestamp fallback for legacy messages where timestamp was omitted.
 */
export function storedToMessage(stored: StoredMessage): Message {
  const { type, attachments, planPath, ...rest } = stored;
  return {
    ...rest,
    role: type,
    timestamp: stored.timestamp ?? Date.now(),
    ...(attachments ? { attachments: attachments.map(attachmentDto) } : {}),
    ...(planPath ? { planHandleId: stored.id, planName: planPath.split(/[\\/]/).pop() ?? 'plan.md' } : {}),
  } as Message;
}

/** Restore the backend-only persisted shape for the session runtime. */
export function storedToPersistedMessage(stored: StoredMessage): PersistedMessage {
  const { type, ...rest } = stored;
  return { ...rest, role: type, timestamp: stored.timestamp ?? Date.now() } as PersistedMessage;
}
