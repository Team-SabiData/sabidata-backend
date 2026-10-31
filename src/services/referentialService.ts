import { type Principal, requirePermission } from '../authz/can';
import { type Repo } from '../ports/repo';
import { badRequest, conflict, notFound } from '../errors';

// Référentiel : jamais de suppression physique. Les langues passent en
// `status='inactive'`, dialectes/prompts en `active=false`. Une entité encore
// utilisée (contenu, profil, prompts/dialectes actifs) ne peut pas être
// désactivée via DELETE → 409 REFERENCE_IN_USE.
export class ReferentialService {
  constructor(private readonly repo: Repo) {}

  private text(value: unknown, field: string): string | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || !value.trim()) throw badRequest(`BAD_${field.toUpperCase()}`);
    return value.trim();
  }

  private bool(value: unknown, field: string): boolean | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'boolean') throw badRequest(`BAD_${field.toUpperCase()}`);
    return value;
  }

  private number(value: unknown, field: string): number | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw badRequest(`BAD_${field.toUpperCase()}`);
    }
    return value;
  }

  private async guardLanguage(code: string): Promise<void> {
    const refs = await this.repo.countLanguageRefs(code);
    if (refs.dialects + refs.prompts + refs.users + refs.clips > 0) {
      throw conflict('REFERENCE_IN_USE');
    }
  }

  private async guardDialect(id: string): Promise<void> {
    const refs = await this.repo.countDialectRefs(id);
    if (refs.prompts + refs.users + refs.clips > 0) throw conflict('REFERENCE_IN_USE');
  }

  private async guardPrompt(stableId: string): Promise<void> {
    const refs = await this.repo.countPromptRefs(stableId);
    if (refs.clips > 0) throw conflict('REFERENCE_IN_USE');
  }

  async updateLanguage(
    p: Principal,
    code: string,
    body: { nameFr?: unknown; isoBcp47?: unknown; active?: unknown },
  ) {
    requirePermission(p, 'reference.manage');
    const current = await this.repo.findLanguageByCode(code);
    if (!current) throw notFound('language');
    const nameFr = this.text(body.nameFr, 'name');
    const isoBcp47 = this.text(body.isoBcp47, 'iso');
    const active = this.bool(body.active, 'active');
    if (nameFr === undefined && isoBcp47 === undefined && active === undefined) {
      throw badRequest('BAD_INPUT');
    }
    if (active === false && current.status === 'active') await this.guardLanguage(code);
    const language = await this.repo.updateLanguage(code, {
      nameFr,
      isoBcp47,
      status: active === undefined ? undefined : active ? 'active' : 'inactive',
    });
    if (!language) throw notFound('language');
    await this.repo.addAudit({
      actorId: p.userId, action: 'reference.language.update', entityType: 'language',
      entityId: language.id, reason: 'update',
      metadata: { code, nameFr, isoBcp47, active },
    });
    return { language };
  }

  async deleteLanguage(p: Principal, code: string) {
    requirePermission(p, 'reference.manage');
    const current = await this.repo.findLanguageByCode(code);
    if (!current) throw notFound('language');
    if (current.status !== 'active') return { ok: true, code, active: false };
    await this.guardLanguage(code);
    const language = await this.repo.updateLanguage(code, { status: 'inactive' });
    await this.repo.addAudit({
      actorId: p.userId, action: 'reference.language.delete', entityType: 'language',
      entityId: current.id, reason: 'delete', metadata: { code },
    });
    return { ok: true, code, active: language?.status === 'active' };
  }

  async updateDialect(
    p: Principal,
    id: string,
    body: { nameFr?: unknown; zone?: unknown; targetHours?: unknown; active?: unknown },
  ) {
    requirePermission(p, 'reference.manage');
    const current = await this.repo.findDialectById(id);
    if (!current) throw notFound('dialect');
    const nameFr = this.text(body.nameFr, 'name');
    const targetHours = this.number(body.targetHours, 'target_hours');
    let zone: string | null | undefined;
    if (body.zone !== undefined) {
      if (body.zone === null) zone = null;
      else if (typeof body.zone === 'string') zone = body.zone.trim() || null;
      else throw badRequest('BAD_ZONE');
    }
    const active = this.bool(body.active, 'active');
    if (
      nameFr === undefined && zone === undefined && targetHours === undefined && active === undefined
    ) {
      throw badRequest('BAD_INPUT');
    }
    if (active === false && current.active !== false) await this.guardDialect(id);
    const dialect = await this.repo.updateDialect(id, { nameFr, zone, targetHours, active });
    if (!dialect) throw notFound('dialect');
    await this.repo.addAudit({
      actorId: p.userId, action: 'reference.dialect.update', entityType: 'dialect',
      entityId: id, reason: 'update',
      metadata: { languageCode: dialect.languageCode, code: dialect.code, nameFr, zone, targetHours, active },
    });
    return { dialect };
  }

  async deleteDialect(p: Principal, id: string) {
    requirePermission(p, 'reference.manage');
    const current = await this.repo.findDialectById(id);
    if (!current) throw notFound('dialect');
    if (current.active === false) return { ok: true, id, active: false };
    await this.guardDialect(id);
    await this.repo.updateDialect(id, { active: false });
    await this.repo.addAudit({
      actorId: p.userId, action: 'reference.dialect.delete', entityType: 'dialect',
      entityId: id, reason: 'delete',
      metadata: { languageCode: current.languageCode, code: current.code },
    });
    return { ok: true, id, active: false };
  }

  async updatePrompt(
    p: Principal,
    stableId: string,
    body: { text?: unknown; active?: unknown },
  ) {
    requirePermission(p, 'reference.manage');
    const current = await this.repo.getPromptByStableId(stableId);
    if (!current) throw notFound('prompt');
    const text = this.text(body.text, 'text');
    const active = this.bool(body.active, 'active');
    if (text === undefined && active === undefined) throw badRequest('BAD_INPUT');
    const prompt = await this.repo.updatePrompt(stableId, { text, active });
    if (!prompt) throw notFound('prompt');
    await this.repo.addAudit({
      actorId: p.userId, action: 'reference.prompt.update', entityType: 'prompt',
      entityId: stableId, reason: 'update', metadata: { text, active },
    });
    return { prompt };
  }

  async deletePrompt(p: Principal, stableId: string) {
    requirePermission(p, 'reference.manage');
    const current = await this.repo.getPromptByStableId(stableId);
    if (!current) throw notFound('prompt');
    if (current.active === false) return { ok: true, stableId, active: false };
    await this.guardPrompt(stableId);
    await this.repo.updatePrompt(stableId, { active: false });
    await this.repo.addAudit({
      actorId: p.userId, action: 'reference.prompt.delete', entityType: 'prompt',
      entityId: stableId, reason: 'delete',
    });
    return { ok: true, stableId, active: false };
  }
}
