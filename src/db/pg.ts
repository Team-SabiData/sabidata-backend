import pg from 'pg';
import { type SqlDb } from './sql';

// Sous-ensemble de pg.Pool utilisé (injectable en test).
export interface MinimalPool {
  query(sql: string, params?: unknown[]): Promise<{ rows: unknown[] }>;
  end(): Promise<void>;
}

// Adapte un Pool `pg` à l'interface SqlDb (le générique de Pool.query est
// contraint à QueryResultRow, d'où l'adaptation plutôt qu'un usage direct).
export function wrapPool(pool: MinimalPool): SqlDb & { end(): Promise<void> } {
  return {
    async query<T>(sql: string, params?: unknown[]) {
      const r = await pool.query(sql, params);
      return { rows: r.rows as T[] };
    },
    // Sans paramètres, `pg` passe en protocole simple → multi-instructions OK.
    async exec(sql: string) {
      return pool.query(sql);
    },
    end: () => pool.end(),
  };
}

// Connexion Postgres managé (Neon, etc.) via DATABASE_URL.
// Neon exige TLS : garder `?sslmode=require` dans l'URL.
export function createPgDb(connectionString: string): SqlDb & { end(): Promise<void> } {
  return wrapPool(new pg.Pool({ connectionString, max: 5 }));
}
