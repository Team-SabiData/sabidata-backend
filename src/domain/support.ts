export type ConversationStatus = 'open' | 'closed';
export type ChatSenderRole = 'user' | 'staff';

/** Fil de support : une seule conversation ouverte par utilisateur. */
export interface Conversation {
  id: string;
  userId: string;
  clipId?: string;
  subject?: string;
  status: ConversationStatus;
  createdAt: Date;
  updatedAt: Date;
  closedAt?: Date;
  lastMessageAt?: Date;
  userLastReadAt?: Date;
  staffLastReadAt?: Date;
}

export interface ChatMessage {
  id: string;
  conversationId: string;
  senderId: string;
  senderRole: ChatSenderRole;
  body: string;
  createdAt: Date;
}
