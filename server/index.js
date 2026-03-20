const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const path = require('path');
const FormData = require('form-data');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors());
app.use(express.static(path.join(__dirname, '../public')));

const REPLICATE_KEY       = process.env.REPLICATE_KEY;
const CLOUDINARY_NAME     = process.env.CLOUDINARY_NAME;
const CLOUDINARY_PRESET   = process.env.CLOUDINARY_PRESET;
const ASTRA_ENDPOINT      = process.env.ASTRA_DB_ENDPOINT;
const ASTRA_TOKEN         = process.env.ASTRA_DB_TOKEN;
const ASTRA_KEYSPACE      = process.env.ASTRA_DB_KEYSPACE || 'iags';
const ASTRA_COLLECTION    = 'images';
const ENABLE_GOOGLE_API   = process.env.ENABLE_GOOGLE_IMAGE_API === 'true';

// ── Astra helpers ─────────────────────────────────────────
const astraBase = () =>
  `${ASTRA_ENDPOINT}/api/json/v1/${ASTRA_KEYSPACE}/${ASTRA_COLLECTION}`;

const astraHeaders = () => ({
  'Content-Type': 'application/json',
  'Token': ASTRA_TOKEN,
});

async function ensureCollection() {
  if (!ASTRA_ENDPOINT || !ASTRA_TOKEN) return;
  try {
    const res = await fetch(
      `${ASTRA_ENDPOINT}/api/json/v1/${ASTRA_KEYSPACE}`,
      {
        method: 'POST',
        headers: astraHeaders(),
        body: JSON.stringify({ createCollection: { name: ASTRA_COLLECTION } })
      }
    );
    const data = await res.json();
    console.log('Astra collection ready:', JSON.stringify(data?.status || data?.errors?.[0]));
  } catch (e) {
    console.warn('Astra ensureCollection failed:', e.message);
  }
}

// ── Health check ──────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    cloudinary: !!CLOUDINARY_NAME,
    astra: !!ASTRA_ENDPOINT,
    googleApiEnabled: ENABLE_GOOGLE_API
  });
});

// ── Config endpoint — tells frontend if Google API is enabled ──
app.get('/api/config', (req, res) => {
  res.json({ googleApiEnabled: ENABLE_GOOGLE_API });
});

// ── Concurrency limiter ───────────────────────────────────
let activeJobs = 0;
const MAX_JOBS = 3;

// ── Generate image ────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  if (activeJobs >= MAX_JOBS) {
    return res.status(429).json({ error: 'Too many requests, please wait a moment!' });
  }
  activeJobs++;
  try {
    const { prompt, allPrompts, inputImage, kidName, googleToken, googleModel } = req.body;
    if (!prompt) return res.status(400).json({ error: 'prompt is required' });

    let imageUrl;

    // ── Google Gemini / Imagen path ───────────────────────
    if (ENABLE_GOOGLE_API && googleToken && googleModel) {
      imageUrl = await generateWithGoogle(prompt, allPrompts, inputImage, googleToken, googleModel);
    } else {
      // ── Replicate / Flux path (default) ──────────────────
      imageUrl = await generateWithReplicate(prompt, allPrompts, inputImage);
    }

    res.json({ url: imageUrl });
  } catch (err) {
    console.error('Generate error:', err.message);
    res.status(500).json({ error: err.message });
  } finally {
    activeJobs--;
  }
});

// ── Google image generation ───────────────────────────────
async function generateWithGoogle(prompt, allPrompts, inputImage, googleToken, googleModel) {
  const isImagen = googleModel.startsWith('imagen');

  if (isImagen) {
    // Imagen 4 endpoint (predict)
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${googleModel}:predict`;
    const body = {
      instances: [{ prompt: buildFullPrompt(allPrompts, prompt) }],
      parameters: { sampleCount: 1 }
    };
    const res = await fetch(`${endpoint}?key=${googleToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const b64 = data.predictions?.[0]?.bytesBase64Encoded;
    if (!b64) throw new Error('No image returned from Imagen');
    // Return as data URL — frontend/Cloudinary can handle it
    return `data:image/png;base64,${b64}`;
  } else {
    // Gemini native image model (generateContent)
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${googleModel}:generateContent`;
    const parts = [{ text: buildFullPrompt(allPrompts, prompt) }];

    // If refining an existing image, include it
    if (inputImage) {
      const b64 = inputImage.replace(/^data:image\/\w+;base64,/, '');
      parts.unshift({ inlineData: { mimeType: 'image/png', data: b64 } });
    }

    const body = {
      contents: [{ parts }],
      generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
    };

    const res = await fetch(`${endpoint}?key=${googleToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);

    const parts2 = data.candidates?.[0]?.content?.parts || [];
    const imgPart = parts2.find(p => p.inlineData);
    if (!imgPart) throw new Error('No image returned from Gemini');
    return `data:image/png;base64,${imgPart.inlineData.data}`;
  }
}

function buildFullPrompt(allPrompts, newPrompt) {
  if (!allPrompts || allPrompts.length === 0) return newPrompt;
  return [...allPrompts, newPrompt].join(', ');
}

// ── Replicate / Flux generation ───────────────────────────
async function generateWithReplicate(prompt, allPrompts, inputImage) {
  const fullPrompt = inputImage
    ? [...(allPrompts || []), prompt].join(', ')
    : prompt;

  let predictionBody;

  if (inputImage) {
    // Flux Kontext Dev for refinements
    let imageData = inputImage;
    if (!inputImage.startsWith('data:')) {
      const imgRes = await fetch(inputImage);
      const buffer = await imgRes.buffer();
      imageData = `data:image/webp;base64,${buffer.toString('base64')}`;
    }
    predictionBody = {
      version: 'black-forest-labs/flux-kontext-dev',
      input: { prompt: fullPrompt, input_image: imageData }
    };
  } else {
    // Flux Schnell for initial generation
    predictionBody = {
      version: 'black-forest-labs/flux-schnell',
      input: { prompt: fullPrompt, num_outputs: 1 }
    };
  }

  const createRes = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${REPLICATE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(predictionBody)
  });
  const prediction = await createRes.json();
  if (prediction.error) throw new Error(prediction.error);

  return await pollPrediction(prediction.urls.get, 0);
}

async function pollPrediction(url, attempts) {
  if (attempts > 60) throw new Error('Generation timed out');
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

// ── Save to Cloudinary + Astra ────────────────────────────
app.post('/api/save', async (req, res) => {
  try {
    const { imageUrl, kidName, prompt } = req.body;
    if (!imageUrl || !kidName) return res.status(400).json({ error: 'imageUrl and kidName required' });

    let cloudinaryUrl = imageUrl;

    if (CLOUDINARY_NAME && CLOUDINARY_PRESET) {
      cloudinaryUrl = await uploadToCloudinary(imageUrl, kidName);
    }

    if (ASTRA_ENDPOINT && ASTRA_TOKEN) {
      await saveToAstra({ kidName, url: cloudinaryUrl, prompt, timestamp: Date.now() });
    }

    res.json({ url: cloudinaryUrl });
  } catch (err) {
    console.error('Save error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

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

async function saveToAstra(doc) {
  const res = await fetch(astraBase(), {
    method: 'POST',
    headers: astraHeaders(),
    body: JSON.stringify({ insertOne: { document: doc } })
  });
  const data = await res.json();
  if (data.errors?.length) throw new Error(data.errors[0].message);
  return data;
}

// ── Gallery ───────────────────────────────────────────────
app.get('/api/gallery', async (req, res) => {
  try {
    const { kid, page = 0 } = req.query;
    const limit = 12;
    const skip = parseInt(page) * limit;

    if (!ASTRA_ENDPOINT || !ASTRA_TOKEN) {
      return res.json({ images: [], total: 0 });
    }

    const filter = kid ? { kidName: kid } : {};

    const findRes = await fetch(astraBase(), {
      method: 'POST',
      headers: astraHeaders(),
      body: JSON.stringify({
        find: {
          filter,
          sort: { timestamp: -1 },
          options: { limit, skip }
        }
      })
    });
    const findData = await findRes.json();
    if (findData.errors?.length) throw new Error(findData.errors[0].message);

    res.json({ images: findData.data?.documents || [] });
  } catch (err) {
    console.error('Gallery error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`🎨 Art with AI running on port ${PORT}`);
  console.log(`🔧 Google Image API: ${ENABLE_GOOGLE_API ? 'ENABLED' : 'disabled'}`);
  await ensureCollection();
});
