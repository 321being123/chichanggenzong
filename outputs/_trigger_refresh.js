require('/opt/portfolio/node_modules/dotenv').config({ path: '/opt/portfolio/.env' });
const { refreshBondSafety } = require('/opt/portfolio/server/services/bondSafetyService');
refreshBondSafety('manual_cli').then(function(r) {
  console.log('SUCCESS rows:', r.snapshot && r.snapshot.row_count);
  process.exit(0);
}).catch(function(e) {
  console.error('ERROR', e.message);
  process.exit(1);
});
