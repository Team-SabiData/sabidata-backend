import { type Principal, requirePermission } from '../authz/can';
import { type ChatMessage, type Conversation, type ConversationStatus } from '../domain/support';
import { badRequest, conflict, notFound } from '../errors';
import { type Repo } from '../ports/repo';

const MAX_BODY = 4000;
const MAX_SUBJECT = 200;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface MessagePage {
  after?: string;
  before?: string;
  limit?: number;
}

export interface ConversationPage {
  status?: ConversationStatus;
  page?: number;
  limit?: number;
}

export class SupportService {
  constructor(private readonly repo: Repo) {}

  /** Ouvre (ou retrouve) l'unique conversation ouverte de l'utilisateur. */
  async openConversation(
    p: Principal,
    input: { clipId?: string; subject?: string },
  ): Promise<Conversation> {
    const existing = await this.repo.findOpenConversation(p.userId);
    if (existing) {
      if (input.clipId && !existing.clipId) {
        return (await this.repo.updateConversation(existing.id, { clipId: input.clipId })) ?? existing;
      }
      return existing;
    }

    if (input.clipId) {
      const clip = await this.repo.getClip(input.clipId);
      if (!clip) throw notFound('clip');
      if (clip.contributorId !== p.userId) throw notFound('clip');
    }
    const subject = input.subject?.trim();
    if (subject && subject.length > MAX_SUBJECT) throw badRequest('BAD_SUBJECT');

    try {
      const created = await this.repo.createConversation({
        userId: p.userId,
        clipId: input.clipId,
        subject: subject || undefined,
      });
      await this.repo.addAudit({
        actorId: p.userId, action: 'support.open', entityType: 'conversation',
        entityId: created.id, reason: '', metadata: { by: p.role, clipId: input.clipId ?? null },
      });
      return created;
    } catch (e) {
      // Course entre deux ouvertures : l'index partiel n'autorise qu'une
      // conversation ouverte → on renvoie celle qui vient de gagner.
      const open = await this.repo.findOpenConversation(p.userId);
      if (open) return open;
      throw e;
    }
  }

  async getCurrent(
    p: Principal,
  ): Promise<{ conversation: Conversation | null; messages: ChatMessage[]; unread: number }> {
    const conversation = await this.repo.findOpenConversation(p.userId);
    if (!conversation) return { conversation: null, messages: [], unread: 0 };
    return {
      conversation,
      messages: await this.repo.listChatMessages(conversation.id, { limit: DEFAULT_LIMIT }),
      unread: await this.unreadFor(conversation, 'user'),
    };
  }

  async listMessages(p: Principal, conversationId: string, page: MessagePage = {}): Promise<ChatMessage[]> {
    const conversation = await this.ownConversation(p, conversationId);
    return this.repo.listChatMessages(conversation.id, {
      after: this.parseDate(page.after, 'BAD_AFTER'),
      before: this.parseDate(page.before, 'BAD_BEFORE'),
      limit: this.limit(page.limit),
    });
  }

  async markRead(
    p: Principal,
    conversationId: string,
  ): Promise<{ conversation: Conversation; unread: number }> {
    const conversation = await this.ownConversation(p, conversationId);
    const updated = await this.repo.updateConversation(conversation.id, { userLastReadAt: new Date() });
    return { conversation: updated ?? conversation, unread: 0 };
  }

  async postMessage(p: Principal, conversationId: string, body: string): Promise<ChatMessage> {
    const conversation = await this.ownConversation(p, conversationId);
    if (conversation.status !== 'open') throw conflict('CONVERSATION_CLOSED');
    const text = this.cleanBody(body);
    return this.repo.addChatMessage({
      conversationId: conversation.id,
      senderId: p.userId,
      senderRole: 'user',
      body: text,
    });
  }

  async close(p: Principal, conversationId: string): Promise<Conversation> {
    const conversation = await this.ownConversation(p, conversationId);
    if (conversation.status === 'closed') return conversation;
    const updated = await this.repo.updateConversation(conversation.id, {
      status: 'closed',
      closedAt: new Date(),
    });
    await this.repo.addAudit({
      actorId: p.userId, action: 'support.close', entityType: 'conversation', entityId: conversation.id,
      reason: '', metadata: { by: 'user' },
    });
    return updated!;
  }

  // — surface staff (admin / modérateur) —

  async listForStaff(
    p: Principal,
    page: ConversationPage = {},
  ): Promise<{
    conversations: Array<Conversation & { userName: string | null; unreadForStaff: number }>;
    page: number;
    limit: number;
  }> {
    requirePermission(p, 'support.manage');
    const limit = Math.min(page.limit ?? DEFAULT_LIMIT, 100);
    const pageNo = page.page ?? 1;
    const conversations = await this.repo.listConversations({
      status: page.status,
      limit,
      offset: (pageNo - 1) * limit,
    });
    return {
      conversations: await Promise.all(
        conversations.map(async (c) => ({
          ...c,
          userName: (await this.repo.findUserById(c.userId))?.name ?? null,
          unreadForStaff: await this.unreadFor(c, 'staff'),
        })),
      ),
      page: pageNo,
      limit,
    };
  }

  async getForStaff(
    p: Principal,
    conversationId: string,
    page: MessagePage = {},
  ): Promise<{
    conversation: Conversation & { userName: string | null };
    messages: ChatMessage[];
    unreadForStaff: number;
  }> {
    requirePermission(p, 'support.manage');
    const conversation = await this.repo.getConversation(conversationId);
    if (!conversation) throw notFound('conversation');
    return {
      conversation: {
        ...conversation,
        userName: (await this.repo.findUserById(conversation.userId))?.name ?? null,
      },
      messages: await this.repo.listChatMessages(conversation.id, {
        after: this.parseDate(page.after, 'BAD_AFTER'),
        before: this.parseDate(page.before, 'BAD_BEFORE'),
        limit: this.limit(page.limit),
      }),
      unreadForStaff: await this.unreadFor(conversation, 'staff'),
    };
  }

  async markStaffRead(
    p: Principal,
    conversationId: string,
  ): Promise<{ conversation: Conversation; unreadForStaff: number }> {
    requirePermission(p, 'support.manage');
    const conversation = await this.repo.getConversation(conversationId);
    if (!conversation) throw notFound('conversation');
    const updated = await this.repo.updateConversation(conversation.id, { staffLastReadAt: new Date() });
    return { conversation: updated ?? conversation, unreadForStaff: 0 };
  }

  async postStaffMessage(p: Principal, conversationId: string, body: string): Promise<ChatMessage> {
    requirePermission(p, 'support.manage');
    const conversation = await this.repo.getConversation(conversationId);
    if (!conversation) throw notFound('conversation');
    if (conversation.status !== 'open') throw conflict('CONVERSATION_CLOSED');
    const text = this.cleanBody(body);
    return this.repo.addChatMessage({
      conversationId: conversation.id,
      senderId: p.userId,
      senderRole: 'staff',
      body: text,
    });
  }

  async closeForStaff(p: Principal, conversationId: string): Promise<Conversation> {
    requirePermission(p, 'support.manage');
    const conversation = await this.repo.getConversation(conversationId);
    if (!conversation) throw notFound('conversation');
    if (conversation.status === 'closed') return conversation;
    const updated = await this.repo.updateConversation(conversation.id, {
      status: 'closed',
      closedAt: new Date(),
    });
    await this.repo.addAudit({
      actorId: p.userId, action: 'support.close', entityType: 'conversation', entityId: conversation.id,
      reason: '', metadata: { by: p.role },
    });
    return updated!;
  }

  /** Résumé de la conversation liée à un clip (pour /admin/disputes). */
  async summaryForClip(clipId: string): Promise<{
    conversationId: string;
    status: ConversationStatus;
    lastMessage: { body: string; senderRole: ChatMessage['senderRole']; createdAt: Date } | null;
    lastMessageAt?: Date;
    unreadForStaff: number;
  } | null> {
    const conversation = await this.repo.findConversationByClipId(clipId);
    if (!conversation) return null;
    const last = (await this.repo.listChatMessages(conversation.id, { limit: 1 }))[0] ?? null;
    return {
      conversationId: conversation.id,
      status: conversation.status,
      lastMessage: last ? { body: last.body, senderRole: last.senderRole, createdAt: last.createdAt } : null,
      lastMessageAt: conversation.lastMessageAt,
      unreadForStaff: await this.unreadFor(conversation, 'staff'),
    };
  }

  private async ownConversation(p: Principal, id: string): Promise<Conversation> {
    const conversation = await this.repo.getConversation(id);
    // Ne pas révéler l'existence d'une conversation d'un autre utilisateur.
    if (!conversation || conversation.userId !== p.userId) throw notFound('conversation');
    return conversation;
  }

  private async unreadFor(conversation: Conversation, role: 'user' | 'staff'): Promise<number> {
    const since = role === 'user' ? conversation.userLastReadAt : conversation.staffLastReadAt;
    return this.repo.countChatMessagesAfter(
      conversation.id,
      since,
      role === 'user' ? 'staff' : 'user',
    );
  }

  private cleanBody(body: string): string {
    const text = body.trim();
    if (!text || text.length > MAX_BODY) throw badRequest('BAD_MESSAGE');
    return text;
  }

  private parseDate(value: string | undefined, code: string): Date | undefined {
    if (!value) return undefined;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) throw badRequest(code);
    return d;
  }

  private limit(value: number | undefined): number {
    if (value === undefined) return DEFAULT_LIMIT;
    if (!Number.isInteger(value) || value < 1 || value > MAX_LIMIT) throw badRequest('BAD_LIMIT');
    return value;
  }
}
