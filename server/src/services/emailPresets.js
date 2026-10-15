// Ready-made email bodies. The Template editor's "Insert Genius appointment
// email" button pulls them from GET /api/templates/presets, and the boot
// migration (scripts/seedBoot.js) uses the Genius one to update the old
// copy of that email in place.

const GENIUS_CALENDLY_URL = 'https://calendly.com/mariyama-treasurehill/treasure-hill-genius';

const LINK = 'color:#0000EE;text-decoration:underline;';
const P = 'margin:0 0 14px;';

function escapeAttr(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// The Treasure Hill Genius appointment request, laid out like a plain
// letter: left-aligned paragraphs, simple bullet lists, every link blue.
// {{buyer.name}} names everyone the email is addressed to ("Jane Doe and
// John Smith" when the co-buyer is CC'd), so the greeting always reads
// "Dear …," with one comma.
function geniusAppointmentHtml({ calendlyUrl = GENIUS_CALENDLY_URL } = {}) {
  const cal = escapeAttr(calendlyUrl || GENIUS_CALENDLY_URL);
  return `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#000000;">
<p style="${P}">Dear {{buyer.name}},</p>
<p style="${P}">We hope this message finds you well.</p>
<p style="${P}">At Treasure Hill Genius, we specialize in home automation that makes your life easier and more comfortable. Our solutions range from automated blinds and security cameras to integrated audio-visual systems and enhanced Wi-Fi coverage. As we move forward with your home's setup, there are several key decisions that need to be made.</p>
<p style="${P}"><strong>IMPORTANT NOTICE FOR HOMEOWNERS:</strong> As the owner of Lot # {{lot.number}}, scheduling a <strong>MANDATORY</strong> appointment with us is crucial.</p>
<p style="margin:0 0 6px;">In this meeting, we'll discuss:</p>
<ul style="margin:0 0 14px;padding-left:24px;">
<li>Your Complimentary Genius package and its features</li>
<li>The latest in smart home technologies</li>
<li>Internet wires and other IT infrastructure selections for your home</li>
<li>How to automate life in your luxurious home</li>
</ul>
<p style="${P}">Making the right decisions now, especially about where wires and IT components will be placed, is essential before the walls are completed. Proper planning ensures the best use and seamless integration of our technology into your home.</p>
<p style="${P}">Our team is here to guide you every step of the way, ensuring that your home is future ready.</p>
<p style="${P}"><a href="${cal}" target="_blank" style="${LINK}"><strong>SCHEDULE YOUR APPOINTMENT HERE</strong></a></p>
<p style="${P}">Please note that this meeting is a requirement for all homeowners. If you're unable to attend in person, please inform us as soon as possible so we can make alternative arrangements.</p>
<p style="margin:0 0 6px;">Curious about our home automation services? Here are some features we offer:</p>
<ul style="margin:0 0 14px;padding-left:24px;">
<li>Central vacuum systems</li>
<li>Networking infrastructure</li>
<li>Automated blinds</li>
<li>Security camera setups</li>
<li>Alarm systems</li>
<li>Audio-visual integration</li>
<li>EV chargers</li>
<li>Extended Wi-Fi coverage</li>
</ul>
<p style="${P}">For a detailed look at our offerings, visit: <a href="https://treasurehillgenius.com" target="_blank" style="${LINK}">https://treasurehillgenius.com</a></p>
<p style="${P}">If you have any questions or need assistance, reply to this email, contact <a href="mailto:Genius@treasurehill.com" style="${LINK}">Genius@treasurehill.com</a>, or call us at <a href="tel:+14165614327" style="${LINK}">+1-416-561-4327</a>. We're excited to work with you on your smart home journey!</p>
<p style="${P}">Regards,</p>
<p style="margin:0;">Mariyam Amir<br>
Genius Representative<br>
TREASURE HILL<br>
Tel: 416 561 4327<br>
1681 Langstaff Road, Vaughan, Ontario<br>
<a href="mailto:mariyama@treasurehill.com" style="${LINK}">mariyama@treasurehill.com</a> | <a href="https://www.treasurehill.com" target="_blank" style="${LINK}">www.treasurehill.com</a></p>
</div>`;
}

const PRESETS = [
  {
    key: 'genius-appointment',
    name: 'Genius appointment email',
    description: 'Treasure Hill Genius appointment request: mandatory meeting, features list, Calendly link, signature.',
    bodyHtml: geniusAppointmentHtml(),
  },
];

const WS = '(?:\\s|&nbsp;|&#160;)+';
const words = (phrase) => new RegExp(phrase.split(' ').join(WS), 'i');
const LEGACY_MARKERS = [
  words('Window security films'),
  words('Curious about our home automation services'),
  words('Mariyam Amir'),
  /treasurehillgenius\.com/i,
];

// The old version of the Genius email: it still lists window security films
// and carries the rest of that email's tell-tale text. Only this email is
// ever rewritten by the migration; any other template is left alone.
function isLegacyGeniusEmail(html) {
  const s = String(html || '');
  return LEGACY_MARKERS.every((re) => re.test(s));
}

// Keep the Calendly link the old copy pointed at (it may differ per template).
function extractCalendlyUrl(html) {
  const m = String(html || '').match(/href\s*=\s*["'](https?:\/\/(?:www\.)?calendly\.com\/[^"']+)["']/i);
  return m ? m[1].replace(/&amp;/g, '&') : '';
}

module.exports = { GENIUS_CALENDLY_URL, PRESETS, geniusAppointmentHtml, isLegacyGeniusEmail, extractCalendlyUrl };
