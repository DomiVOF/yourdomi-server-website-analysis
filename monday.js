import PDFDocument from 'pdfkit';

const MONDAY_API      = 'https://api.monday.com/v2';
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
  const data = await mondayQuery(apiKey, `
    query($boardId: [ID!]) {
      boards(ids: $boardId) { columns { id title type } }
    }
  `, { boardId: [boardId] });
  const cols = data.boards[0]?.columns || [];
  const map = {};
  for (const c of cols) map[c.title.toLowerCase()] = c;
  return map;
}

async function ensureColumn(apiKey, boardId, title, columnType) {
  try {
    const data = await mondayQuery(apiKey, `
      mutation($boardId: ID!, $title: String!, $type: ColumnType!) {
        create_column(board_id: $boardId, title: $title, column_type: $type) { id }
      }
    `, { boardId, title, type: columnType });
    return data.create_column.id;
  } catch (e) {
    console.log(`Column "${title}" already exists or failed:`, e.message);
  }
}

async function enrichWithClaude(anthropicKey, payload) {
  const { naam, adres, gemeente, type, kamers, slaapplaatsen,
          startmaand, extraInfo, scenarios, jaar1Total, jaar2Total } = payload;

  const prompt = `Je bent een CRM assistent voor YourDomi, een Belgisch short-term rental beheer bedrijf.

Een potentiële eigenaar heeft een rentabiliteitsanalyse aangevraagd. Vul de CRM velden in.

LEAD:
- Naam: ${naam}
- Adres: ${adres}, ${gemeente}
- Type: ${type}, ${kamers} slaapkamers, ${slaapplaatsen} slaapplaatsen
- Start: ${startmaand}
- Extra: ${extraInfo || 'geen'}

OMZET:
- Conservatief: €${scenarios?.conservatief?.maand}/maand
- Realistisch: €${scenarios?.realistisch?.maand}/maand
- Optimaal: €${scenarios?.optimaal?.maand}/maand
- Jaar 1: €${jaar1Total}, Jaar 2: €${jaar2Total}

Geef ALLEEN raw JSON terug (geen markdown, geen uitleg):
{"deal_naam":"...","verwachte_commissie":0,"prioriteit":"hoog","notities":"...","stad_regio":"..."}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }]
      })
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
    const { naam, adres, gemeente, type, kamers, slaapplaatsen,
            startmaand, scenarios, jaar1Total, jaar2Total, reportDate } = payload;

    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(22).font('Helvetica-Bold').text('YourDomi.be');
    doc.moveDown(0.3);
    doc.fontSize(12).fillColor('#444').text('Rentabiliteitsanalyse');
    doc.moveDown(0.2);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#E0E0E0').stroke();
    doc.moveDown(0.8);

    doc.fillColor('#111').fontSize(16).font('Helvetica-Bold').text('Eigendomsgegevens');
    doc.moveDown(0.4);

    for (const [label, value] of [
      ['Naam aanvrager', naam], ['Adres', adres], ['Gemeente', gemeente],
      ['Type pand', type], ['Slaapkamers', kamers], ['Slaapplaatsen', slaapplaatsen],
      ['Verwachte start', startmaand],
      ['Datum aanvraag', reportDate || new Date().toLocaleDateString('nl-BE')],
    ]) {
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#555')
        .text(label + ':', { continued: true, width: 160 });
      doc.font('Helvetica').fillColor('#111').text('  ' + (value || '—'));
    }

    doc.moveDown(0.8);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#E0E0E0').stroke();
    doc.moveDown(0.8);
    doc.fillColor('#111').fontSize(16).font('Helvetica-Bold').text("Omzetscenario's");
    doc.moveDown(0.5);

    if (scenarios) {
      for (const [key, label] of [['conservatief','Conservatief'],['realistisch','Realistisch'],['optimaal','Optimaal']]) {
        const s = scenarios[key];
        if (!s) continue;
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#111').text(label);
        doc.fontSize(10).font('Helvetica').fillColor('#444');
        doc.text(`Maandelijkse omzet: €${s.maand?.toLocaleString('nl-BE') || '—'}`);
        doc.text(`Bezetting: ${s.bezetting || '—'}   ADR: €${s.adr || '—'}`);
        doc.moveDown(0.4);
      }
    }

    if (jaar1Total) doc.fontSize(11).font('Helvetica-Bold').fillColor('#111')
      .text(`Jaar 1 omzet: €${Number(jaar1Total).toLocaleString('nl-BE')}`);
    if (jaar2Total) doc.fontSize(11).font('Helvetica-Bold').fillColor('#111')
      .text(`Jaar 2 prognose: €${Number(jaar2Total).toLocaleString('nl-BE')}`);

    doc.moveDown(1);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#E0E0E0').stroke();
    doc.moveDown(0.6);
    doc.fontSize(9).fillColor('#AAA')
      .text('Indicatieve analyse op basis van marktdata en AI-modellen. Geen garanties.', { align: 'center' });
    doc.text('Vertrouwelijk — YourDomi.be', { align: 'center' });
    doc.end();
  });
}

async function uploadFileToItem(apiKey, itemId, filename, buffer) {
  const FormData = (await import('form-data')).default;
  const form = new FormData();
  form.append('query', `mutation($file: File!) {
    add_file_to_column(item_id: ${itemId}, column_id: "files", file: $file) { id }
  }`);
  form.append('variables[file]', buffer, { filename, contentType: 'application/pdf' });
  const res = await fetch(MONDAY_FILE_API, {
    method: 'POST',
    headers: { 'Authorization': apiKey, ...form.getHeaders() },
    body: form
  });
  const data = await res.json();
  if (data.errors) console.error('File upload error:', data.errors);
  return data;
}

export async function createMondayLead(mondayKey, anthropicKey, payload) {
  const {
    naam, email, telefoon, adres, gemeente, type,
    kamers, slaapplaatsen, startmaand, extraInfo, datum,
    scenarios, jaar1Total, jaar2Total
  } = payload;

  const boardId = process.env.MONDAY_BOARD_ID;
  if (!boardId) throw new Error('MONDAY_BOARD_ID env var not set in Railway');

  const [enriched, groupData] = await Promise.all([
    anthropicKey ? enrichWithClaude(anthropicKey, payload) : Promise.resolve({}),
    mondayQuery(mondayKey, `
      query($boardId: [ID!]) {
        boards(ids: $boardId) { groups { id title } }
      }
    `, { boardId: [boardId] })
  ]);

  console.log('Claude enrichment:', enriched);

  const groups = groupData.boards[0]?.groups || [];
  const group = groups.find(g =>
    g.title.toLowerCase().includes('new lead') ||
    g.title.toLowerCase().includes('incoming') ||
    g.title.toLowerCase().includes('new - to be')
  ) || groups[0];
  if (!group) throw new Error('No group found in board');
  const groupId = group.id;

  let colMap = await getBoardColumns(mondayKey, boardId);
  const needed = [
    { title: 'E-mail',             type: 'email' },
    { title: 'Telefoon',           type: 'phone' },
    { title: 'Adres',              type: 'text' },
    { title: 'Gemeente',           type: 'text' },
    { title: 'Slaapplaatsen',      type: 'numbers' },
    { title: 'Startmaand',         type: 'text' },
    { title: 'Extra info',         type: 'long_text' },
    { title: 'Omzet conservatief', type: 'numbers' },
    { title: 'Omzet realistisch',  type: 'numbers' },
    { title: 'Omzet optimaal',     type: 'numbers' },
    { title: 'Jaar 1 omzet',       type: 'numbers' },
    { title: 'Jaar 2 prognose',    type: 'numbers' },
    { title: 'Bron',               type: 'text' },
    { title: 'Datum aanvraag',     type: 'date' },
    { title: 'AI notities',        type: 'long_text' },
    { title: 'Bestanden',          type: 'file' },
  ];
  for (const col of needed) {
    if (!colMap[col.title.toLowerCase()]) {
      await ensureColumn(mondayKey, boardId, col.title, col.type);
    }
  }
  colMap = await getBoardColumns(mondayKey, boardId);

  const today = datum
    ? new Date(datum).toISOString().split('T')[0]
    : new Date().toISOString().split('T')[0];
  const cv = {};

  const setText  = (t, v) => { const c = colMap[t.toLowerCase()]; if (c && v) cv[c.id] = String(v); };
  const setNum   = (t, v) => { const c = colMap[t.toLowerCase()]; if (c && v) cv[c.id] = Number(v); };
  const setLabel = (t, v) => { const c = colMap[t.toLowerCase()]; if (c && v) cv[c.id] = { label: String(v) }; };
  const setLong  = (t, v) => { const c = colMap[t.toLowerCase()]; if (c && v) cv[c.id] = { text: String(v) }; };

  if (colMap['e-mail'] && email)      cv[colMap['e-mail'].id] = { email, text: email };
  if (colMap['telefoon'] && telefoon) cv[colMap['telefoon'].id] = { phone: telefoon, countryShortName: 'BE' };

  setText('Adres', adres);
  setText('Gemeente', enriched.stad_regio || gemeente);
  setNum('Slaapplaatsen', slaapplaatsen);
  setText('Startmaand', startmaand);
  setLong('Extra info', extraInfo);
  setText('Bron', 'Website');
  setLong('AI notities', enriched.notities);

  if (colMap['datum aanvraag']) cv[colMap['datum aanvraag'].id] = { date: today };
  if (colMap['lead source'])    cv[colMap['lead source'].id]    = { label: 'Website' };
  if (colMap['aantal kamers'] && kamers) cv[colMap['aantal kamers'].id] = Number(kamers);
  if (colMap['type'])   setLabel('Type', 'Beheer');
  if (colMap['stage'])  setLabel('Stage', 'New — Website Lead');
  if (enriched.verwachte_commissie && colMap['commission'])
    cv[colMap['commission'].id] = Number(enriched.verwachte_commissie);

  setNum('Omzet conservatief', scenarios?.conservatief?.maand);
  setNum('Omzet realistisch',  scenarios?.realistisch?.maand);
  setNum('Omzet optimaal',     scenarios?.optimaal?.maand);
  setNum('Jaar 1 omzet',       jaar1Total);
  setNum('Jaar 2 prognose',    jaar2Total);

  const itemName = enriched.deal_naam ||
    `${naam || 'Lead'} — ${adres || gemeente || ''}`.trim();

  const created = await mondayQuery(mondayKey, `
    mutation($boardId: ID!, $groupId: String!, $itemName: String!, $cv: JSON!) {
      create_item(board_id: $boardId, group_id: $groupId, item_name: $itemName, column_values: $cv) { id }
    }
  `, { boardId, groupId, itemName, cv: JSON.stringify(cv) });

  const itemId = created.create_item.id;
  console.log('Monday item created:', itemId, '—', itemName);

  try {
    const pdfBuffer = await generateReportPDF(payload);
    const filename = `rapport-${(adres || gemeente || 'yourdomi').replace(/\s+/g, '-').toLowerCase()}-${today}.pdf`;
    await uploadFileToItem(mondayKey, itemId, filename, pdfBuffer);
    console.log('PDF attached');
  } catch (e) {
    console.error('PDF upload failed (non-fatal):', e.message);
  }

  return itemId;
}
