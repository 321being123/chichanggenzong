require('dotenv').config();

const { runJobByCode } = require('./jobRunners');
const { sanitizeJobError } = require('./jobErrorSanitizer');

function send(message) {
  if (typeof process.send === 'function') process.send(message, () => process.exit(message.ok ? 0 : 1));
  else process.exit(message.ok ? 0 : 1);
}

process.on('message', async message => {
  try {
    const result = await runJobByCode(message.jobCode, message.reason, message.businessDate, message.context || {});
    send({ ok: true, result });
  } catch (error) {
    send({ ok: false, error: sanitizeJobError(error && error.message || error) });
  }
});
