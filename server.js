import express from 'express';
import cors from 'cors';
import { createMondayLead } from './monday.js';
import { sendReportToLead } from './email.js';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors({ origin: '*' }));
app.use(express.json({ limit: '20mb' }));

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', service: 'YourDomi API' }));

// Main Claude analyze endpoint
app.post('/api/analyze', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: { message: 'ANTHROPIC_API_KEY not configured.' } });

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'web-search-2025-03-05'
      },
      body: JSON.stringify(req.body)
    });

    const text = await response.text();
    let data;
    try { data = JSON.parse(text); }
    catch { return res.status(500).json({ error: { message: `Anthropic returned non-JSON: ${text.slice(0, 200)}` } }); }

    return res.status(response.status).json(data);
  } catch (error) {
    console.error('Analyze error:', error);
    return res.status(500).json({ error: { message: error.message } });
  }
});

// Monday CRM + lead email endpoint
app.post('/api/create-monday-lead', async (req, res) => {
  const mondayKey  = process.env.MONDAY_API_KEY;
  const resendKey  = process.env.RESEND_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  // Run Monday CRM first to get itemId, then fire email
  let itemId = null;
  if (mondayKey) {
    try {
      itemId = await createMondayLead(mondayKey, anthropicKey, req.body);
      console.log('Monday lead created:', itemId);
    } catch(e) {
      console.error('Monday error:', e.message);
    }
  } else {
    console.log('MONDAY_API_KEY not set — skipping CRM');
  }

  // Respond with itemId so frontend can send PDF after render
  res.status(200).json({ ok: true, itemId });

  // Email is sent via /api/attach-report-pdf (with actual rendered PDF)
});

// Receive rendered PDF from frontend, upload to Drive, update Monday, send email with PDF
app.post('/api/attach-report-pdf', async (req, res) => {
  res.status(200).json({ ok: true }); // respond immediately

  const { itemId, pdfBase64, naam, email, payload } = req.body;
  if (!pdfBase64) { console.log('No PDF received'); return; }

  const pdfBuffer = Buffer.from(pdfBase64, 'base64');
  const mondayKey = process.env.MONDAY_API_KEY;
  const resendKey = process.env.RESEND_API_KEY;
  const boardId = process.env.MONDAY_LEADS_BOARD_ID || process.env.MONDAY_BOARD_ID;
  const today = new Date().toISOString().split('T')[0];
  const gemeente = payload?.gemeente || payload?.adres || 'yourdomi';
  const filename = `rapport-${gemeente.replace(/\s+/g, '-').toLowerCase()}-${today}.pdf`;

  // 1. Upload to Drive (non-fatal)
  let driveLink = null;
  try {
    const { uploadPDFToDrive } = await import('./drive.js');
    driveLink = await uploadPDFToDrive(pdfBuffer, filename);
    console.log('Drive link:', driveLink);
  } catch(e) {
    console.error('Drive upload failed (non-fatal):', e.message);
  }

  // 2. Update Monday item with Drive link (non-fatal)
  if (driveLink && mondayKey && itemId && boardId) {
    try {
      const { updateItemLink } = await import('./monday.js');
      await updateItemLink(mondayKey, boardId, itemId, driveLink);
      console.log('Monday link updated for item:', itemId);
    } catch(e) {
      console.error('Monday link update failed (non-fatal):', e.message);
    }
  }

  // 3. Send email with PDF — always runs regardless of Drive/Monday status
  if (resendKey && email) {
    try {
      const { sendReportToLeadWithPDF } = await import('./email.js');
      await sendReportToLeadWithPDF(resendKey, { naam, email, payload }, pdfBuffer);
    } catch(e) {
      console.error('Email with PDF failed:', e.message);
    }
  } else {
    console.log('Email skipped — resendKey:', !!resendKey, 'email:', email);
  }
});

app.listen(PORT, () => {
  console.log(`YourDomi API running on port ${PORT}`);
});
