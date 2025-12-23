const express = require('express');
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');
const { Pool } = require('pg');
const JSZip = require('jszip');
const { Storage } = require('@google-cloud/storage');

const app = express();
const PORT = 5000;

app.use(express.json());
app.use(express.static(__dirname));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const REPLIT_SIDECAR_ENDPOINT = 'http://127.0.0.1:1106';

const storage = new Storage({
  credentials: {
    audience: 'replit',
    subject_token_type: 'access_token',
    token_url: `${REPLIT_SIDECAR_ENDPOINT}/token`,
    type: 'external_account',
    credential_source: {
      url: `${REPLIT_SIDECAR_ENDPOINT}/credential`,
      format: {
        type: 'json',
        subject_token_field_name: 'access_token',
      },
    },
    universe_domain: 'googleapis.com',
  },
  projectId: '',
});

function getPrivateObjectDir() {
  const dir = process.env.PRIVATE_OBJECT_DIR || '';
  if (!dir) {
    throw new Error('PRIVATE_OBJECT_DIR not set');
  }
  return dir;
}

function parseObjectPath(objectPath) {
  if (!objectPath.startsWith('/')) {
    objectPath = '/' + objectPath;
  }
  const parts = objectPath.split('/');
  if (parts.length < 3) {
    throw new Error('Invalid path');
  }
  return {
    bucketName: parts[1],
    objectName: parts.slice(2).join('/'),
  };
}

async function uploadToStorage(buffer, filename, contentType) {
  const privateDir = getPrivateObjectDir();
  const objectId = crypto.randomUUID();
  const ext = path.extname(filename).toLowerCase();
  const fullPath = `${privateDir}/music-files/${objectId}${ext}`;
  
  const { bucketName, objectName } = parseObjectPath(fullPath);
  const bucket = storage.bucket(bucketName);
  const file = bucket.file(objectName);
  
  await file.save(buffer, {
    contentType: contentType,
    metadata: {
      originalFilename: filename,
      uploadedAt: new Date().toISOString(),
    },
  });
  
  return fullPath;
}

async function downloadFromStorage(storagePath) {
  const { bucketName, objectName } = parseObjectPath(storagePath);
  const bucket = storage.bucket(bucketName);
  const file = bucket.file(objectName);
  
  const [exists] = await file.exists();
  if (!exists) {
    throw new Error('File not found');
  }
  
  const [buffer] = await file.download();
  const [metadata] = await file.getMetadata();
  
  return { buffer, metadata };
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 25 * 1024 * 1024,
  },
  fileFilter: (req, file, cb) => {
    const allowedMimes = [
      'application/xml',
      'text/xml',
      'application/vnd.recordare.musicxml+xml',
      'application/vnd.recordare.musicxml',
      'application/pdf',
    ];
    const allowedExts = ['.musicxml', '.mxl', '.xml', '.pdf'];
    const ext = path.extname(file.originalname).toLowerCase();
    
    if (allowedExts.includes(ext) || allowedMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Invalid file type. Only MusicXML and PDF files are allowed.'));
    }
  },
});

function computeSha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

async function validateMusicXML(buffer, filename) {
  const errors = [];
  
  try {
    const ext = path.extname(filename).toLowerCase();
    let xmlContent;
    
    if (ext === '.mxl') {
      const zip = await JSZip.loadAsync(buffer);
      const containerFile = zip.file('META-INF/container.xml');
      if (!containerFile) {
        errors.push('Invalid MXL: Missing META-INF/container.xml');
        return { valid: false, errors };
      }
      
      const containerXml = await containerFile.async('string');
      const rootfileMatch = containerXml.match(/rootfile[^>]*full-path="([^"]+)"/);
      if (!rootfileMatch) {
        errors.push('Invalid MXL: Cannot find rootfile in container.xml');
        return { valid: false, errors };
      }
      
      const rootfilePath = rootfileMatch[1];
      const rootfile = zip.file(rootfilePath);
      if (!rootfile) {
        errors.push(`Invalid MXL: Rootfile ${rootfilePath} not found in archive`);
        return { valid: false, errors };
      }
      
      xmlContent = await rootfile.async('string');
    } else {
      xmlContent = buffer.toString('utf-8');
    }
    
    if (!xmlContent.includes('<?xml') && !xmlContent.includes('<score-partwise') && !xmlContent.includes('<score-timewise')) {
      errors.push('Invalid MusicXML: Not a valid XML document');
      return { valid: false, errors };
    }
    
    if (!xmlContent.includes('<score-partwise') && !xmlContent.includes('<score-timewise')) {
      errors.push('Invalid MusicXML: Missing score-partwise or score-timewise root element');
      return { valid: false, errors };
    }
    
    if (!xmlContent.includes('<part-list>') && !xmlContent.includes('<part-list ')) {
      errors.push('Invalid MusicXML: Missing part-list element');
      return { valid: false, errors };
    }
    
    const suspiciousPatterns = [
      /<script/i,
      /javascript:/i,
      /on\w+\s*=/i,
      /<!ENTITY/i,
      /SYSTEM\s+["']/i,
    ];
    
    for (const pattern of suspiciousPatterns) {
      if (pattern.test(xmlContent)) {
        errors.push('Security warning: File contains potentially malicious content');
        return { valid: false, errors };
      }
    }
    
    return { valid: true, errors: [] };
  } catch (err) {
    errors.push(`Validation error: ${err.message}`);
    return { valid: false, errors };
  }
}

async function validatePDF(buffer) {
  const errors = [];
  
  try {
    const header = buffer.slice(0, 8).toString('ascii');
    if (!header.startsWith('%PDF-')) {
      errors.push('Invalid PDF: Missing PDF header');
      return { valid: false, errors };
    }
    
    const content = buffer.toString('binary');
    
    const dangerousPatterns = [
      /\/JavaScript/i,
      /\/JS\s/i,
      /\/OpenAction/i,
      /\/AA\s/i,
      /\/Launch/i,
      /\/EmbeddedFile/i,
      /\/RichMedia/i,
    ];
    
    for (const pattern of dangerousPatterns) {
      if (pattern.test(content)) {
        errors.push('Security warning: PDF contains potentially dangerous content (JavaScript, auto-actions, or embedded files)');
        return { valid: false, errors };
      }
    }
    
    const tail = buffer.slice(-1024).toString('ascii');
    if (!tail.includes('%%EOF')) {
      errors.push('Warning: PDF may be incomplete or corrupted (missing EOF marker)');
    }
    
    return { valid: true, errors: [] };
  } catch (err) {
    errors.push(`Validation error: ${err.message}`);
    return { valid: false, errors };
  }
}

app.post('/api/upload', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file provided' });
    }
    
    const { buffer, originalname, mimetype, size } = req.file;
    const ext = path.extname(originalname).toLowerCase();
    
    let fileType;
    let validationResult;
    
    if (['.musicxml', '.mxl', '.xml'].includes(ext)) {
      fileType = 'musicxml';
      validationResult = await validateMusicXML(buffer, originalname);
    } else if (ext === '.pdf') {
      fileType = 'pdf';
      validationResult = await validatePDF(buffer);
    } else {
      return res.status(400).json({ error: 'Unsupported file type' });
    }
    
    if (!validationResult.valid) {
      return res.status(400).json({ 
        error: 'File validation failed', 
        details: validationResult.errors 
      });
    }
    
    const sha256 = computeSha256(buffer);
    
    const storageKey = await uploadToStorage(buffer, originalname, mimetype);
    
    const result = await pool.query(`
      INSERT INTO uploads (original_filename, storage_key, file_type, mime_type, byte_size, sha256, status, validated_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'validated', NOW())
      RETURNING id, original_filename, file_type, byte_size, uploaded_at
    `, [originalname, storageKey, fileType, mimetype, size, sha256]);
    
    const uploadRecord = result.rows[0];
    
    res.json({
      success: true,
      upload: {
        id: uploadRecord.id,
        filename: uploadRecord.original_filename,
        fileType: uploadRecord.file_type,
        size: uploadRecord.byte_size,
        uploadedAt: uploadRecord.uploaded_at,
      },
    });
    
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed', details: err.message });
  }
});

app.get('/api/uploads', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, original_filename, file_type, byte_size, status, uploaded_at
      FROM uploads
      WHERE status = 'validated'
      ORDER BY uploaded_at DESC
      LIMIT 100
    `);
    
    res.json({ uploads: result.rows });
  } catch (err) {
    console.error('List uploads error:', err);
    res.status(500).json({ error: 'Failed to list uploads' });
  }
});

app.get('/api/uploads/:id', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(`
      SELECT id, original_filename, storage_key, file_type, mime_type, byte_size, status, uploaded_at
      FROM uploads
      WHERE id = $1 AND status = 'validated'
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Upload not found' });
    }
    
    res.json({ upload: result.rows[0] });
  } catch (err) {
    console.error('Get upload error:', err);
    res.status(500).json({ error: 'Failed to get upload' });
  }
});

app.get('/api/uploads/:id/download', async (req, res) => {
  try {
    const { id } = req.params;
    
    const result = await pool.query(`
      SELECT storage_key, original_filename, mime_type
      FROM uploads
      WHERE id = $1 AND status = 'validated'
    `, [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Upload not found' });
    }
    
    const { storage_key, original_filename, mime_type } = result.rows[0];
    
    const { buffer, metadata } = await downloadFromStorage(storage_key);
    
    res.set({
      'Content-Type': mime_type,
      'Content-Disposition': `attachment; filename="${original_filename}"`,
      'Content-Length': buffer.length,
    });
    
    res.send(buffer);
  } catch (err) {
    console.error('Download error:', err);
    res.status(500).json({ error: 'Failed to download file' });
  }
});

// Telemetry endpoints
app.post('/api/telemetry/event', async (req, res) => {
  try {
    const { sessionId, eventType, eventData, page } = req.body;
    
    if (!sessionId || !eventType) {
      return res.status(400).json({ error: 'sessionId and eventType are required' });
    }
    
    await pool.query(`
      INSERT INTO telemetry_events (session_id, event_type, event_data, page)
      VALUES ($1, $2, $3, $4)
    `, [sessionId, eventType, JSON.stringify(eventData || {}), page || null]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Telemetry error:', err);
    res.status(500).json({ error: 'Failed to record event' });
  }
});

app.post('/api/telemetry/session', async (req, res) => {
  try {
    const { sessionId } = req.body;
    
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    
    const result = await pool.query(`
      INSERT INTO user_sessions (session_id)
      VALUES ($1)
      ON CONFLICT (session_id) DO UPDATE SET last_seen_at = NOW()
      RETURNING is_first_visit, onboarding_completed, onboarding_step
    `, [sessionId]);
    
    const session = result.rows[0];
    
    if (session.is_first_visit) {
      await pool.query(`UPDATE user_sessions SET is_first_visit = false WHERE session_id = $1`, [sessionId]);
    }
    
    res.json({ 
      isFirstVisit: session.is_first_visit,
      onboardingCompleted: session.onboarding_completed,
      onboardingStep: session.onboarding_step
    });
  } catch (err) {
    console.error('Session error:', err);
    res.status(500).json({ error: 'Failed to get session' });
  }
});

app.post('/api/telemetry/onboarding', async (req, res) => {
  try {
    const { sessionId, step, completed } = req.body;
    
    if (!sessionId) {
      return res.status(400).json({ error: 'sessionId is required' });
    }
    
    await pool.query(`
      UPDATE user_sessions 
      SET onboarding_step = COALESCE($2, onboarding_step),
          onboarding_completed = COALESCE($3, onboarding_completed),
          last_seen_at = NOW()
      WHERE session_id = $1
    `, [sessionId, step, completed]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Onboarding error:', err);
    res.status(500).json({ error: 'Failed to update onboarding' });
  }
});

// Admin dashboard endpoint - funnel analytics
app.get('/api/admin/funnel', async (req, res) => {
  try {
    const totalSessions = await pool.query(`SELECT COUNT(*) as count FROM user_sessions`);
    
    const onboardingCompleted = await pool.query(`
      SELECT COUNT(*) as count FROM user_sessions WHERE onboarding_completed = true
    `);
    
    const onboardingSteps = await pool.query(`
      SELECT onboarding_step, COUNT(*) as count 
      FROM user_sessions 
      GROUP BY onboarding_step 
      ORDER BY onboarding_step
    `);
    
    const eventCounts = await pool.query(`
      SELECT event_type, COUNT(*) as count 
      FROM telemetry_events 
      GROUP BY event_type 
      ORDER BY count DESC
      LIMIT 20
    `);
    
    const dailyActivity = await pool.query(`
      SELECT DATE(created_at) as date, COUNT(DISTINCT session_id) as sessions, COUNT(*) as events
      FROM telemetry_events
      WHERE created_at > NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at)
      ORDER BY date DESC
    `);
    
    const buttonClicks = await pool.query(`
      SELECT event_data->>'buttonId' as button, COUNT(*) as count
      FROM telemetry_events
      WHERE event_type = 'button_click' AND event_data->>'buttonId' IS NOT NULL
      GROUP BY event_data->>'buttonId'
      ORDER BY count DESC
    `);
    
    res.json({
      totalSessions: parseInt(totalSessions.rows[0].count),
      onboardingCompleted: parseInt(onboardingCompleted.rows[0].count),
      onboardingSteps: onboardingSteps.rows,
      eventCounts: eventCounts.rows,
      dailyActivity: dailyActivity.rows,
      buttonClicks: buttonClicks.rows
    });
  } catch (err) {
    console.error('Funnel error:', err);
    res.status(500).json({ error: 'Failed to get funnel data' });
  }
});

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 25MB.' });
    }
    return res.status(400).json({ error: err.message });
  }
  if (err) {
    return res.status(400).json({ error: err.message });
  }
  next();
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`eMusicReader server running on http://0.0.0.0:${PORT}`);
});
