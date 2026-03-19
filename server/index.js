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

// ── FIX 1: Concurrency limiter ────────────────────────────
// Max 8 simultaneous Replicate calls — excess requests queue up
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
    queue: { active: activeRequests, waiting: queue.length }
  });
});

// ── Generate image ────────────────────────────────────────
// FIX 2: Returns Replicate URL directly — no Cloudinary upload here
// FIX 3: Receives allPrompts[] to build cumulative prompt
app.post('/api/generate', async (req, res) => {
  const { prompt, allPrompts = [], inputImage } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  if (!REPLICATE_KEY) return res.status(500).json({ error: 'REPLICATE_KEY not set on server' });

  try {
    const imageUrl = await withConcurrencyLimit(() =>
      generateImage(prompt, allPrompts, inputImage)
    );
    res.json({ imageUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── Save image ────────────────────────────────────────────
// FIX 2: Cloudinary upload happens ONLY here, when kid taps Save
app.post('/api/save', async (req, res) => {
  const { imageUrl, kidName } = req.body;
  if (!imageUrl) return res.status(400).json({ error: 'imageUrl required' });

  if (!CLOUDINARY_NAME || !CLOUDINARY_PRESET) {
    return res.json({ savedUrl: imageUrl }); // fallback: return as-is
  }
  try {
    const savedUrl = await uploadToCloudinary(imageUrl, kidName || 'unknown');
    res.json({ savedUrl });
  } catch (e) {
    console.error('Cloudinary upload failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── Core image generation ─────────────────────────────────
// FIX 3: Builds cumulative prompt from all prior prompts + current one
//        Strength reduced to 0.5 so previous image is better preserved
async function generateImage(prompt, allPrompts, inputImage) {
  const isRefinement = !!inputImage;
  let model, body;

  if (isRefinement) {
    // Full accumulated description gives Flux Dev proper context
    const cumulativePrompt = [...allPrompts, prompt].join(', ');
    model = 'black-forest-labs/flux-kontext-dev';
    body = {
      input: {
        prompt: cumulativePrompt,
        image: inputImage,
        strength: 0.75,           // was 0.75 — lower = respects prev image more
        num_inference_steps: 28,
        guidance: 3.5,
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

// ── Poll Replicate ────────────────────────────────────────
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

// ── Cloudinary upload ─────────────────────────────────────
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
app.listen(PORT, () => console.log(`🎨 Art with AI running on port ${PORT}`));
