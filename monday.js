import PDFDocument from 'pdfkit';

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

async function enrichWithClaude(anthropicKey, payload) {
  if (!anthropicKey) return {};
  const { naam, adres, gemeente, type, kamers, slaapplaatsen, startmaand, extraInfo, scenarios, jaar1Total, jaar2Total } = payload;
  const prompt = `Je bent een CRM assistent voor YourDomi, een Belgisch short-term rental beheer bedrijf.
Een potentiële eigenaar heeft een rentabiliteitsanalyse aangevraagd via de website.

LEAD:
- Naam: ${naam}, Adres: ${adres}, ${gemeente}
- Type: ${type}, Kamers: ${kamers}, Slaapplaatsen: ${slaapplaatsen}, Start: ${startmaand}
- Extra: ${extraInfo || 'geen'}

OMZET:
- Conservatief: €${scenarios?.conservatief?.maand}/maand
- Realistisch: €${scenarios?.realistisch?.maand}/maand
- Optimaal: €${scenarios?.optimaal?.maand}/maand
- Jaar 1: €${jaar1Total}, Jaar 2: €${jaar2Total}

Geef ALLEEN dit JSON terug (geen uitleg):
{"deal_naam":"korte naam bijv Appartement Knokke 2slpk","verwachte_commissie":0,"notities":"2-3 zinnen voor sales team","stad_regio":"stad of regio"}`;

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

async function getBoardColumns(apiKey, boardId) {
  const data = await mondayQuery(apiKey, `query($bid: [ID!]) { boards(ids: $bid) { columns { id title type } } }`, { bid: [boardId] });
  const map = {};
  for (const c of data.boards[0]?.columns || []) map[c.title.toLowerCase()] = c;
  return map;
}

async function ensureColumn(apiKey, boardId, title, columnType) {
  try {
    const data = await mondayQuery(apiKey, `mutation($boardId: ID!, $title: String!, $type: ColumnType!) { create_column(board_id: $boardId, title: $title, column_type: $type) { id } }`, { boardId, title, type: columnType });
    return data.create_column.id;
  } catch (e) { console.log(`Column "${title}" skip:`, e.message); }
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
  form.append('query', `mutation($file: File!) { add_file_to_column(item_id: ${itemId}, column_id: "${columnId}", file: $file) { id } }`);
  form.append('variables[file]', buffer, { filename, contentType: 'application/pdf' });
  const res = await fetch(MONDAY_FILE_API, { method: 'POST', headers: { 'Authorization': apiKey, ...form.getHeaders() }, body: form });
  const data = await res.json();
  if (data.errors) throw new Error(JSON.stringify(data.errors));
  return data;
}

// Create contact in Monday CRM Contacts board and return its ID
async function createContact(apiKey, naam, telefoon, email) {
  try {
    const boardsData = await mondayQuery(apiKey, `query { boards(limit: 50, board_kind: public) { id name type } }`);
    const contactsBoard = boardsData.boards.find(b =>
      b.name.toLowerCase().includes('contact') && b.type !== 'sub_items_board'
    );
    if (!contactsBoard) { console.log('No Contacts board found'); return null; }
    console.log('Contacts board:', contactsBoard.name, contactsBoard.id);

    const cColMap = await getBoardColumns(apiKey, contactsBoard.id);
    console.log('Contacts columns:', Object.keys(cColMap));

    const cv = {};
    const phoneCol = cColMap['phone'] || cColMap['telefoon'];
    const emailCol = cColMap['email'] || cColMap['e-mail'];
    if (phoneCol && telefoon) cv[phoneCol.id] = { phone: telefoon, countryShortName: 'BE' };
    if (emailCol && email)    cv[emailCol.id] = { email, text: email };

    const gData = await mondayQuery(apiKey, `query($bid: [ID!]) { boards(ids: $bid) { groups { id } } }`, { bid: [contactsBoard.id] });
    const firstGroup = gData.boards[0]?.groups?.[0];
    if (!firstGroup) { console.log('No groups in contacts board'); return null; }

    const res = await mondayQuery(apiKey, `
      mutation($boardId: ID!, $groupId: String!, $name: String!, $cv: JSON!) {
        create_item(board_id: $boardId, group_id: $groupId, item_name: $name, column_values: $cv) { id }
      }
    `, { boardId: contactsBoard.id, groupId: firstGroup.id, name: naam || 'Onbekend', cv: JSON.stringify(cv) });

    console.log('Contact created:', res.create_item.id);
    return res.create_item.id;
  } catch (e) {
    console.error('Contact creation failed (non-fatal):', e.message);
    return null;
  }
}

export async function createMondayLead(mondayKey, anthropicKey, payload) {
  const { naam, email, telefoon, adres, gemeente, type, kamers, slaapplaatsen, startmaand, extraInfo, datum, scenarios, jaar1Total, jaar2Total } = payload;

  const boardId = process.env.MONDAY_BOARD_ID;
  if (!boardId) throw new Error('MONDAY_BOARD_ID env var not set in Railway');

  // Run enrichment + group fetch in parallel
  const [enriched, groupData] = await Promise.all([
    anthropicKey ? enrichWithClaude(anthropicKey, payload) : Promise.resolve({}),
    mondayQuery(mondayKey, `query($bid: [ID!]) { boards(ids: $bid) { groups { id title } } }`, { bid: [boardId] })
  ]);
  console.log('Claude enrichment:', enriched);

  const groups = groupData.boards[0]?.groups || [];
  const group = groups.find(g =>
    g.title.toLowerCase().includes('new lead') ||
    g.title.toLowerCase().includes('incoming') ||
    g.title.toLowerCase().includes('new - to be')
  ) || groups[0];
  if (!group) throw new Error('No group found in board');

  // Ensure columns exist
  let colMap = await getBoardColumns(mondayKey, boardId);
  console.log('Deal board columns:', Object.keys(colMap));

  for (const col of [
    { title: 'Adres',              type: 'text' },
    { title: 'Slaapplaatsen',      type: 'numbers' },
    { title: 'Startmaand',         type: 'text' },
    { title: 'Extra info',         type: 'long_text' },
    { title: 'Omzet conservatief', type: 'numbers' },
    { title: 'Omzet realistisch',  type: 'numbers' },
    { title: 'Omzet optimaal',     type: 'numbers' },
    { title: 'Jaar 1 omzet',       type: 'numbers' },
    { title: 'Jaar 2 prognose',    type: 'numbers' },
    { title: 'Datum aanvraag',     type: 'date' },
    { title: 'AI notities',        type: 'long_text' },
  ]) { if (!colMap[col.title.toLowerCase()]) await ensureColumn(mondayKey, boardId, col.title, col.type); }

  colMap = await getBoardColumns(mondayKey, boardId);

  const today = datum ? new Date(datum).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
  const cv = {};

  const setText  = (t, v) => { const c = colMap[t.toLowerCase()]; if (c && v) cv[c.id] = String(v); };
  const setNum   = (t, v) => { const c = colMap[t.toLowerCase()]; if (c && v != null) cv[c.id] = Number(v); };
  const setLabel = (t, v) => { const c = colMap[t.toLowerCase()]; if (c && v) cv[c.id] = { label: String(v) }; };
  const setLong  = (t, v) => { const c = colMap[t.toLowerCase()]; if (c && v) cv[c.id] = { text: String(v) }; };

  setText('Adres', adres);
  setNum('Slaapplaatsen', slaapplaatsen);
  setText('Startmaand', startmaand);
  setLong('Extra info', extraInfo);
  setLong('AI notities', enriched.notities);
  if (colMap['datum aanvraag']) cv[colMap['datum aanvraag'].id] = { date: today };
  if (colMap['lead source'])    cv[colMap['lead source'].id]    = { label: 'Website' };
  if (colMap['aantal kamers'] && kamers) cv[colMap['aantal kamers'].id] = Number(kamers);
  if (colMap['type'])   setLabel('Type', 'Beheer');
  if (colMap['stage'])  setLabel('Stage', 'New / Meeting Planned');
  if (enriched.verwachte_commissie && colMap['commission']) cv[colMap['commission'].id] = Number(enriched.verwachte_commissie);

  // Headquarters location = gemeente/regio
  const hqCol = colMap['headquarters location'] || colMap['locatie'] || colMap['gemeente'];
  if (hqCol) cv[hqCol.id] = String(enriched.stad_regio || gemeente || '');

  setNum('Omzet conservatief', scenarios?.conservatief?.maand);
  setNum('Omzet realistisch',  scenarios?.realistisch?.maand);
  setNum('Omzet optimaal',     scenarios?.optimaal?.maand);
  setNum('Jaar 1 omzet',       jaar1Total);
  setNum('Jaar 2 prognose',    jaar2Total);

  const itemName = enriched.deal_naam || `${naam || 'Lead'} — ${adres || gemeente || ''}`.trim();

  const created = await mondayQuery(mondayKey, `
    mutation($boardId: ID!, $groupId: String!, $itemName: String!, $cv: JSON!) {
      create_item(board_id: $boardId, group_id: $groupId, item_name: $itemName, column_values: $cv) { id }
    }
  `, { boardId, groupId: group.id, itemName, cv: JSON.stringify(cv) });

  const itemId = created.create_item.id;
  console.log('Monday item created:', itemId, '—', itemName);

  // Create contact and link to deal
  const contactId = await createContact(mondayKey, naam, telefoon, email);
  if (contactId) {
    try {
      const contactsCol = colMap['contacts'] || colMap['contact'];
      if (contactsCol) {
        await mondayQuery(mondayKey, `
          mutation($itemId: ID!, $boardId: ID!, $colId: String!, $val: JSON!) {
            change_column_value(item_id: $itemId, board_id: $boardId, column_id: $colId, value: $val) { id }
          }
        `, { itemId, boardId, colId: contactsCol.id, val: JSON.stringify({ item_ids: [Number(contactId)] }) });
        console.log('Contact linked to deal');
      } else {
        console.log('No contacts column found in deal board, columns:', Object.keys(colMap));
      }
    } catch (e) {
      console.error('Contact link failed (non-fatal):', e.message);
    }
  }

  // Attach PDF to Bestanden column
  try {
    const pdfBuffer = await generateReportPDF(payload);
    const filename = `rapport-${(adres || gemeente || 'yourdomi').replace(/\s+/g, '-').toLowerCase()}-${today}.pdf`;
    const fileCol = colMap['bestanden'] || Object.values(colMap).find(c => c.type === 'file');
    if (!fileCol) throw new Error('No file column found. Available: ' + Object.keys(colMap).join(', '));
    console.log('Uploading PDF to column:', fileCol.title, '(id:', fileCol.id + ')');
    await uploadFileToItem(mondayKey, itemId, fileCol.id, filename, pdfBuffer);
    console.log('PDF attached successfully');
  } catch (e) {
    console.error('PDF upload failed (non-fatal):', e.message);
  }

  return itemId;
}
