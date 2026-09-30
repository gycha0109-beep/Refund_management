alter function public.rb_ingest_refund(jsonb)
  set search_path = public, pg_temp;

alter function public.rb_list_actions(text, boolean, integer)
  set search_path = public, pg_temp;

alter function public.rb_claim_action(text, text, integer)
  set search_path = public, pg_temp;

alter function public.rb_complete_action(text, text)
  set search_path = public, pg_temp;

alter function public.rb_fail_action(text, text, text)
  set search_path = public, pg_temp;

alter function public.rb_ignore_action(text, text)
  set search_path = public, pg_temp;

alter function public.rb_retry_action(text)
  set search_path = public, pg_temp;

revoke all on table public.refunds from public, anon, authenticated;
revoke all on table public.refund_actions from public, anon, authenticated;

grant select, insert, update, delete on table public.refunds to service_role;
grant select, insert, update, delete on table public.refund_actions to service_role;

revoke execute on function public.rb_ingest_refund(jsonb) from public, anon, authenticated;
revoke execute on function public.rb_list_actions(text, boolean, integer) from public, anon, authenticated;
revoke execute on function public.rb_claim_action(text, text, integer) from public, anon, authenticated;
revoke execute on function public.rb_complete_action(text, text) from public, anon, authenticated;
revoke execute on function public.rb_fail_action(text, text, text) from public, anon, authenticated;
revoke execute on function public.rb_ignore_action(text, text) from public, anon, authenticated;
revoke execute on function public.rb_retry_action(text) from public, anon, authenticated;

grant execute on function public.rb_ingest_refund(jsonb) to service_role;
grant execute on function public.rb_list_actions(text, boolean, integer) to service_role;
grant execute on function public.rb_claim_action(text, text, integer) to service_role;
grant execute on function public.rb_complete_action(text, text) to service_role;
grant execute on function public.rb_fail_action(text, text, text) to service_role;
grant execute on function public.rb_ignore_action(text, text) to service_role;
grant execute on function public.rb_retry_action(text) to service_role;
