/**
 * The Clicker Game! - password reset mailer
 * A STANDALONE Google Apps Script (NOT attached to a Sheet).
 * It sends a password-reset email from the owner's Gmail when the game's
 * server (the Supabase "reset" edge function) asks it to.
 *
 * This file is kept in the repo for reference. The live copy runs at
 * script.google.com. The real SECRET is NOT stored here (public repo):
 * set it in the live script and in the reset function's MAILER_SECRET.
 *
 * SETUP (once):
 *   1. script.google.com > New project. Paste this whole file in.
 *   2. Change SECRET below to a long random string (40+ characters).
 *   3. Deploy > New deployment > type: Web app.
 *        Execute as:      Me
 *        Who has access:  Anyone
 *   4. Deploy, then click Allow when Google asks about sending email.
 *   5. Copy the Web app URL. In Supabase > Edge Functions > Secrets, set:
 *        MAILER_URL     = that web app URL
 *        MAILER_SECRET  = the same SECRET you used here
 *   The "reset" edge function (supabase/functions/reset/index.ts) calls this.
 *
 * Gmail sends about 100 reset emails per day on a normal account.
 */

// Shared secret. Must match MAILER_SECRET in the reset edge function.
// Replace this placeholder with your own long random string.
const SECRET = "CHANGE-ME-to-a-long-random-string";

// The name shown as the email sender.
const SENDER_NAME = "The Clicker Game!";

// The game's server POSTs here to send one reset email.
function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);

    // Only the game's server knows the secret. No secret, no email.
    if (body.secret !== SECRET) {
      return json({ ok: false, error: "forbidden" });
    }

    const to = String(body.to || "").trim();
    const code = String(body.code || "").trim();
    const username = String(body.username || "there").trim();

    // Simple checks so we never send junk.
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) return json({ ok: false, error: "bademail" });
    if (!/^[A-Z0-9]{4,10}$/.test(code))         return json({ ok: false, error: "badcode" });

    const subject = "Your Clicker Game password reset code";
    const text =
      "Hi " + username + ",\n\n" +
      "Here is your password reset code for The Clicker Game!:\n\n" +
      "    " + code + "\n\n" +
      "Type it into the game to set a new password. The code lasts 15 minutes.\n" +
      "If you did not ask for this, you can ignore this email.\n";

    MailApp.sendEmail({ to: to, name: SENDER_NAME, subject: subject, body: text });

    return json({ ok: true });
  } catch (err) {
    return json({ ok: false, error: "server" });
  }
}

// Stops people from poking at the URL in a browser.
function doGet() {
  return json({ ok: true, about: "The Clicker Game! reset mailer. It only answers POST." });
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
