// Owner-scoped row-level security: an authenticated user may only SELECT rows
// whose `owner` matches their JWT subject (auth.uid()). Exercised for real
// enforcement (not just DDL creation) by supabase_rls.spec.ts.
rlsPolicy({
  table: "documents",
  name: "owner_can_select",
  command: "SELECT",
  roles: ["authenticated"],
  using: "owner = auth.uid()"
});
