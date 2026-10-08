-- READ-ONLY. How many carriers lookup_carrier mislabels today. Paste into the Supabase SQL editor
-- (project cgdzbcsvbmbrdzgsjitw). Nothing here writes.
--
-- The bug: lookup_carrier prints "Authorized to operate" whenever QCMobile's allowedToOperate = 'Y'.
-- That means no out-of-service order and an active USDOT number. It says nothing about for-hire MC authority.
-- So the label is wrong for every carrier whose USDOT number is active, that has no OOS order, and whose MC
-- authority is inactive (revoked) or never granted except as a broker.
--
-- Source for authority here is the hub's mirror of FMCSA L&I (fmcsa_authority_current, refreshed
-- mid-2026). Live QCMobile is the truth, so these are estimates. On 2026-10-08 they returned:
--   likely_mislabeled_revoked          106,342
--   likely_mislabeled_broker_only       19,902

with lni as (
  select ltrim(f.dot_number, '0') as dot,
         bool_or(f.common_stat = 'A' or f.contract_stat = 'A') as has_carrier_auth,
         bool_or(f.common_stat = 'I' or f.contract_stat = 'I') as has_inactive_carrier_auth,
         bool_or(f.broker_stat = 'A') as broker_active,
         max(f.fetched_at) as lni_as_of
  from fmcsa_authority_current f
  group by 1
)
select
  -- "Authorized to operate" printed, but MC authority is inactive (revoked or not reinstated)
  count(*) filter (where not l.has_carrier_auth and l.has_inactive_carrier_auth and c.status_code = 'A'
                   and not exists (select 1 from oos_orders o where o.dot_number = l.dot and o.status = 'ACTIVE'))
    as likely_mislabeled_revoked,
  -- "Authorized to operate" printed for a broker with no carrier authority
  count(*) filter (where not l.has_carrier_auth and l.broker_active and c.status_code = 'A'
                   and not exists (select 1 from oos_orders o where o.dot_number = l.dot and o.status = 'ACTIVE'))
    as likely_mislabeled_broker_only,
  min(l.lni_as_of) as oldest_lni_row,
  max(l.lni_as_of) as newest_lni_row
from lni l
join fmcsa_census_current c on c.dot_number = l.dot;

-- Optional: the ones revoked in 2026 (most likely to be looked up right now).
-- select r.dot_number, r.mc_number, r.order2_effective_date, c.legal_name, c.power_units
-- from revocations r join fmcsa_census_current c on c.dot_number = r.dot_number
-- where r.order2_effective_date like '%/2026' and c.status_code = 'A'
-- order by to_date(r.order2_effective_date, 'MM/DD/YYYY') desc
-- limit 100;
