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

// Use Claude to enrich and structure the CRM data
async function enrichWithClaude(anthropicKey, payload) {
  const {
    naam, email, telefoon, adres, gemeente, type,
    kamers, slaapplaatsen, startmaand, extraInfo,
    scenarios, jaar1Total, jaar2Total
  } = payload;

  const prompt = `Je bent een CRM assistent voor YourDomi, een Belgisch short-term rental beheer bedrijf.

Een potentiële eigenaar heeft een rentabiliteitsanalyse aangevraagd via de website. Vul de CRM velden in op basis van onderstaande gegevens.

LEAD GEGEVENS:
- Naam: ${naam}
- Adres: ${adres}, ${gemeente}
- Type pand: ${type}
- Slaapkamers: ${kamers}
- Slaapplaatsen: ${slaapplaatsen}
- Verwachte start: ${startmaand}
- Extra info: ${extraInfo || 'geen'}

RAPPORT RESULTATEN:
- Conservatief: €${scenarios?.conservatief?.maand}/maand (${scenarios?.conservatief?.bezetting} bezetting, €${scenarios?.conservatief?.adr} ADR)
- Realistisch: €${scenarios?.realistisch?.maand}/maand (${scenarios?.realistisch?.bezetting} bezetting, €${scenarios?.realistisch?.adr} ADR)
- Optimaal: €${scenarios?.optimaal?.maand}/maand (${scenarios?.optimaal?.bezetting} bezetting, €${scenarios?.optimaal?.adr} ADR)
- Jaar 1 totaal: €${jaar1Total}
- Jaar 2 prognose: €${jaar2Total}

Geef een JSON object terug met ALLEEN deze velden (geen uitleg, alleen JSON):
{
  "deal_naam": "korte beschrijvende naam voor dit pand (bijv. 'Appartement Knokke — 2 slpk')",
  "verwachte_commissie": geschatte jaarlijkse commissie voor YourDomi in euro (typisch 20-25% van realistisch jaar 1 omzet),
  "prioriteit": "hoog" | "medium" | "laag" (hoog = grote omzet of kustlocatie, laag = kleine omzet),
  "notities": "2-3 zinnen CRM notitie voor het sales team over dit pand en wat de aanpak moet zijn",
  "stad_regio": "stad of regio (bijv. Belgische Kust, Gent, Brussel, Ardennen)"
}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': anthropicKey,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      messages: [{ role: 'user', content: prompt }]
    })
  });

  const data = await res.json();
  const text = data.content?.[0]?.text || '{}';
  try {
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch {
    console.error('Claude enrichment parse failed:', text);
    return {};
  }
}

// Get all columns from board
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

// Create a column if it doesn't exist
async function ensureColumn(apiKey, boardId, title, columnType) {
  try {
    const data = await mondayQuery(apiKey, `
      mutation($boardId: ID!, $title: String!, $type: ColumnType!) {
        create_column(board_id: $boardId, title: $title, column_type: $type) { id }
      }
    `, { boardId, title, type: columnType });
    return data.create_column.id;
  } catch(e) {
    console.log(`Column "${title}" already exists or failed:`, e.message);
  }
}

// Generate PDF from report data
export async function generateReportPDF(payload) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const { naam, adres, gemeente, type, kamers, slaapplaatsen,
            startmaand, scenarios, jaar1Total, jaar2Total, reportDate } = payload;

    doc.fontSize(22).font('Helvetica-Bold').text('YourDomi.be');
    doc.moveDown(0.3);
    doc.fontSize(12).fillColor('#444').text('Rentabiliteitsanalyse');
    doc.moveDown(0.2);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#E0E0E0').stroke();
    doc.moveDown(0.8);

    doc.fillColor('#111').fontSize(16).font('Helvetica-Bold').text('Eigendomsgegevens');
    doc.moveDown(0.4);

    const infoRows = [
      ['Naam aanvrager', naam || '—'],
      ['Adres', adres || '—'],
      ['Gemeente', gemeente || '—'],
      ['Type pand', type || '—'],
      ['Slaapkamers', kamers || '—'],
      ['Slaapplaatsen', slaapplaatsen || '—'],
      ['Verwachte start', startmaand || '—'],
      ['Datum aanvraag', reportDate || new Date().toLocaleDateString('nl-BE')],
    ];

    for (const [label, value] of infoRows) {
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#555').text(label + ':', { continued: true, width: 160 });
      doc.font('Helvetica').fillColor('#111').text('  ' + value);
    }

    doc.moveDown(0.8);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#E0E0E0').stroke();
    doc.moveDown(0.8);

    doc.fillColor('#111').fontSize(16).font('Helvetica-Bold').text('Omzetscenario\'s');
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

    if (jaar1Total) doc.fontSize(11).font('Helvetica-Bold').fillColor('#111').text(`Jaar 1 omzet (totaal): €${Number(jaar1Total).toLocaleString('nl-BE')}`);
    if (jaar2Total) doc.fontSize(11).font('Helvetica-Bold').fillColor('#111').text(`Jaar 2 prognose: €${Number(jaar2Total).toLocaleString('nl-BE')}`);

    doc.moveDown(1);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#E0E0E0').stroke();
    doc.moveDown(0.6);
    doc.fontSize(9).fillColor('#AAA')
      .text('Indicatieve analyse op basis van marktdata en AI-modellen. Geen garanties.', { align: 'center' });
    doc.text('Vertrouwelijk — YourDomi.be', { align: 'center' });
    doc.end();
  });
}

// Upload file to a Monday item
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
    scenarios, jaar1Total, jaar2Total, reportDate
  } = payload;

  const boardId = process.env.MONDAY_BOARD_ID;
  if (!boardId) throw new Error('MONDAY_BOARD_ID env var not set in Railway');

  // 1. Claude enrichment — runs in parallel with column setup
  const [enriched, groupData] = await Promise.all([
    anthropicKey ? enrichWithClaude(anthropicKey, payload) : Promise.resolve({}),
    mondayQuery(mondayKey, `
      query($boardId: [ID!]) {
        boards(ids: $boardId) { groups { id title } }
      }
    `, { boardId: [boardId] })
  ]);

  console.log('Claude enrichment:', enriched);

  // 2. Find "New Leads" group
  const groups = groupData.boards[0]?.groups || [];
  const group = groups.find(g =>
    g.title.toLowerCase().includes('new lead') ||
    g.title.toLowerCase().includes('incoming') ||
    g.title.toLowerCase().includes('new - to be')
  ) || groups[0];
  if (!group) throw new Error('No group found in board');
  const groupId = group.id;

  // 3. Ensure extra columns exist
  let colMap = await getBoardColumns(mondayKey, boardId);

  const needed = [
    { title: 'E-mail',             type: 'email' },
    { title: 'Telefoon',           type: 'phone' },
    { title: 'Adres',              type: 'text' },
    { title: 'Gemeente / Regio',   type: 'text' },
    { title: 'Slaapplaatsen',      type: 'numbers' },
    { title: 'Startmaand',         type: 'text' },
    { title: 'Omzet realistisch',  type: 'numbers' },
    { title: 'Omzet jaar 1',       type: 'numbers' },
    { title: 'Omzet jaar 2',       type: 'numbers' },
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

  // 4. Build column values
  const today = datum ? new Date(datum).toISOString().split('T')[0] : new Date().toISOString().split('T')[0];
  const cv = {};

  const setText   = (title, val) => { const c = colMap[title.toLowerCase()]; if (c && val) cv[c.id] = String(val); };
  const setNum    = (title, val) => { const c = colMap[title.toLowerCase()]; if (c && val) cv[c.id] = Number(val); };
  const setLabel  = (title, val) => { const c = colMap[title.toLowerCase()]; if (c && val) cv[c.id] = { label: val }; };
  const setLong   = (title, val) => { const c = colMap[title.toLowerCase()]; if (c && val) cv[c.id] = { text: String(val) }; };

  if (colMap['e-mail'] && email)      cv[colMap['e-mail'].id] = { email, text: email };
  if (colMap['telefoon'] && telefoon) cv[colMap['telefoon'].id] = { phone: telefoon, countryShortName: 'BE' };

  setText('Adres', adres);
  setText('Gemeente / Regio', enriched.stad_regio || gemeente);
  setNum('Slaapplaatsen', slaapplaatsen);
  setText('Startmaand', startmaand);
  setNum('Omzet realistisch', scenarios?.realistisch?.maand);
  setNum('Omzet jaar 1', jaar1Total);
  setNum('Omzet jaar 2', jaar2Total);
  if (colMap['datum aanvraag']) cv[colMap['datum aanvraag'].id] = { date: today };
  setLong('AI notities', enriched.notities);

  // Map existing board columns
  if (colMap['type'])         setLabel('Type', 'Beheer');
  if (colMap['lead source'])  setLabel('Lead source', 'Website');
  if (colMap['stage'])        setLabel('Stage', 'New / Meeting Plan...');
  if (colMap['aantal kamers'] && kamers) cv[colMap['aantal kamers'].id] = Number(kamers);

  // Commission estimate from Claude
  if (enriched.verwachte_commissie && colMap['commission']) {
    cv[colMap['commission'].id] = Number(enriched.verwachte_commissie);
  }

  // 5. Create item — use Claude's deal name if available
  const itemName = enriched.deal_naam ||
    `${adres || gemeente || naam} — ${type || ''} ${kamers ? kamers + ' slpk' : ''}`.trim();

  const created = await mondayQuery(mondayKey, `
    mutation($boardId: ID!, $groupId: String!, $itemName: String!, $cv: JSON!) {
      create_item(board_id: $boardId, group_id: $groupId, item_name: $itemName, column_values: $cv) { id }
    }
  `, { boardId, groupId, itemName, cv: JSON.stringify(cv) });

  const itemId = created.create_item.id;
  console.log('Monday item created:', itemId, itemName);

  // 6. Generate and attach PDF report
  try {
    const pdfBuffer = await generateReportPDF(payload);
    const filename = `rapport-${(adres || gemeente || 'yourdomi').replace(/\s+/g, '-').toLowerCase()}-${today}.pdf`;
    await uploadFileToItem(mondayKey, itemId, filename, pdfBuffer);
    console.log('PDF attached to item');
  } catch (e) {
    console.error('PDF upload failed (non-fatal):', e.message);
  }

  return itemId;
}


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

// Find board by name — exclude subitems boards
async function findBoard(apiKey, name) {
  const data = await mondayQuery(apiKey, `
    query { boards(limit: 50, board_kind: public) { id name type } }
  `);
  return data.boards.find(b =>
    b.name.toLowerCase().includes(name.toLowerCase()) &&
    b.type !== 'sub_items_board'
  );
}

// Find or create a group in a board
async function findOrCreateGroup(apiKey, boardId, groupName) {
  const data = await mondayQuery(apiKey, `
    query($boardId: [ID!]) {
      boards(ids: $boardId) { groups { id title } }
    }
  `, { boardId: [boardId] });

  const existing = data.boards[0]?.groups?.find(g =>
    g.title.toLowerCase() === groupName.toLowerCase()
  );
  if (existing) return existing.id;

  const created = await mondayQuery(apiKey, `
    mutation($boardId: ID!, $groupName: String!) {
      create_group(board_id: $boardId, group_name: $groupName) { id }
    }
  `, { boardId, groupName });
  return created.create_group.id;
}

// Get all columns from board
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

// Create a column if it doesn't exist
async function ensureColumn(apiKey, boardId, title, columnType) {
  const data = await mondayQuery(apiKey, `
    mutation($boardId: ID!, $title: String!, $type: ColumnType!) {
      create_column(board_id: $boardId, title: $title, column_type: $type) { id }
    }
  `, { boardId, title, type: columnType });
  return data.create_column.id;
}

// Generate PDF from report data
export async function generateReportPDF(payload) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ margin: 50, size: 'A4' });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const { naam, adres, gemeente, type, kamers, slaapplaatsen,
            startmaand, scenarios, jaar1Total, jaar2Total, reportDate } = payload;

    // Header
    doc.fontSize(22).font('Helvetica-Bold').text('YourDomi', { continued: true });
    doc.fontSize(22).font('Helvetica').fillColor('#888').text('.be');
    doc.moveDown(0.3);
    doc.fontSize(12).fillColor('#444').text('Rentabiliteitsanalyse', { align: 'left' });
    doc.moveDown(0.2);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#E0E0E0').stroke();
    doc.moveDown(0.8);

    // Property info
    doc.fillColor('#111').fontSize(16).font('Helvetica-Bold').text('Eigendomsgegevens');
    doc.moveDown(0.4);

    const infoRows = [
      ['Naam aanvrager', naam || '—'],
      ['Adres', adres || '—'],
      ['Gemeente', gemeente || '—'],
      ['Type pand', type || '—'],
      ['Slaapkamers', kamers || '—'],
      ['Slaapplaatsen', slaapplaatsen || '—'],
      ['Verwachte start', startmaand || '—'],
      ['Datum aanvraag', reportDate || new Date().toLocaleDateString('nl-BE')],
    ];

    for (const [label, value] of infoRows) {
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#555').text(label + ':', { continued: true, width: 160 });
      doc.font('Helvetica').fillColor('#111').text('  ' + value);
    }

    doc.moveDown(0.8);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#E0E0E0').stroke();
    doc.moveDown(0.8);

    // Scenarios
    doc.fillColor('#111').fontSize(16).font('Helvetica-Bold').text('Omzetscenario\'s');
    doc.moveDown(0.5);

    if (scenarios) {
      const scenarioList = [
        { label: 'Conservatief', data: scenarios.conservatief },
        { label: 'Realistisch',  data: scenarios.realistisch },
        { label: 'Optimaal',     data: scenarios.optimaal },
      ];

      for (const s of scenarioList) {
        if (!s.data) continue;
        doc.fontSize(12).font('Helvetica-Bold').fillColor('#111').text(s.label);
        doc.fontSize(10).font('Helvetica').fillColor('#444');
        doc.text(`Maandelijkse omzet: €${s.data.maand?.toLocaleString('nl-BE') || '—'}`);
        doc.text(`Bezetting: ${s.data.bezetting || '—'}   ADR: €${s.data.adr || '—'}`);
        doc.moveDown(0.4);
      }
    }

    if (jaar1Total) {
      doc.moveDown(0.3);
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#111')
        .text(`Jaar 1 omzet (totaal): €${Number(jaar1Total).toLocaleString('nl-BE')}`);
    }
    if (jaar2Total) {
      doc.fontSize(11).font('Helvetica-Bold').fillColor('#111')
        .text(`Jaar 2 prognose: €${Number(jaar2Total).toLocaleString('nl-BE')}`);
    }

    doc.moveDown(1);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#E0E0E0').stroke();
    doc.moveDown(0.6);

    // Footer
    doc.fontSize(9).fillColor('#AAA')
      .text('Dit rapport is een indicatieve analyse op basis van marktdata en AI-modellen.', { align: 'center' });
    doc.text('Omzetcijfers zijn schattingen en geen garanties. Vertrouwelijk — YourDomi.be', { align: 'center' });

    doc.end();
  });
}

// Upload file to a Monday item
async function uploadFileToItem(apiKey, itemId, filename, buffer) {
  const FormData = (await import('form-data')).default;
  const form = new FormData();

  form.append('query', `mutation($file: File!) {
    add_file_to_column(item_id: ${itemId}, column_id: "files", file: $file) { id }
  }`);
  form.append('variables[file]', buffer, { filename, contentType: 'application/pdf' });

  const res = await fetch(MONDAY_FILE_API, {
    method: 'POST',
    headers: {
      'Authorization': apiKey,
      ...form.getHeaders()
    },
    body: form
  });

  const data = await res.json();
  if (data.errors) console.error('File upload error:', data.errors);
  return data;
}

export async function createMondayLead(apiKey, payload) {
  const {
    naam, email, telefoon, adres, gemeente, type,
    kamers, slaapplaatsen, startmaand, extraInfo, datum,
    scenarios, jaar1Total, jaar2Total, reportDate
  } = payload;

  // 1. Get board ID — use env var directly (most reliable)
  const boardId = process.env.MONDAY_BOARD_ID;
  if (!boardId) throw new Error('MONDAY_BOARD_ID env var not set in Railway');

  // 2. Find "New Leads" group — must already exist in the board
  const groupData = await mondayQuery(apiKey, `
    query($boardId: [ID!]) {
      boards(ids: $boardId) { groups { id title } }
    }
  `, { boardId: [boardId] });

  const groups = groupData.boards[0]?.groups || [];
  const group = groups.find(g =>
    g.title.toLowerCase().includes('new lead') ||
    g.title.toLowerCase().includes('incoming lead') ||
    g.title.toLowerCase().includes('new - to be confirmed')
  ) || groups[0]; // fallback to first group

  if (!group) throw new Error('No group found in Ongoing Deals board');
  const groupId = group.id;

  // 3. Get existing columns
  let colMap = await getBoardColumns(apiKey, boardId);

  // 4. Ensure required columns exist
  const requiredCols = [
    { title: 'E-mail',              type: 'email' },
    { title: 'Telefoon',            type: 'phone' },
    { title: 'Adres',               type: 'text' },
    { title: 'Gemeente',            type: 'text' },
    { title: 'Slaapplaatsen',       type: 'numbers' },
    { title: 'Startmaand',          type: 'text' },
    { title: 'Extra info',          type: 'long_text' },
    { title: 'Omzet conservatief',  type: 'numbers' },
    { title: 'Omzet realistisch',   type: 'numbers' },
    { title: 'Omzet optimaal',      type: 'numbers' },
    { title: 'Jaar 1 omzet',        type: 'numbers' },
    { title: 'Jaar 2 prognose',     type: 'numbers' },
    { title: 'Bron',                type: 'text' },
    { title: 'Datum aanvraag',      type: 'date' },
    { title: 'Bestanden',           type: 'file' },
  ];

  for (const col of requiredCols) {
    if (!colMap[col.title.toLowerCase()]) {
      await ensureColumn(apiKey, boardId, col.title, col.type);
    }
  }

  // Refresh column map
  colMap = await getBoardColumns(apiKey, boardId);

  // 5. Build column values
  const today = datum
    ? new Date(datum).toISOString().split('T')[0]
    : new Date().toISOString().split('T')[0];

  const cv = {};

  const set = (title, value) => {
    const col = colMap[title.toLowerCase()];
    if (col && value !== undefined && value !== null && value !== '') cv[col.id] = value;
  };

  if (colMap['e-mail'] && email)      cv[colMap['e-mail'].id] = { email, text: email };
  if (colMap['telefoon'] && telefoon) cv[colMap['telefoon'].id] = { phone: telefoon, countryShortName: 'BE' };
  set('Adres', adres);
  set('Gemeente', gemeente);
  set('Startmaand', startmaand);
  if (colMap['extra info'] && extraInfo) cv[colMap['extra info'].id] = { text: extraInfo };
  set('Bron', 'Website — Rentabiliteitsanalyse');
  if (colMap['datum aanvraag']) cv[colMap['datum aanvraag'].id] = { date: today };
  // Lead source column (status/dropdown in Monday CRM)
  if (colMap['lead source']) cv[colMap['lead source'].id] = { label: 'Website' };
  if (colMap['lead_source']) cv[colMap['lead_source'].id] = { label: 'Website' };

  // Map existing board columns
  if (colMap['aantal kamers'] && kamers)    cv[colMap['aantal kamers'].id] = Number(kamers);
  if (colMap['slaapplaatsen'] && slaapplaatsen) cv[colMap['slaapplaatsen'].id] = Number(slaapplaatsen);
  if (colMap['type'] && type)               cv[colMap['type'].id] = { label: 'Beheer' };
  if (colMap['stage'])                      cv[colMap['stage'].id] = { label: 'New — Website Lead' };

  // Report results
  if (scenarios?.conservatief?.maand && colMap['omzet conservatief'])
    cv[colMap['omzet conservatief'].id] = Number(scenarios.conservatief.maand);
  if (scenarios?.realistisch?.maand && colMap['omzet realistisch'])
    cv[colMap['omzet realistisch'].id] = Number(scenarios.realistisch.maand);
  if (scenarios?.optimaal?.maand && colMap['omzet optimaal'])
    cv[colMap['omzet optimaal'].id] = Number(scenarios.optimaal.maand);
  if (jaar1Total && colMap['jaar 1 omzet'])
    cv[colMap['jaar 1 omzet'].id] = Number(jaar1Total);
  if (jaar2Total && colMap['jaar 2 prognose'])
    cv[colMap['jaar 2 prognose'].id] = Number(jaar2Total);

  // 6. Create item
  const itemName = `${naam || 'Onbekend'} — ${adres || gemeente || ''}`.trim();
  const created = await mondayQuery(apiKey, `
    mutation($boardId: ID!, $groupId: String!, $itemName: String!, $cv: JSON!) {
      create_item(board_id: $boardId, group_id: $groupId, item_name: $itemName, column_values: $cv) { id }
    }
  `, { boardId, groupId, itemName, cv: JSON.stringify(cv) });

  const itemId = created.create_item.id;

  // 7. Generate and attach PDF
  try {
    const pdfBuffer = await generateReportPDF(payload);
    const filename = `rapport-${(adres || gemeente || 'yourdomi').replace(/\s+/g, '-').toLowerCase()}-${today}.pdf`;
    await uploadFileToItem(apiKey, itemId, filename, pdfBuffer);
  } catch (e) {
    console.error('PDF upload failed (non-fatal):', e.message);
  }

  return itemId;
}
