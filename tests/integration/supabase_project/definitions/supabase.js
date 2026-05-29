rlsPolicy({
  table: "users",
  name: "select_policy",
  command: "SELECT",
  roles: ["authenticated"],
  using: "true"
});

realtimePublication({
  table: "users",
  name: "supabase_realtime"
});
