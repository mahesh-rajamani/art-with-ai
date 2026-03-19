# 🎨 Art with AI — IAGS Kids App

A magical AI image creation app for kids. Built for a 2-hour event with up to 50 kids.

## How it works
- Kids enter their name → chat with AI → describe any picture → AI generates it in ~5 seconds
- Up to 10 prompt refinements per image
- Images saved to Cloudinary (optional) and retrievable after the event

---

## 🚀 Deploy to Render.com (15 minutes)

### Step 1 — Push to GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/YOUR-USERNAME/art-with-ai.git
git push -u origin main
```

### Step 2 — Create a Render Web Service

1. Go to [render.com](https://render.com) → **New → Web Service**
2. Connect your GitHub repo
3. Settings:
   - **Name:** `art-with-ai`
   - **Environment:** `Docker`
   - **Branch:** `main`
   - **Plan:** Free

### Step 3 — Add Environment Variables in Render

In your Render service → **Environment** tab, add:

| Key | Value |
|-----|-------|
| `REPLICATE_KEY` | `r8_your_replicate_token` |
| `CLOUDINARY_NAME` | `your-cloud-name` *(optional)* |
| `CLOUDINARY_PRESET` | `your-upload-preset` *(optional)* |

> ✅ These are securely stored in Render — never exposed to kids' browsers.

### Step 4 — Deploy

Click **Deploy**. In ~3 minutes your app is live at:
```
https://art-with-ai.onrender.com
```

Share this URL with kids! 🎉

---

## 💰 Cost Estimate (50 kids × 10 prompts)

| Service | Cost |
|---------|------|
| Render hosting | **Free** |
| Replicate (500 images) | **~$1.50** |
| Cloudinary storage | **Free** |
| **Total** | **~$1.50** |

---

## 📸 Retrieving images after the event

1. Log into [cloudinary.com](https://cloudinary.com)
2. Go to **Media Library**
3. Filter by tag `iags` or search by kid name
4. Download all images!

---

## 🛠 Local development

```bash
npm install
REPLICATE_KEY=r8_xxx node server/index.js
# Open http://localhost:3000
```
