import crypto from 'crypto';
import { generateReportPDF } from './monday.js';

// Dedupe: only send one email per same report (same email + content) within this window
const DEDUPE_WINDOW_MS = 2 * 60 * 1000; // 2 minutes
const sentFingerprints = new Map(); // fingerprint -> expiry time

// Fingerprint ignores adres/gemeente so two requests (e.g. one with city, one with full address) count as the same report → one email
function fingerprint(payload) {
  const { email, naam, jaar1Total, jaar2Total, scenarios } = payload;
  return crypto.createHash('sha256').update(JSON.stringify({ email, naam, jaar1Total, jaar2Total, scenarios })).digest('hex');
}

function wasRecentlySent(fp) {
  const expiry = sentFingerprints.get(fp);
  if (!expiry) return false;
  if (Date.now() > expiry) {
    sentFingerprints.delete(fp);
    return false;
  }
  return true;
}

export async function sendReportToLead(resendKey, payload) {
  if (!resendKey) { console.log('RESEND_API_KEY not set — skipping lead email'); return; }

  const { naam, email, adres, gemeente, type, kamers, slaapplaatsen, scenarios, jaar1Total, jaar2Total, reportDate } = payload;
  if (!email) { console.log('No email address — skipping lead email'); return; }

  const fp = fingerprint(payload);
  if (wasRecentlySent(fp)) {
    console.log('Lead email skipped (duplicate request):', email);
    return;
  }
  sentFingerprints.set(fp, Date.now() + DEDUPE_WINDOW_MS);

  const voornaam = naam?.split(' ')[0] || 'eigenaar';
  const type_info = [type, kamers ? `${kamers} slaapkamer${kamers > 1 ? 's' : ''}` : null, slaapplaatsen ? `${slaapplaatsen} slaapplaatsen` : null].filter(Boolean).join(' · ');
  // Extract strategy text from payload if AI provided it
  const prijsStrategie = payload.prijsStrategie || 'Op basis van de marktanalyse positioneren wij dit pand optimaal voor maximale bezetting en omzet.';
  const minPrijs = scenarios?.realistisch?.adr ? Math.round(scenarios.realistisch.adr * 0.7) : '—';
  const hoogseizoen = payload.hoogseizoen || 'juli–augustus';
  const fase1 = `Conservatieve pricing om momentum op te bouwen. Verwachte omzet: €${scenarios?.conservatief?.maand?.toLocaleString('nl-BE') || '—'}/maand`;
  const fase2 = `Optimalisatie voor seizoenspieken, uitbreiden naar internationale gasten. Verwachte omzet: €${scenarios?.realistisch?.maand?.toLocaleString('nl-BE') || '—'}/maand`;
  const fase3 = `Premium positionering en dynamische pricing op basis van marktdata. Verwachte omzet: €${scenarios?.optimaal?.maand?.toLocaleString('nl-BE') || '—'}/maand`;
  const locatie = [adres, gemeente].filter(Boolean).join(', ') || 'uw eigendom';
  const realistisch = scenarios?.realistisch?.maand?.toLocaleString('nl-BE') || '—';
  const jaar1 = jaar1Total ? Number(jaar1Total).toLocaleString('nl-BE') : '—';
  const datum = reportDate || new Date().toLocaleDateString('nl-BE');

  const html = `<!DOCTYPE html>\n<html lang="nl">\n<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">\n<link href="https://fonts.googleapis.com/css2?family=Crimson+Pro:ital,wght@0,400;0,600;0,700;1,400&family=Inter:wght@400;500;600&display=swap" rel="stylesheet"></head>\n<body style="margin:0;padding:0;background:#f0efeb;font-family:'Inter',Arial,sans-serif;">\n  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f0efeb;padding:48px 0;">\n    <tr><td align="center">\n      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.07);">\n        <tr><td style="padding:40px 48px 12px;">\n          <p style="margin:0 0 6px;font-family:'Crimson Pro',Georgia,serif;font-size:26px;font-weight:700;color:#111;letter-spacing:-0.3px;">Uw rapport is klaar</p>\n          <p style="margin:0 0 28px;font-size:14px;color:#888;line-height:1.6;">Bedankt voor uw aanvraag, ${voornaam}. U vindt uw persoonlijk rentabiliteitsrapport in bijlage.</p>\n          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f7f5;border-radius:10px;margin:0 0 28px;">\n            <tr><td style="padding:18px 22px;">\n              <p style="margin:0 0 4px;font-family:'Crimson Pro',Georgia,serif;font-size:16px;font-weight:700;color:#111;">${locatie}</p>\n              <p style="margin:0;font-size:13px;color:#888;">${type_info}</p>\n            </td></tr>\n          </table>\n          <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 32px;border:1px solid #efefef;border-radius:10px;overflow:hidden;">\n            <tr style="background:#fafafa;">\n              <td style="padding:12px 20px;font-size:11px;font-weight:600;color:#aaa;letter-spacing:0.6px;border-bottom:1px solid #efefef;">REALISTISCH SCENARIO</td>\n              <td style="padding:12px 20px;font-size:11px;font-weight:600;color:#aaa;letter-spacing:0.6px;border-bottom:1px solid #efefef;text-align:right;">PER MAAND</td>\n            </tr>\n            <tr>\n              <td style="padding:16px 20px;font-size:14px;color:#444;">Verwachte maandomzet</td>\n              <td style="padding:16px 20px;font-family:'Crimson Pro',Georgia,serif;font-size:22px;color:#111;font-weight:700;text-align:right;">&#8364;${realistisch}</td>\n            </tr>\n            <tr style="background:#fafafa;">\n              <td style="padding:14px 20px;font-size:14px;color:#444;border-top:1px solid #efefef;">Jaar 1 prognose</td>\n              <td style="padding:14px 20px;font-family:'Crimson Pro',Georgia,serif;font-size:18px;color:#111;font-weight:600;text-align:right;border-top:1px solid #efefef;">&#8364;${jaar1}</td>\n            </tr>\n          </table>\n          <p style="margin:0 0 8px;font-family:'Crimson Pro',Georgia,serif;font-size:19px;font-weight:700;color:#111;">Prijsstrategie</p>\n          <p style="margin:0 0 14px;font-size:13px;color:#555;line-height:1.7;">${prijsStrategie}</p>\n          <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 28px;">\n            <tr><td style="padding:5px 0 5px 10px;font-size:13px;color:#444;line-height:1.6;"><span style="color:#bbb;">&#9702;</span> <strong style="color:#111;">Minimumprijs:</strong> &#8364;${minPrijs}</td></tr>\n            <tr><td style="padding:5px 0 5px 10px;font-size:13px;color:#444;"><span style="color:#bbb;">&#9702;</span> <strong style="color:#111;">Weekendopslag:</strong> 25%</td></tr>\n            <tr><td style="padding:5px 0 5px 10px;font-size:13px;color:#444;"><span style="color:#bbb;">&#9702;</span> <strong style="color:#111;">Hoogseizoen:</strong> ${hoogseizoen}</td></tr>\n            <tr><td style="padding:5px 0 5px 10px;font-size:13px;color:#444;"><span style="color:#bbb;">&#9702;</span> <strong style="color:#111;">Last-minute:</strong> 15% korting vanaf 7 dagen voor aankomst</td></tr>\n          </table>\n          <p style="margin:0 0 12px;font-family:'Crimson Pro',Georgia,serif;font-size:19px;font-weight:700;color:#111;">Groeistrategie</p>\n          <table width="100%" cellpadding="0" cellspacing="0" style="margin:0 0 32px;">\n            <tr><td style="padding:10px 16px;background:#f7f7f5;border-radius:8px;font-size:13px;color:#444;line-height:1.65;border-left:3px solid #ddd;"><strong style="color:#111;display:block;margin-bottom:3px;">Fase 1 (Maand 1&ndash;3) &mdash; Opbouw</strong>${fase1}</td></tr>\n            <tr><td style="padding:4px 0;font-size:1px;">&nbsp;</td></tr>\n            <tr><td style="padding:10px 16px;background:#f7f7f5;border-radius:8px;font-size:13px;color:#444;line-height:1.65;border-left:3px solid #bbb;"><strong style="color:#111;display:block;margin-bottom:3px;">Fase 2 (Maand 4&ndash;6) &mdash; Consolidatie</strong>${fase2}</td></tr>\n            <tr><td style="padding:4px 0;font-size:1px;">&nbsp;</td></tr>\n            <tr><td style="padding:10px 16px;background:#f7f7f5;border-radius:8px;font-size:13px;color:#444;line-height:1.65;border-left:3px solid #888;"><strong style="color:#111;display:block;margin-bottom:3px;">Fase 3 (Maand 7&ndash;12) &mdash; Optimalisatie</strong>${fase3}</td></tr>\n          </table>\n          <p style="margin:0 0 28px;font-size:14px;color:#666;line-height:1.7;">Onze specialist neemt binnenkort contact met u op. Heeft u vragen? Stuur ons een bericht via <a href="mailto:hello@yourdomi.be" style="color:#111;font-weight:600;text-decoration:none;">hello@yourdomi.be</a>.</p>\n          <table cellpadding="0" cellspacing="0" style="margin:0 0 36px;"><tr><td style="background:#111111;border-radius:8px;"><a href="https://yourdomi.be" style="display:inline-block;padding:14px 28px;color:#ffffff;font-size:14px;font-weight:600;text-decoration:none;letter-spacing:0.2px;">Meer info op YourDomi.be &rarr;</a></td></tr></table>\n          <p style="margin:0 0 40px;font-size:13px;color:#999;line-height:1.6;">Met vriendelijke groet,<br><strong style="color:#111;font-family:'Crimson Pro',Georgia,serif;font-size:15px;">Het YourDomi team</strong></p>\n        </td></tr>\n        <tr><td style="padding:20px 48px;border-top:1px solid #f0f0f0;">\n          <p style="margin:0;font-size:11px;color:#bbb;line-height:1.7;text-align:center;">Uw gegevens worden nooit gedeeld met derden. YourDomi gebruikt deze enkel om u te contacteren over uw pand.<br>&copy; ${new Date().getFullYear()} YourDomi.be &nbsp;&middot;&nbsp; Vertrouwelijk document gegenereerd op ${datum}.</p>\n        </td></tr>\n      </table>\n    </td></tr>\n  </table>\n</body>\n</html>`;

  try {
    // Use PDF from frontend if provided, otherwise fall back to server-side generation
    const pdfBase64 = payload.pdfBase64 || null;
    const pdfContent = pdfBase64 || (await generateReportPDF(payload)).toString('base64');

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${resendKey}`
      },
      body: JSON.stringify({
        from: 'YourDomi <hello@yourdomi.be>',
        to: [email],
        subject: `Uw rentabiliteitsanalyse — ${locatie}`,
        html,
        attachments: [{
          filename: `yourdomi-analyse-${(locatie).replace(/\s+/g, '-').toLowerCase()}.pdf`,
          content: pdfContent
        }]
      })
    });

    const data = await res.json();
    if (data.id) {
      console.log('Lead email sent:', data.id, '->', email);
    } else {
      console.error('Resend error:', JSON.stringify(data));
    }
  } catch (e) {
    console.error('Lead email failed (non-fatal):', e.message, e.stack);
  }
}
