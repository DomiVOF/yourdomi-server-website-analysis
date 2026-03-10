import PDFDocument from 'pdfkit';
import { uploadPDFToDrive } from './drive.js';

const MONDAY_API = 'https://api.monday.com/v2';
const MONDAY_FILE_API = 'https://api.monday.com/v2/file';

async function mondayQuery(apiKey, query, variables = {}) {
  const res = await fetch(MONDAY_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': apiKey,
      'API-Version': '2024-01'
    },
    body: JSON.stringify({ query, variables })
  });
  const data = await res.json();
  if (data.errors) throw new Error(data.errors[0].message);
  return data.data;
}

async function getBoardColumns(apiKey, boardId) {
  const data = await mondayQuery(apiKey, `query($bid: [ID!]) { boards(ids: $bid) { columns { id title type } } }`, { bid: [boardId] });
  const map = {};
  for (const c of data.boards[0]?.columns || []) map[c.title.toLowerCase()] = c;
  return map;
}

async function findBoardByName(apiKey, nameFragment) {
  const data = await mondayQuery(apiKey, `query { boards(limit: 100, board_kind: public) { id name type } }`);
  return data.boards.find(b =>
    b.name.toLowerCase().includes(nameFragment.toLowerCase()) &&
    b.type !== 'sub_items_board'
  ) || null;
}

async function getFirstGroup(apiKey, boardId) {
  const data = await mondayQuery(apiKey, `query($bid: [ID!]) { boards(ids: $bid) { groups { id title } } }`, { bid: [boardId] });
  return data.boards[0]?.groups?.[0] || null;
}

async function enrichWithClaude(anthropicKey, payload) {
  if (!anthropicKey) return {};
  const { naam, adres, gemeente, type, kamers, slaapplaatsen, startmaand, extraInfo, scenarios, jaar1Total, jaar2Total } = payload;
  const prompt = `Je bent een CRM assistent voor YourDomi, een Belgisch short-term rental beheer bedrijf.

LEAD: Naam: ${naam}, Adres: ${adres}, ${gemeente}
Type: ${type}, Kamers: ${kamers}, Slaapplaatsen: ${slaapplaatsen}, Start: ${startmaand}
Extra: ${extraInfo || 'geen'}

OMZET:
- Conservatief: €${scenarios?.conservatief?.maand}/maand
- Realistisch: €${scenarios?.realistisch?.maand}/maand  
- Optimaal: €${scenarios?.optimaal?.maand}/maand
- Jaar 1: €${jaar1Total}, Jaar 2: €${jaar2Total}

Geef ALLEEN dit JSON (geen uitleg):
{"deal_naam":"korte naam bijv Appartement Knokke 2slpk","verwachte_commissie":0,"notities":"2-3 zinnen voor sales team","stad_regio":"genormaliseerde stad of regio"}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: 400, messages: [{ role: 'user', content: prompt }] })
    });
    const data = await res.json();
    const text = data.content?.[0]?.text || '{}';
    return JSON.parse(text.replace(/```json|```/g, '').trim());
  } catch (e) {
    console.error('Claude enrichment failed:', e.message);
    return {};
  }
}

export async function generateReportPDF(payload) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    const { naam, adres, gemeente, type, kamers, slaapplaatsen, startmaand, scenarios, jaar1Total, jaar2Total, reportDate } = payload;
    doc.fontSize(22).font('Helvetica-Bold').text('YourDomi.be');
    doc.moveDown(0.3);
    doc.fontSize(12).fillColor('#444').text('Rentabiliteitsanalyse');
    doc.moveDown(0.2);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#E0E0E0').stroke();
    doc.moveDown(0.8);
    doc.fillColor('#111').fontSize(16).font('Helvetica-Bold').text('Eigendomsgegevens');
    doc.moveDown(0.4);
    for (const [label, value] of [
      ['Naam aanvrager', naam||'—'], ['Adres', adres||'—'], ['Gemeente', gemeente||'—'],
      ['Type pand', type||'—'], ['Slaapkamers', kamers||'—'], ['Slaapplaatsen', slaapplaatsen||'—'],
      ['Verwachte start', startmaand||'—'], ['Datum aanvraag', reportDate||new Date().toLocaleDateString('nl-BE')]
    ]) {
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#555').text(label + ':', { continued: true, width: 160 });
      doc.font('Helvetica').fillColor('#111').text('  ' + value);
    }
    doc.moveDown(0.8);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#E0E0E0').stroke();
    doc.moveDown(0.8);
    doc.fillColor('#111').fontSize(16).font('Helvetica-Bold').text("Omzetscenario's");
    doc.moveDown(0.5);
    if (scenarios) {
      for (const [key, label] of [['conservatief','Conservatief'],['realistisch','Realistisch'],['optimaal','Optimaal']]) {
        const s = scenarios[key]; if (!s) continue;
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#111').text(label);
        doc.fontSize(10).font('Helvetica').fillColor('#444');
        doc.text(`Maandelijkse omzet: €${s.maand?.toLocaleString('nl-BE')||'—'}`);
        doc.text(`Bezetting: ${s.bezetting||'—'}   ADR: €${s.adr||'—'}`);
        doc.moveDown(0.4);
      }
    }
    if (jaar1Total) doc.fontSize(11).font('Helvetica-Bold').fillColor('#111').text(`Jaar 1 omzet: €${Number(jaar1Total).toLocaleString('nl-BE')}`);
    if (jaar2Total) doc.fontSize(11).font('Helvetica-Bold').fillColor('#111').text(`Jaar 2 prognose: €${Number(jaar2Total).toLocaleString('nl-BE')}`);
    doc.moveDown(1);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#E0E0E0').stroke();
    doc.moveDown(0.6);
    doc.fontSize(9).fillColor('#AAA').text('Indicatieve analyse op basis van marktdata en AI-modellen. Geen garanties.', { align: 'center' });
    doc.text('Vertrouwelijk — YourDomi.be', { align: 'center' });
    doc.end();
  });
}

async function uploadFileToItem(apiKey, itemId, columnId, filename, buffer) {
  const FormData = (await import('form-data')).default;
  const form = new FormData();
  // Monday file upload: query + variables[file] as multipart
  form.append(
    'query',
    `mutation ($file: File!) { add_file_to_column(item_id: ${itemId}, column_id: "${columnId}", file: $file) { id } }`
  );
  form.append('variables[file]', buffer, {
    filename,
    contentType: 'application/octet-stream',
    knownLength: buffer.length
  });

  // Merge Authorization with form headers explicitly
  const formHeaders = form.getHeaders();
  const headers = {
    ...formHeaders,
    'Authorization': apiKey,   // Monday API key (no Bearer prefix)
  };

  console.log('File upload → item:', itemId, 'col:', columnId, 'size:', buffer.length, 'bytes');
  const res = await fetch(MONDAY_FILE_API, { method: 'POST', headers, body: form });
  const text = await res.text();
  console.log('File upload HTTP status:', res.status, '| body:', text.slice(0, 300) || '(empty)');

  // Monday sometimes returns empty body on success — treat that as OK
  if (!text || text.trim() === '') {
    console.log('PDF upload: empty response body — treating as success (HTTP ' + res.status + ')');
    return { ok: true };
  }
  let data;
  try { data = JSON.parse(text); } catch { 
    // Non-JSON but not empty — log and treat 2xx as success
    if (res.status >= 200 && res.status < 300) {
      console.log('PDF upload: non-JSON 2xx response — treating as success');
      return { ok: true };
    }
    throw new Error('Non-JSON error response: ' + text.slice(0, 300));
  }
  if (data.errors) throw new Error('Monday file error: ' + JSON.stringify(data.errors));
  console.log('PDF upload success:', JSON.stringify(data).slice(0, 200));
  return data;
}

// Step 1: Create contact in Contacts board — returns contact item ID
async function createContact(apiKey, naam, telefoon, email, gemeente, adres, stadRegio) {
  try {
    const board = await findBoardByName(apiKey, 'contact');
    if (!board) { console.log('No Contacts board found'); return null; }
    console.log('Contacts board:', board.name, board.id);

    const colMap = await getBoardColumns(apiKey, board.id);
    console.log('Contacts columns:', Object.keys(colMap));

    const cv = {};
    const phoneCol = colMap['phone'] || colMap['telefoon'];
    const emailCol = colMap['email'] || colMap['e-mail'];
    const leadSourceCol = colMap['lead source'] || colMap['lead bron'] || colMap['bron'];
    const gemeenteCol = colMap['hoofdgemeente'] || colMap['gemeente'] || colMap['headquarters location'];
    const adresCol = colMap['adres'] || colMap['address'];

    if (phoneCol && telefoon) cv[phoneCol.id] = { phone: telefoon, countryShortName: 'BE' };
    if (emailCol && email)    cv[emailCol.id] = { email, text: email };
    if (leadSourceCol)        cv[leadSourceCol.id] = { label: 'Website' };
    if (gemeenteCol)          cv[gemeenteCol.id] = String(stadRegio || gemeente || '');
    if (adresCol)             cv[adresCol.id] = String(adres || '');

    const group = await getFirstGroup(apiKey, board.id);
    if (!group) { console.log('No group in Contacts board'); return null; }

    const res = await mondayQuery(apiKey, `
      mutation($boardId: ID!, $groupId: String!, $name: String!, $cv: JSON!) {
        create_item(board_id: $boardId, group_id: $groupId, item_name: $name, column_values: $cv) { id }
      }
    `, { boardId: board.id, groupId: group.id, name: naam || 'Onbekend', cv: JSON.stringify(cv) });

    const contactId = res.create_item.id;
    console.log('Contact created:', contactId, naam);
    return { contactId, contactsBoardId: board.id };
  } catch (e) {
    console.error('Contact creation failed (non-fatal):', e.message);
    return null;
  }
}

// Step 2: Create lead in Leads board and link the contact
export async function createMondayLead(mondayKey, anthropicKey, payload) {
  const { naam, email, telefoon, adres, gemeente, type, kamers, slaapplaatsen, startmaand, extraInfo, datum, scenarios, jaar1Total, jaar2Total } = payload;

  // Use explicit MONDAY_LEADS_BOARD_ID if set, otherwise search by name
  const boardId = process.env.MONDAY_LEADS_BOARD_ID
    || await findBoardByName(mondayKey, 'lead').then(b => b?.id);

  if (!boardId) throw new Error('No Leads board found. Set MONDAY_LEADS_BOARD_ID env var in Railway.');
  console.log('Using Leads board:', boardId);

  // Enrich with Claude in parallel with column fetch
  const [enriched, colMap, group] = await Promise.all([
    anthropicKey ? enrichWithClaude(anthropicKey, payload) : Promise.resolve({}),
    getBoardColumns(mondayKey, boardId),
    getFirstGroup(mondayKey, boardId)
  ]);

  console.log('Claude enrichment:', enriched);
  console.log('Leads board columns:', Object.keys(colMap));

  if (!group) throw new Error('No group found in Leads board');

  const today = datum ? new Date(datum).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
  const cv = {};

  const setLabel = (t, v) => { const c = colMap[t.toLowerCase()]; if (c && v) cv[c.id] = { label: String(v) }; };
  const setLong  = (t, v) => { const c = colMap[t.toLowerCase()]; if (c && v) cv[c.id] = { text: String(v) }; };
  const setText  = (t, v) => { const c = colMap[t.toLowerCase()]; if (c && v) cv[c.id] = String(v); };

  // Status = New Lead
  const statusCol = colMap['status'];
  if (statusCol) cv[statusCol.id] = { label: 'New Lead' };

  // Lead source = Website
  const leadSourceCol = colMap['lead source'] || colMap['bron'];
  if (leadSourceCol) cv[leadSourceCol.id] = { label: 'Website' };

  // Name, Email, Phone directly on the lead
  const nameCol = colMap['name'] || colMap['naam'];
  if (nameCol && naam) cv[nameCol.id] = String(naam);

  const emailCol = colMap['email'] || colMap['e-mail'];
  if (emailCol && email) cv[emailCol.id] = { email, text: email };

  const phoneCol = colMap['phone'] || colMap['telefoon'];
  if (phoneCol && telefoon) cv[phoneCol.id] = { phone: telefoon, countryShortName: 'BE' };

  // AI notes
  setLong('ai notities', enriched.notities);
  setText('adres', adres);

  const gemeenteCol = colMap['hoofdgemeente'] || colMap['gemeente'];
  if (gemeenteCol) cv[gemeenteCol.id] = String(enriched.stad_regio || gemeente || '');

  // Last interaction = today
  const lastInteractionCol = colMap['last interaction'] || colMap['laatste interactie'];
  if (lastInteractionCol) cv[lastInteractionCol.id] = { date: today };

  // Item name = Claude deal name or fallback
  const itemName = enriched.deal_naam || `${naam || 'Lead'} — ${adres || gemeente || ''}`.trim();

  // Create lead item
  const created = await mondayQuery(mondayKey, `
    mutation($boardId: ID!, $groupId: String!, $itemName: String!, $cv: JSON!) {
      create_item(board_id: $boardId, group_id: $groupId, item_name: $itemName, column_values: $cv) { id }
    }
  `, { boardId, groupId: group.id, itemName, cv: JSON.stringify(cv) });

  const itemId = created.create_item.id;
  console.log('Lead created:', itemId, '—', itemName);

  // Create contact and link it to lead
  const contactResult = await createContact(mondayKey, naam, telefoon, email, gemeente, adres, enriched.stad_regio);
  if (contactResult) {
    try {
      const connectCol = colMap['contacts'] || colMap['contact'] || Object.values(colMap).find(c => c.type === 'board-relation' || c.type === 'connect_boards');
      if (connectCol) {
        await mondayQuery(mondayKey, `
          mutation($itemId: ID!, $boardId: ID!, $colId: String!, $val: JSON!) {
            change_column_value(item_id: $itemId, board_id: $boardId, column_id: $colId, value: $val) { id }
          }
        `, { itemId, boardId, colId: connectCol.id, val: JSON.stringify({ item_ids: [Number(contactResult.contactId)] }) });
        console.log('Contact linked to lead');
      } else {
        console.log('No connect column found. Columns:', Object.keys(colMap));
      }
    } catch (e) {
      console.error('Contact link failed (non-fatal):', e.message);
    }
  }

  // Generate PDF, upload to Google Drive, add link to Monday
  try {
    // Use PDF from frontend if provided, otherwise fall back to server-side generation
    const pdfBuffer = payload.pdfBase64 ? Buffer.from(payload.pdfBase64, 'base64') : await generateReportPDF(payload);
    const filename = `rapport-${(adres || gemeente || 'yourdomi').replace(/\s+/g, '-').toLowerCase()}-${today}.pdf`;

    const driveLink = await uploadPDFToDrive(pdfBuffer, filename);

    // Put the Drive link in a URL/link column — try common column names
    const linkCol = colMap['rapport'] || colMap['rapport link'] || colMap['link'] || colMap['website'] || colMap['drive'];
    if (linkCol) {
      await mondayQuery(mondayKey, `
        mutation($itemId: ID!, $boardId: ID!, $colId: String!, $val: JSON!) {
          change_column_value(item_id: $itemId, board_id: $boardId, column_id: $colId, value: $val) { id }
        }
      `, { itemId, boardId, colId: linkCol.id, val: JSON.stringify({ url: driveLink, text: 'Rapport bekijken' }) });
      console.log('Drive link saved to Monday column:', linkCol.title);
    } else {
      console.log('No link column found — Drive link:', driveLink);
      console.log('Available columns:', Object.keys(colMap).join(', '));
    }
  } catch (e) {
    console.error('PDF/Drive upload failed (non-fatal):', e.message, e.stack);
  }

  return itemId;
}
