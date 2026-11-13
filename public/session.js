// The top bar is a caller of sign-in, just like upload, review and stats.
import { browserSignIn } from './signin.js';
const auth = browserSignIn();
let revision = 0;
async function refresh() {
  const asked = ++revision;
  const lines = [...document.querySelectorAll('[data-session]')];
  for (const line of lines) {
    line.hidden = !auth.signedIn;
    line.querySelectorAll('[data-session-account]').forEach((a) => { a.hidden = !auth.session; });
  }
  if (!auth.signedIn || !lines.length) return;
  try {
    const user = await auth.identity();
    if (asked !== revision || !user) return;
    for (const line of lines) {
      line.querySelector('[data-session-as]').textContent = 'Signed in as ';
      const who = line.querySelector('[data-session-who]');
      who.textContent = user.name; who.title = `Signed in as ${user.name}`;
    }
  } catch (e) {
    if (asked !== revision || e.status !== 401) return;
    for (const line of lines) {
      const who = line.querySelector('[data-session-who]');
      who.textContent = 'Token not accepted'; who.title = 'This server no longer takes the saved token';
    }
  }
}
auth.subscribe(refresh);
document.addEventListener('click', (e) => { if (e.target.closest('[data-sign-out]')) auth.signOut(); });
refresh();
