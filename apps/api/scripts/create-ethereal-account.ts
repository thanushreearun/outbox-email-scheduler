/**
 * Deliberate, one-off creation of an Ethereal test mailbox.
 * The application never creates accounts implicitly on startup; run this once and paste
 * the printed values into the root .env file.
 *
 *   npm run ethereal:create
 */
import nodemailer from 'nodemailer';

const account = await nodemailer.createTestAccount();
console.log(`
Ethereal account created. Add these lines to your root .env file:

ETHEREAL_HOST=${account.smtp.host}
ETHEREAL_PORT=${account.smtp.port}
ETHEREAL_USER=${account.user}
ETHEREAL_PASS=${account.pass}

Inbox (web): https://ethereal.email/login  (sign in with the user/pass above)
Ethereal never delivers to real recipients: every message is captured in this mailbox.
`);
