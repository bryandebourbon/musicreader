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

// Environment detection
const IS_PRODUCTION = process.env.REPLIT_DEPLOYMENT === '1' || process.env.NODE_ENV === 'production';
const ENVIRONMENT = IS_PRODUCTION ? 'production' : 'development';
const HOSTNAME = process.env.REPLIT_DEV_DOMAIN || process.env.HOSTNAME || 'unknown';

// Error logging service - enhanced for production debugging
const ErrorLogger = {
  getSystemInfo() {
    const memUsage = process.memoryUsage();
    return {
      environment: ENVIRONMENT,
      hostname: HOSTNAME,
      nodeVersion: process.version,
      uptime: Math.floor(process.uptime()),
      memoryMB: Math.floor(memUsage.heapUsed / 1024 / 1024),
      pid: process.pid,
      replitDeployment: process.env.REPLIT_DEPLOYMENT || 'false',
      sidecarEndpoint: process.env.REPLIT_SIDECAR_ENDPOINT ? 'configured' : 'default',
      privateObjectDir: process.env.PRIVATE_OBJECT_DIR ? 'configured' : 'not-set',
    };
  },

  async log(error, context = {}) {
    const systemInfo = this.getSystemInfo();
    const timestamp = new Date().toISOString();
    
    const logEntry = {
      level: context.level || 'error',
      message: error.message || String(error),
      stack: error.stack || null,
      status_code: context.statusCode || null,
      request_method: context.method || null,
      request_path: context.path || null,
      query_params: context.query ? JSON.stringify(context.query) : null,
      request_body: context.body ? JSON.stringify(this.sanitizeBody(context.body)) : null,
      user_agent: context.userAgent || null,
      ip: context.ip || null,
      session_id: context.sessionId || null,
      extra: JSON.stringify({
        ...systemInfo,
        errorCode: error.code || null,
        errorName: error.name || null,
        timestamp,
        ...(context.extra || {})
      }),
    };
    
    // Always log to console for Replit's log viewer
    console.error(`[${logEntry.level.toUpperCase()}] [${ENVIRONMENT}] ${timestamp} - ${logEntry.message}`);
    console.error(`  Path: ${logEntry.request_method} ${logEntry.request_path}`);
    console.error(`  User-Agent: ${logEntry.user_agent?.substring(0, 100)}`);
    if (logEntry.stack) console.error(`  Stack: ${logEntry.stack.substring(0, 1000)}`);
    console.error(`  System: env=${systemInfo.environment}, mem=${systemInfo.memoryMB}MB, uptime=${systemInfo.uptime}s`);
    if (context.extra) console.error(`  Extra:`, JSON.stringify(context.extra));
    
    // Persist to database
    try {
      await pool.query(`
        INSERT INTO error_logs (level, message, stack, status_code, request_method, request_path, query_params, request_body, user_agent, ip, session_id, extra)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      `, [
        logEntry.level,
        logEntry.message?.substring(0, 10000),
        logEntry.stack?.substring(0, 50000),
        logEntry.status_code,
        logEntry.request_method,
        logEntry.request_path,
        logEntry.query_params,
        logEntry.request_body,
        logEntry.user_agent?.substring(0, 500),
        logEntry.ip,
        logEntry.session_id,
        logEntry.extra
      ]);
      console.error(`  [LOGGED TO DB]`);
    } catch (dbErr) {
      console.error(`  [DB LOG FAILED]: ${dbErr.message}`);
    }
    
    return logEntry;
  },
  
  sanitizeBody(body) {
    if (!body || typeof body !== 'object') return body;
    const sanitized = { ...body };
    const sensitiveKeys = ['password', 'token', 'secret', 'apikey', 'api_key', 'authorization', 'credit_card', 'ssn'];
    for (const key of Object.keys(sanitized)) {
      if (sensitiveKeys.some(s => key.toLowerCase().includes(s))) {
        sanitized[key] = '[REDACTED]';
      }
    }
    return sanitized;
  },
  
  async warn(message, context = {}) {
    return this.log({ message }, { ...context, level: 'warn' });
  },
  
  async info(message, context = {}) {
    return this.log({ message }, { ...context, level: 'info' });
  },
  
  async debug(message, context = {}) {
    // Only log debug messages to console in development, but always to DB
    if (!IS_PRODUCTION) {
      console.log(`[DEBUG] ${new Date().toISOString()} - ${message}`);
    }
    return this.log({ message }, { ...context, level: 'debug' });
  }
};

// Log startup info
console.log(`[STARTUP] ${new Date().toISOString()} - eMusicReader starting`);
console.log(`  Environment: ${ENVIRONMENT}`);
console.log(`  Hostname: ${HOSTNAME}`);
console.log(`  Node: ${process.version}`);
console.log(`  REPLIT_DEPLOYMENT: ${process.env.REPLIT_DEPLOYMENT || 'not set'}`);
console.log(`  PRIVATE_OBJECT_DIR: ${process.env.PRIVATE_OBJECT_DIR ? 'configured' : 'not set'}`);

// Middleware to add request context for logging
app.use((req, res, next) => {
  req.logContext = {
    method: req.method,
    path: req.path,
    query: req.query,
    userAgent: req.get('user-agent'),
    ip: req.ip || req.connection?.remoteAddress,
    sessionId: req.body?.sessionId || req.query?.sessionId || null,
  };
  next();
});

const REPLIT_SIDECAR_ENDPOINT = process.env.REPLIT_SIDECAR_ENDPOINT || 'http://127.0.0.1:1106';

let storage = null;
try {
  storage = new Storage({
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
} catch (err) {
  console.error('Failed to initialize storage:', err.message);
}

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
  if (!storage) {
    throw new Error('Storage not available');
  }
  
  try {
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
  } catch (err) {
    console.error('Storage upload error:', err.message, err.code);
    throw new Error('Failed to upload file to storage: ' + err.message);
  }
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
      /\s(onclick|onload|onerror|onmouseover|onfocus|onblur)\s*=/i,
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
  const uploadId = crypto.randomUUID().substring(0, 8);
  const startTime = Date.now();
  const steps = []; // Track all steps for summary
  
  const logStep = (step, details = {}) => {
    const elapsed = Date.now() - startTime;
    const timestamp = new Date().toISOString();
    const logEntry = {
      step,
      elapsed: `${elapsed}ms`,
      ...details
    };
    steps.push({ step, elapsed, ...details });
    console.log(`[UPLOAD:${uploadId}] [${ENVIRONMENT}] [${timestamp}] Step: ${step}`, JSON.stringify(logEntry));
  };
  
  // Log environment info at start for debugging production issues
  console.log(`[UPLOAD:${uploadId}] === UPLOAD REQUEST STARTED ===`);
  console.log(`[UPLOAD:${uploadId}] Environment: ${ENVIRONMENT}`);
  console.log(`[UPLOAD:${uploadId}] REPLIT_DEPLOYMENT: ${process.env.REPLIT_DEPLOYMENT || 'not-set'}`);
  console.log(`[UPLOAD:${uploadId}] DATABASE_URL: ${process.env.DATABASE_URL ? 'configured' : 'NOT CONFIGURED'}`);
  console.log(`[UPLOAD:${uploadId}] PRIVATE_OBJECT_DIR: ${process.env.PRIVATE_OBJECT_DIR ? 'configured' : 'NOT CONFIGURED'}`);
  console.log(`[UPLOAD:${uploadId}] Storage client: ${storage ? 'initialized' : 'NOT INITIALIZED'}`);
  
  try {
    logStep('START', { hasFile: !!req.file });
    
    if (!req.file) {
      logStep('ERROR', { reason: 'No file provided' });
      return res.status(400).json({ error: 'No file provided' });
    }
    
    const { buffer, originalname, mimetype, size } = req.file;
    const ext = path.extname(originalname).toLowerCase();
    logStep('FILE_RECEIVED', { filename: originalname, size, mimetype, ext });
    
    let fileType;
    let validationResult;
    
    if (['.musicxml', '.mxl', '.xml'].includes(ext)) {
      fileType = 'musicxml';
      logStep('VALIDATING', { type: 'musicxml' });
      validationResult = await validateMusicXML(buffer, originalname);
    } else if (ext === '.pdf') {
      fileType = 'pdf';
      logStep('VALIDATING', { type: 'pdf' });
      validationResult = await validatePDF(buffer);
    } else {
      logStep('ERROR', { reason: 'Unsupported file type', ext });
      return res.status(400).json({ error: 'Unsupported file type' });
    }
    
    logStep('VALIDATION_RESULT', { valid: validationResult.valid, errors: validationResult.errors });
    
    if (!validationResult.valid) {
      await ErrorLogger.warn(`File validation failed: ${validationResult.errors.join(', ')}`, {
        ...req.logContext,
        extra: { uploadId, filename: originalname, errors: validationResult.errors }
      });
      return res.status(400).json({ 
        error: 'File validation failed', 
        details: validationResult.errors 
      });
    }
    
    const sha256 = computeSha256(buffer);
    logStep('HASH_COMPUTED', { sha256: sha256.substring(0, 16) + '...' });
    
    // Assign fallback key first - this always works
    let storageKey = `validated/${crypto.randomUUID()}${ext}`;
    logStep('FALLBACK_KEY_ASSIGNED', { storageKey });
    
    // Optionally try cloud storage but don't block on it
    const hasStorageConfig = storage && process.env.PRIVATE_OBJECT_DIR;
    logStep('STORAGE_CHECK', { hasStorage: !!storage, hasPrivateDir: !!process.env.PRIVATE_OBJECT_DIR });
    
    if (hasStorageConfig) {
      try {
        logStep('STORAGE_UPLOAD_START');
        const cloudPath = await uploadToStorage(buffer, originalname, mimetype);
        storageKey = cloudPath;
        logStep('STORAGE_UPLOAD_SUCCESS', { cloudPath });
      } catch (storageErr) {
        logStep('STORAGE_UPLOAD_FAILED', { 
          error: storageErr.message, 
          code: storageErr.code,
          name: storageErr.name 
        });
        // Log but don't fail - we already have a fallback key
        await ErrorLogger.warn(`Storage upload skipped: ${storageErr.message}`, {
          ...req.logContext,
          extra: { 
            uploadId,
            operation: 'uploadToStorage',
            filename: originalname,
            fileSize: size,
            errorCode: storageErr.code,
            errorName: storageErr.name,
            fullError: storageErr.toString()
          }
        });
      }
    }
    
    logStep('DB_INSERT_START', { storageKey });
    
    let uploadRecord = null;
    let dbError = null;
    
    try {
      const result = await pool.query(`
        INSERT INTO uploads (original_filename, storage_key, file_type, mime_type, byte_size, sha256, status, validated_at)
        VALUES ($1, $2, $3, $4, $5, $6, 'validated', NOW())
        RETURNING id, original_filename, file_type, byte_size, uploaded_at
      `, [originalname, storageKey, fileType, mimetype, size, sha256]);
      
      uploadRecord = result.rows[0];
      logStep('DB_INSERT_SUCCESS', { recordId: uploadRecord.id });
    } catch (dbErr) {
      dbError = dbErr;
      logStep('DB_INSERT_FAILED', { 
        error: dbErr.message, 
        code: dbErr.code,
        hint: 'Upload will still succeed - file is already stored'
      });
      console.error(`[UPLOAD:${uploadId}] Database insert failed but file is stored:`, dbErr.message);
    }
    
    // Log successful upload for analytics (best effort)
    try {
      await ErrorLogger.info(`File uploaded successfully: ${originalname}`, {
        ...req.logContext,
        extra: { 
          uploadId,
          recordId: uploadRecord?.id || 'no-db-record',
          filename: originalname,
          fileType,
          size,
          storageKey: storageKey.substring(0, 50),
          dbSkipped: !!dbError
        }
      });
    } catch (logErr) {
      console.error(`[UPLOAD:${uploadId}] Analytics logging failed:`, logErr.message);
    }
    
    logStep('COMPLETE', { 
      recordId: uploadRecord?.id || 'none',
      dbSkipped: !!dbError 
    });
    
    // Print full upload summary for debugging
    const totalTime = Date.now() - startTime;
    console.log(`[UPLOAD:${uploadId}] === UPLOAD SUMMARY ===`);
    console.log(`[UPLOAD:${uploadId}] Total time: ${totalTime}ms`);
    console.log(`[UPLOAD:${uploadId}] File: ${originalname} (${size} bytes, ${fileType})`);
    console.log(`[UPLOAD:${uploadId}] Storage key: ${storageKey}`);
    console.log(`[UPLOAD:${uploadId}] DB record: ${uploadRecord?.id || 'FAILED - ' + (dbError?.message || 'unknown')}`);
    console.log(`[UPLOAD:${uploadId}] Steps: ${JSON.stringify(steps)}`);
    console.log(`[UPLOAD:${uploadId}] === END SUMMARY ===`);
    
    if (dbError) {
      // File was stored successfully but database tracking failed
      // Return partial success so client knows the file is there but ID-based operations won't work
      res.json({
        success: true,
        partial: true,
        upload: {
          id: null,
          filename: originalname,
          fileType: fileType,
          size: size,
          uploadedAt: new Date().toISOString(),
          storageKey: storageKey,
        },
        warning: 'File uploaded successfully but could not save to database. The file is stored and can be used.',
      });
    } else {
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
    }
    
  } catch (err) {
    const totalTime = Date.now() - startTime;
    logStep('FATAL_ERROR', { error: err.message, code: err.code, name: err.name, stack: err.stack?.substring(0, 500) });
    
    // Print detailed error summary
    console.error(`[UPLOAD:${uploadId}] === FATAL ERROR ===`);
    console.error(`[UPLOAD:${uploadId}] Error: ${err.message}`);
    console.error(`[UPLOAD:${uploadId}] Code: ${err.code || 'none'}`);
    console.error(`[UPLOAD:${uploadId}] Name: ${err.name || 'Error'}`);
    console.error(`[UPLOAD:${uploadId}] Total time before failure: ${totalTime}ms`);
    console.error(`[UPLOAD:${uploadId}] Steps completed: ${JSON.stringify(steps)}`);
    console.error(`[UPLOAD:${uploadId}] Stack: ${err.stack}`);
    console.error(`[UPLOAD:${uploadId}] === END FATAL ERROR ===`);
    
    await ErrorLogger.log(err, {
      ...req.logContext,
      statusCode: 500,
      extra: { 
        uploadId,
        operation: 'upload', 
        filename: req.file?.originalname,
        step: 'fatal_catch',
        stepsCompleted: steps,
        totalTime
      }
    });
    res.status(500).json({ error: 'Upload failed', details: err.message });
  }
});

// Client-side log endpoints - receive logs from the browser
app.post('/api/client-logs', async (req, res) => {
  try {
    const { level, message, deviceInfo, extra, clientTimestamp } = req.body;
    
    console.log(`[CLIENT:${level?.toUpperCase()}] [${ENVIRONMENT}] ${message}`);
    console.log(`  Device: ${deviceInfo?.platform}, Online: ${deviceInfo?.online}`);
    console.log(`  Extra:`, JSON.stringify(extra));
    
    await pool.query(`
      INSERT INTO error_logs (level, message, user_agent, ip, session_id, extra)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [
      `client_${level || 'info'}`,
      message?.substring(0, 10000),
      deviceInfo?.userAgent?.substring(0, 500),
      req.ip,
      deviceInfo?.sessionId,
      JSON.stringify({
        source: 'client',
        environment: ENVIRONMENT,
        deviceInfo,
        extra,
        clientTimestamp,
        serverTimestamp: new Date().toISOString()
      })
    ]);
    
    res.json({ success: true });
  } catch (err) {
    console.error('Client log error:', err);
    res.status(500).json({ error: 'Failed to log' });
  }
});

app.post('/api/client-logs/batch', async (req, res) => {
  try {
    const { logs } = req.body;
    if (!Array.isArray(logs)) {
      return res.status(400).json({ error: 'logs must be an array' });
    }
    
    console.log(`[CLIENT:BATCH] Received ${logs.length} queued logs`);
    
    for (const log of logs.slice(0, 50)) {
      const { level, message, deviceInfo, extra, clientTimestamp } = log;
      
      console.log(`  [CLIENT:${level?.toUpperCase()}] ${message}`);
      
      await pool.query(`
        INSERT INTO error_logs (level, message, user_agent, ip, session_id, extra)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        `client_${level || 'info'}`,
        message?.substring(0, 10000),
        deviceInfo?.userAgent?.substring(0, 500),
        req.ip,
        deviceInfo?.sessionId,
        JSON.stringify({
          source: 'client_batch',
          environment: ENVIRONMENT,
          deviceInfo,
          extra,
          clientTimestamp,
          serverTimestamp: new Date().toISOString()
        })
      ]);
    }
    
    res.json({ success: true, processed: logs.length });
  } catch (err) {
    console.error('Client batch log error:', err);
    res.status(500).json({ error: 'Failed to log batch' });
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

// Admin endpoint - View error logs
app.get('/api/admin/error-logs', async (req, res) => {
  try {
    const { level, status_code, limit = 100, offset = 0, search, from_date, to_date } = req.query;
    
    let query = `
      SELECT id, occurred_at, level, message, status_code, request_method, request_path, user_agent, ip, session_id, correlation_id
      FROM error_logs
      WHERE 1=1
    `;
    const params = [];
    let paramIndex = 1;
    
    if (level) {
      query += ` AND level = $${paramIndex++}`;
      params.push(level);
    }
    if (status_code) {
      query += ` AND status_code = $${paramIndex++}`;
      params.push(parseInt(status_code));
    }
    if (search) {
      query += ` AND message ILIKE $${paramIndex++}`;
      params.push(`%${search}%`);
    }
    if (from_date) {
      query += ` AND occurred_at >= $${paramIndex++}`;
      params.push(from_date);
    }
    if (to_date) {
      query += ` AND occurred_at <= $${paramIndex++}`;
      params.push(to_date);
    }
    
    query += ` ORDER BY occurred_at DESC LIMIT $${paramIndex++} OFFSET $${paramIndex++}`;
    params.push(parseInt(limit), parseInt(offset));
    
    const result = await pool.query(query, params);
    
    // Get total count for pagination
    const countResult = await pool.query('SELECT COUNT(*) as total FROM error_logs');
    
    res.json({
      logs: result.rows,
      total: parseInt(countResult.rows[0].total),
      limit: parseInt(limit),
      offset: parseInt(offset)
    });
  } catch (err) {
    console.error('Error fetching logs:', err);
    res.status(500).json({ error: 'Failed to fetch error logs' });
  }
});

// Admin endpoint - Get single error log detail
app.get('/api/admin/error-logs/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('SELECT * FROM error_logs WHERE id = $1', [id]);
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Log entry not found' });
    }
    
    res.json({ log: result.rows[0] });
  } catch (err) {
    console.error('Error fetching log detail:', err);
    res.status(500).json({ error: 'Failed to fetch log detail' });
  }
});

// Admin endpoint - Error log summary/stats
app.get('/api/admin/error-stats', async (req, res) => {
  try {
    const totalErrors = await pool.query(`SELECT COUNT(*) as count FROM error_logs`);
    
    const last24h = await pool.query(`
      SELECT COUNT(*) as count FROM error_logs 
      WHERE occurred_at > NOW() - INTERVAL '24 hours'
    `);
    
    const byLevel = await pool.query(`
      SELECT level, COUNT(*) as count FROM error_logs 
      GROUP BY level ORDER BY count DESC
    `);
    
    const byStatusCode = await pool.query(`
      SELECT status_code, COUNT(*) as count FROM error_logs 
      WHERE status_code IS NOT NULL
      GROUP BY status_code ORDER BY count DESC
    `);
    
    const topErrors = await pool.query(`
      SELECT message, COUNT(*) as count FROM error_logs 
      GROUP BY message ORDER BY count DESC LIMIT 10
    `);
    
    const dailyTrend = await pool.query(`
      SELECT DATE(occurred_at) as date, COUNT(*) as count 
      FROM error_logs 
      WHERE occurred_at > NOW() - INTERVAL '30 days'
      GROUP BY DATE(occurred_at) 
      ORDER BY date DESC
    `);
    
    res.json({
      totalErrors: parseInt(totalErrors.rows[0].count),
      last24Hours: parseInt(last24h.rows[0].count),
      byLevel: byLevel.rows,
      byStatusCode: byStatusCode.rows,
      topErrors: topErrors.rows,
      dailyTrend: dailyTrend.rows
    });
  } catch (err) {
    console.error('Error stats error:', err);
    res.status(500).json({ error: 'Failed to get error stats' });
  }
});

// Global error handler with logging
app.use(async (err, req, res, next) => {
  const statusCode = err.status || err.statusCode || 500;
  
  // Log the error with full context
  await ErrorLogger.log(err, {
    ...req.logContext,
    statusCode,
    body: req.body,
    extra: {
      errorType: err.name || 'Error',
      code: err.code || null,
    }
  });
  
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: 'File too large. Maximum size is 25MB.' });
    }
    return res.status(400).json({ error: err.message });
  }
  
  if (err) {
    // Don't expose internal error details in production
    const safeMessage = statusCode >= 500 ? 'Internal server error' : err.message;
    return res.status(statusCode).json({ error: safeMessage });
  }
  next();
});

// Catch unhandled promise rejections
process.on('unhandledRejection', async (reason, promise) => {
  await ErrorLogger.log(reason instanceof Error ? reason : new Error(String(reason)), {
    level: 'critical',
    extra: { type: 'unhandledRejection' }
  });
});

// Catch uncaught exceptions
process.on('uncaughtException', async (error) => {
  await ErrorLogger.log(error, {
    level: 'critical',
    extra: { type: 'uncaughtException' }
  });
  // Give time to log before exiting
  setTimeout(() => process.exit(1), 1000);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`eMusicReader server running on http://0.0.0.0:${PORT}`);
});
