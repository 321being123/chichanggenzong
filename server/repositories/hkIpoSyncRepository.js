'use strict';

function syncHkIpoTencentNamesLayerQuery1(executor, parts, ...args) { return executor(`
    SELECT security_code
      FROM public.ipo_history
     WHERE market_code='HK'
       AND COALESCE(NULLIF(security_name_cn,''),'') !~ $1
     ORDER BY CASE WHEN listing_at IS NOT NULL OR ipo_status='listed' THEN 0 ELSE 1 END,
              COALESCE(listing_at,NULLIF(updated_at,'')::timestamptz) DESC NULLS LAST,security_code
     ${parts[0]}`, ...args); }

module.exports = {
  syncHkIpoTencentNamesLayerQuery1, };
