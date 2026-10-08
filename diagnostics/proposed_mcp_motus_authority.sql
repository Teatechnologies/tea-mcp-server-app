-- APPLIED 2026-10-08 (Rob ran it in the SQL editor). Part 2 of the lookup_carrier authority fix.
-- Read-only RPC the MCP Worker calls through the tea-mcp-rpc gateway to show FMCSA's Motus registry
-- (hub mirror: motus.operating_authority) on its own line. It never decides the authority verdict:
-- since the 2026-05-14 migration, Motus conflicts with SAFER/MCMIS/QCMobile in many cases.
-- If this RPC is missing, the Worker shows "Motus Registry: Not checked" and everything else still works.
--
-- Codes, per authority family:
--   A = at least one Active authority of that kind
--   I = none active, at least one Inactive or Withdrawn
--   N = only Pending rows
--   null = no row of that kind
-- Motus doesn't split common and contract, so motor-carrier rows report as "common".

create or replace function public.mcp_motus_authority(p_dot text)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with oa as (
    select docket_number, op_auth_type, op_auth_status
    from motus.operating_authority
    where usdot_number = ltrim(regexp_replace(coalesce(p_dot, ''), '\D', '', 'g'), '0')
  )
  select jsonb_build_object(
    'common', (select case when bool_or(op_auth_status = 'Active') then 'A'
                           when bool_or(op_auth_status in ('Inactive', 'Withdrawn')) then 'I'
                           when count(*) > 0 then 'N' end
               from oa where op_auth_type ilike 'Motor Carrier%'),
    'contract', null,
    'broker', (select case when bool_or(op_auth_status = 'Active') then 'A'
                           when bool_or(op_auth_status in ('Inactive', 'Withdrawn')) then 'I'
                           when count(*) > 0 then 'N' end
               from oa where op_auth_type ilike 'Broker%'),
    'dockets', coalesce((select jsonb_agg(distinct docket_number) from oa), '[]'::jsonb),
    'source', 'FMCSA Motus registry (hub mirror); shown separately, not used for authority status'
  );
$$;

-- Gateway-only: the tea-mcp-rpc edge function calls it with the service role.
revoke all on function public.mcp_motus_authority(text) from public, anon, authenticated;

-- Gateway allowlist change (dot-detective, supabase/functions/tea-mcp-rpc/index.ts), one line in ALLOWED_RPCS:
--
--      mcp_lookup_carrier_cached: ["p_dot"],
--   +  mcp_motus_authority: ["p_dot"],
--
-- Deploy order: run this SQL, deploy tea-mcp-rpc, then deploy the Worker.
