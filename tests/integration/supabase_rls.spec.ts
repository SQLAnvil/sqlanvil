import { expect } from "chai";
import * as pg from "pg";

import * as dfapi from "sa/cli/api";
import * as dbadapters from "sa/cli/api/dbadapters";
import { SupabaseDbAdapter } from "sa/cli/api/dbadapters/supabase";
import { sqlanvil } from "sa/protos/ts";
import { suite, test } from "sa/testing";
import { compile } from "sa/tests/integration/utils";
import { SupabaseFixture } from "sa/tools/supabase/supabase_fixture";

const SCHEMA = "sa_integration_test";
const OWNER_A = "00000000-0000-0000-0000-00000000000a";
const OWNER_B = "00000000-0000-0000-0000-00000000000b";

// Unlike supabase.spec.ts (which only asserts the RLS policy action runs), this
// spec asserts the policy is actually ENFORCED: an `authenticated` user querying
// the table sees only their own rows. It seeds the minimal Supabase auth
// primitives (roles + auth.uid()) idempotently, so it works against both the
// bare-Postgres test container and a real `supabase start` stack (where these
// already exist).
suite("@sqlanvil/integration/supabase-rls", { parallel: true }, ({ before, after }) => {
  let dbadapter: dbadapters.IDbAdapter;

  // tslint:disable-next-line:no-unused-expression
  new SupabaseFixture(5434, before, after);

  before("seed supabase auth primitives", async () => {
    dbadapter = await SupabaseDbAdapter.create(
      {
        host: SupabaseFixture.host,
        port: SupabaseFixture.port,
        database: SupabaseFixture.database,
        user: SupabaseFixture.user,
        password: SupabaseFixture.password
      },
      { disableSslForTestsOnly: true }
    );

    await dbadapter.execute(`drop schema if exists "${SCHEMA}" cascade`).catch(() => undefined);

    // Roles (idempotent — present already on a real Supabase stack).
    await dbadapter.execute(`
      do $$ begin
        if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
        if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
      end $$;
    `);

    // auth schema + auth.uid(). Only create auth.uid() if missing so we never
    // clobber a real Supabase implementation.
    await dbadapter.execute(`create schema if not exists auth`);
    await dbadapter.execute(`grant usage on schema auth to authenticated, anon`);
    await dbadapter.execute(`
      do $$ begin
        if not exists (
          select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'auth' and p.proname = 'uid'
        ) then
          create function auth.uid() returns uuid language sql stable as $f$
            select coalesce(
              nullif(current_setting('request.jwt.claim.sub', true), ''),
              (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
            )::uuid
          $f$;
        end if;
      end $$;
    `);
  });

  test("RLS policy enforces row visibility by auth.uid()", { timeout: 60000 }, async () => {
    // Compile + run the project: creates the documents table, enables RLS, and
    // creates the owner_can_select policy via SQLAnvil's rlsPolicy action.
    const compiledGraph = await compile("tests/integration/supabase_rls_project", "");
    const executionGraph = await dfapi.build(compiledGraph, {}, dbadapter);
    const executedGraph = await dfapi.run(dbadapter, executionGraph).result();

    expect(executedGraph.status).equals(
      sqlanvil.RunResult.ExecutionStatus.SUCCESSFUL,
      executedGraph.actions
        .map(action => action.tasks.map(task => task.errorMessage).filter(Boolean).join("\n"))
        .filter(Boolean)
        .join("\n")
    );

    // Let the authenticated role reach the table at all; RLS then governs rows.
    await dbadapter.execute(`grant usage on schema "${SCHEMA}" to authenticated`);
    await dbadapter.execute(`grant select on "${SCHEMA}"."documents" to authenticated`);

    // Baseline: the owner/superuser connection bypasses RLS and sees both rows.
    const adminRows = await dbadapter.execute(`select owner from "${SCHEMA}"."documents"`);
    expect(adminRows.rows.length).equals(2, "admin (RLS-bypassing) should see all rows");

    // Enforcement: a single transaction, dropped to the authenticated role with a
    // JWT subject of OWNER_A, must see ONLY OWNER_A's row. (A raw client is needed
    // because the adapter pools connections, so SET LOCAL wouldn't persist.)
    const client = new pg.Client({
      host: SupabaseFixture.host,
      port: SupabaseFixture.port,
      database: SupabaseFixture.database,
      user: SupabaseFixture.user,
      password: SupabaseFixture.password,
      ssl: false
    });
    await client.connect();
    try {
      await client.query("begin");
      await client.query(`set local request.jwt.claims = '{"sub":"${OWNER_A}","role":"authenticated"}'`);
      await client.query("set local role authenticated");
      const res = await client.query(`select owner::text as owner from "${SCHEMA}"."documents"`);
      await client.query("rollback");

      expect(res.rows.length).equals(1, "authenticated user must see only their own row");
      expect(res.rows[0].owner).equals(OWNER_A);
      expect(res.rows.some((r: { owner: string }) => r.owner === OWNER_B)).equals(
        false,
        "authenticated user must NOT see another owner's row"
      );
    } finally {
      await client.end();
    }
  });
});
