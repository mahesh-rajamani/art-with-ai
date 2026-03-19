const express = require('express');
const cors = require('cors');
const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));
const path = require('path');
const FormData = require('form-data');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(cors());

// Serve frontend
app.use(express.static(path.join(__dirname, '../public')));

const REPLICATE_KEY   = process.env.REPLICATE_KEY;
const CLOUDINARY_NAME = process.env.CLOUDINARY_NAME;
const CLOUDINARY_PRESET = process.env.CLOUDINARY_PRESET;

// ── Health check ──────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    cloudinary: !!(CLOUDINARY_NAME && CLOUDINARY_PRESET)
  });
});

// ── Generate image ────────────────────────────────────────
app.post('/api/generate', async (req, res) => {
  const { prompt, inputImage, kidName } = req.body;
  if (!prompt) return res.status(400).json({ error: 'prompt required' });
  if (!REPLICATE_KEY) return res.status(500).json({ error: 'REPLICATE_KEY not set on server' });

  try {
    const isRefinement = !!inputImage;
    let model, body;

    if (isRefinement) {
      model = 'black-forest-labs/flux-dev';
      body = {
        input: {
          prompt,
          image: inputImage,
          strength: 0.75,
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

    // Create prediction
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
      return res.status(502).json({ error: err.detail || 'Replicate error' });
    }

    const prediction = await createRes.json();
    const imageUrl = await pollPrediction(prediction.urls.get);

    // Auto-upload to Cloudinary if configured
    let finalUrl = imageUrl;
    if (CLOUDINARY_NAME && CLOUDINARY_PRESET && kidName) {
      try {
        finalUrl = await uploadToCloudinary(imageUrl, kidName);
      } catch (e) {
        console.warn('Cloudinary upload failed, using Replicate URL:', e.message);
      }
    }

    res.json({ imageUrl: finalUrl });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

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
