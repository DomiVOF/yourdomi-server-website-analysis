import { google } from 'googleapis';
import { Readable } from 'stream';

// Upload a PDF buffer to Google Drive and return a public shareable link
// Requires env vars:
//   GOOGLE_SERVICE_ACCOUNT_JSON — full JSON key as a single-line string
//   GOOGLE_DRIVE_FOLDER_ID      — ID of the folder to upload into (optional)
export async function uploadPDFToDrive(pdfBuffer, filename) {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!keyJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var not set');

  const key = JSON.parse(keyJson);

  const auth = new google.auth.GoogleAuth({
    credentials: key,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });

  const drive = google.drive({ version: 'v3', auth });

  const folderId = process.env.GOOGLE_DRIVE_FOLDER_ID || null;

  // Upload the file
  const fileMetadata = {
    name: filename,
    ...(folderId && { parents: [folderId] }),
  };

  const media = {
    mimeType: 'application/pdf',
    body: Readable.from(pdfBuffer),
  };

  console.log('Uploading to Google Drive:', filename);
  const uploaded = await drive.files.create({
    requestBody: fileMetadata,
    media,
    fields: 'id, name, webViewLink',
    supportsAllDrives: true,   // required for Shared Drives
  });

  const fileId = uploaded.data.id;
  console.log('Drive upload success, fileId:', fileId);

  // Make the file publicly readable (anyone with link can view)
  await drive.permissions.create({
    fileId,
    requestBody: {
      role: 'reader',
      type: 'anyone',
    },
    supportsAllDrives: true,   // required for Shared Drives
  });

  const link = `https://drive.google.com/file/d/${fileId}/view`;
  console.log('Public link:', link);
  return link;
}
