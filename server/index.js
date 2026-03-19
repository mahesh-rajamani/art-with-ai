const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const path = require('path');
const FormData = require('form-data');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors());
app.use(express.static(path.join(__dirname, '../public')));

const REPLICATE_KEY     = process.env.REPLICATE_KEY;
const CLOUDINARY_NAME   = process.env.CLOUDINARY_NAME;
const CLOUDINARY_PRESET = process.env.CLOUDINARY_PRESET;
const ASTRA_ENDPOINT    = process.env.ASTRA_DB_ENDPOINT;  // https://xxx-region.apps.astra.datastax.com
const ASTRA_TOKEN       = process.env.ASTRA_DB_TOKEN;     // AstraCS:...
const ASTRA_KEYSPACE    = process.env.ASTRA_DB_KEYSPACE || 'iags';
const ASTRA_COLLECTION  = 'images';

// ── Astra Data API ────────────────────────────────────────
// All calls are POST with a JSON command body — no REST-style GETs
// Docs: https://docs.datastax.com/en/astra-db-serverless/api-reference/document-methods/find.html

const astraUrl = () =>
  `${ASTRA_ENDPOINT}/api/json/v1/${ASTRA_KEYSPACE}/${ASTRA_COLLECTION}`;

const astraKeyspaceUrl = () =>
  `${ASTRA_ENDPOINT}/api/json/v1/${ASTRA_KEYSPACE}`;

const astraHeaders = () => ({
  'Content-Type': 'application/json',
  'Token': ASTRA_TOKEN,
});

async function astraPost(url, command) {
  const res = await fetch(url, {
    method: 'POST',
    headers: astraHeaders(),
    body: JSON.stringify(command)
  });
  const data = await res.json();
  if (data.errors?.length) throw new Error(data.errors[0].message);
  return data;
}

// Create collection on startup (safe to call if already exists)
async function ensureCollection() {
  if (!ASTRA_ENDPOINT || !ASTRA_TOKEN) return;
  try {
    const data = await astraPost(astraKeyspaceUrl(), {
      createCollection: { name: ASTRA_COLLECTION }
    });
    console.log('Astra collection ready:', data.status?.ok === 1 ? 'created' : 'already exists');
  } catch (e) {
    // "already exists" throws — that's fine
    console.log('Astra collection already exists');
  }
}

// Insert one image record
// Document shape: { kidName, url, prompt, timestamp (ms), createdAt (ISO) }
async function astraInsert(doc) {
  return astraPost(astraUrl(), {
    insertOne: { document: doc }
  });
}

// Find paginated images for a kid, sorted by timestamp descending (newest first)
// page: 0-based page number — skip = page * 10
async function astraFind(kidName, page) {
  const command = {
    find: {
      filter: { kidName },
      sort:   { timestamp: -1 },
      options: {
        limit: 10,
        skip:  page * 10
      }
    }
  };
  const data = await astraPost(astraUrl(), command);
  return data.data?.documents || [];
}

// Count total images for a kid
async function astraCount(kidName) {
  const data = await astraPost(astraUrl(), {
    countDocuments: { filter: { kidName } }
  });
  return data.status?.count ?? 0;
}

// ── Concurrency limiter ───────────────────────────────────
let activeRequests = 0;
const MAX_CONCURRENT = 8;
const queue = [];

function withConcurrencyLimit(fn) {
  return new Promise((resolve, reject) => {
    const run = async () => {
      activeRequests++;
      try { resolve(await fn()); }
      catch (e) { reject(e); }
      finally {
        activeRequests--;
        if (queue.length) queue.shift()();
      }
    };
    if (activeRequests < MAX_CONCURRENT) run();
    else queue.push(run);
  });
}

// ── Health check ──────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    cloudinary: !!(CLOUDINARY_NAME && CLOUDINARY_PRESET),
    astra: !!(ASTRA_ENDPOINT && ASTRA_TOKEN),
    queue: { active: activeRequests, waiting: queue.length }
  });
});

// ── Generate image ────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  const { prompt, inputImage } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  if (!REPLICATE_KEY) return res.status(500).json({ error: 'REPLICATE_KEY not set on server' });

  try {
    const imageUrl = await withConcurrencyLimit(() =>
      generateImage(prompt, inputImage)
    );
    res.json({ imageUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Save image ────────────────────────────────────────────
// 1. Upload to Cloudinary (permanent URL)
// 2. Write metadata to Astra DB
app.post('/api/save', async (req, res) => {
  const { imageUrl, kidName, prompt } = req.body;
  if (!imageUrl) return res.status(400).json({ error: 'imageUrl required' });

  let savedUrl = imageUrl;

  // Step 1: Cloudinary
  if (CLOUDINARY_NAME && CLOUDINARY_PRESET) {
    try {
      savedUrl = await uploadToCloudinary(imageUrl, kidName || 'unknown');
    } catch (e) {
      console.warn('Cloudinary upload failed:', e.message);
    }
  }

  // Step 2: Astra DB — store metadata only (not the image bytes)
  if (ASTRA_ENDPOINT && ASTRA_TOKEN) {
    try {
      await astraInsert({
        kidName:   kidName   || 'unknown',
        url:       savedUrl,
        prompt:    prompt    || '',
        timestamp: Date.now(),
        createdAt: new Date().toISOString()
      });
    } catch (e) {
      // Non-fatal — kid still gets their download
      console.warn('Astra insert failed:', e.message);
    }
  }

  res.json({ savedUrl });
});

// ── Gallery — server-side paginated from Astra DB ─────────
// POST /api/gallery
// Body: { kid: string, page: number }   page is 0-based
// Returns: { items: [{url, prompt}], total: number, page: number, totalPages: number }
app.post('/api/gallery', async (req, res) => {
  const { kid, page = 0 } = req.body;
  if (!kid) return res.status(400).json({ error: 'kid required' });

  if (!ASTRA_ENDPOINT || !ASTRA_TOKEN) {
    return res.json({ items: [], total: 0, page: 0, totalPages: 0 });
  }

  try {
    // Run find + count in parallel
    const [items, total] = await Promise.all([
      astraFind(kid, page),
      astraCount(kid)
    ]);

    res.json({
      items:      items.map(d => ({ url: d.url, prompt: d.prompt })),
      total,
      page,
      totalPages: Math.ceil(total / 10)
    });
  } catch (e) {
    console.error('Astra gallery failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Core image generation ─────────────────────────────────
async function generateImage(prompt, inputImage) {
  const isRefinement = !!inputImage;
  let model, body;

  if (isRefinement) {
    const base64Image = await imageUrlToBase64(inputImage);
    model = 'black-forest-labs/flux-kontext-dev';
    body = {
      input: {
        prompt,
        input_image: base64Image,
        output_format: 'webp',
        output_quality: 90,
      }
    };
  } else {
    model = 'black-forest-labs/flux-schnell';
    body = {
      input: {
        prompt,
        num_inference_steps: 4,
        output_format: 'webp',
        output_quality: 90,
        aspect_ratio: '1:1',
      }
    };
  }

  const createRes = await fetch(`https://api.replicate.com/v1/models/${model}/predictions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${REPLICATE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body)
  });

  if (!createRes.ok) {
    const err = await createRes.json();
    throw new Error(err.detail || 'Replicate error');
  }

  const prediction = await createRes.json();
  return pollPrediction(prediction.urls.get);
}

async function imageUrlToBase64(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to fetch image: ${res.status}`);
  const buffer = await res.arrayBuffer();
  return `data:image/webp;base64,${Buffer.from(buffer).toString('base64')}`;
}

async function pollPrediction(url, attempts = 0) {
  if (attempts > 60) throw new Error('Timed out waiting for image');
  const res = await fetch(url, {
    headers: { 'Authorization': `Bearer ${REPLICATE_KEY}` }
  });
  const data = await res.json();
  if (data.status === 'succeeded') {
    const out = data.output;
    return Array.isArray(out) ? out[0] : out;
  }
  if (data.status === 'failed') throw new Error(data.error || 'Generation failed');
  await sleep(1500);
  return pollPrediction(url, attempts + 1);
}

async function uploadToCloudinary(imageUrl, kidName) {
  const form = new FormData();
  form.append('file', imageUrl);
  form.append('upload_preset', CLOUDINARY_PRESET);
  form.append('tags', `iags,${kidName.replace(/\s+/g, '_')}`);
  form.append('context', `kid=${kidName}`);
  const res = await fetch(
    `https://api.cloudinary.com/v1_1/${CLOUDINARY_NAME}/image/upload`,
    { method: 'POST', body: form }
  );
  const data = await res.json();
  if (data.error) throw new Error(data.error.message);
  return data.secure_url;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🎨 Art with AI running on port ${PORT}`);
  await ensureCollection();
});
