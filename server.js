const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json({ limit: '4mb' }));

// ===== Paiements Pi Network =====
const PI_API = 'https://api.minepi.com/v2';
const headers = () => ({
  'Authorization': `Key ${process.env.PI_API_KEY}`,
  'Content-Type': 'application/json'
});

// ===== Enregistrement des paiements (Supabase, uniquement côté serveur) =====
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_SECRET_KEY || '';

async function enregistrerPaiement(dto, statut, txid) {
  try {
    if (!SB_URL || !SB_KEY || !dto || !dto.identifier) return;
    const h = {
      'apikey': SB_KEY,
      'Content-Type': 'application/json',
      'Prefer': 'resolution=merge-duplicates,return=minimal'
    };
    if (SB_KEY.startsWith('eyJ')) h['Authorization'] = `Bearer ${SB_KEY}`;
    const meta = dto.metadata || {};
    const ligne = {
      payment_id: dto.identifier,
      montant: dto.amount,
      memo: dto.memo || null,
      produit_id: meta.productId != null ? String(meta.productId) : null,
      vendeur: meta.seller || null,
      pi_user_uid: dto.user_uid || null,
      statut: statut,
      mis_a_jour: new Date().toISOString()
    };
    if (txid) ligne.txid = txid;
    const r = await fetch(`${SB_URL}/rest/v1/paiements?on_conflict=payment_id`, {
      method: 'POST', headers: h, body: JSON.stringify(ligne)
    });
    if (!r.ok) {
      console.error('Enregistrement paiement refusé', r.status, (await r.text()).slice(0, 300));
    }
  } catch (e) {
    console.error('Enregistrement paiement impossible', e.message);
  }
}

// Contrôle sans paiement : vérifie que les variables sont lues (n'affiche jamais la clé)
app.get('/paiements/etat', (req, res) => {
  res.json({ urlConfiguree: Boolean(SB_URL), cleConfiguree: Boolean(SB_KEY) });
});

app.post('/payment/approve', async (req, res) => {
  try {
    const { paymentId } = req.body;
    const r = await fetch(`${PI_API}/payments/${paymentId}/approve`, {
      method: 'POST', headers: headers()
    });
    const data = await r.json();
    if (r.ok) await enregistrerPaiement(data, 'approuve');
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/payment/complete', async (req, res) => {
  try {
    const { paymentId, txid } = req.body;
    const r = await fetch(`${PI_API}/payments/${paymentId}/complete`, {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ txid })
    });
    const data = await r.json();
    if (r.ok) {
      await enregistrerPaiement(data, 'complete', txid || (data.transaction && data.transaction.txid));
    }
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/', (req, res) => {
  res.json({ status: 'OK' });
});

// ===== Diagnostic IA des plantes =====
const MODELES = [process.env.GEMINI_MODEL || 'gemini-3.8-flash', 'gemini-3.7-flash'];

const CONSIGNE = `Tu es un agronome expert qui conseille des producteurs au Cameroun.
Analyse la photo de plante et réponds UNIQUEMENT en JSON valide, en français, avec cette structure :
{"maladie":"nom probable du problème ou Plante saine","emoji":"un emoji",
"severite":"aucune ou faible ou moyenne ou élevée",
"description":"1 à 2 phrases",
"confiance":85,
"symptomes":["symptôme observé 1","symptôme observé 2"],
"traitements":[{"emoji":"🌿","texte":"traitement 1"},{"emoji":"💧","texte":"traitement 2"}],
"prevention":["conseil de prévention 1","conseil de prévention 2"],
"produit_recommande":"produit naturel ou accessible localement"}
Si l'image n'est pas une plante, mets maladie "Image non reconnue" et severite "aucune".
Le diagnostic est une estimation : reste prudent.`;

// Test sans photo : vérifie que la clé est chargée (n'affiche jamais la clé)
app.get('/diagnostic/etat', (req, res) => {
  res.json({ cleConfiguree: Boolean(process.env.GEMINI_KEY), modeles: MODELES });
});

app.post('/diagnostic', async (req, res) => {
  const cle = process.env.GEMINI_KEY;
  if (!cle) {
    return res.status(500).json({ erreur: "Service IA non configuré sur le serveur." });
  }
  const { image, mimeType } = req.body || {};
  if (!image || typeof image !== 'string') {
    return res.status(400).json({ erreur: "Aucune image reçue." });
  }
  if (image.length > 4000000) {
    return res.status(413).json({ erreur: "Image trop lourde. Prenez une photo plus légère." });
  }
  const type = ['image/jpeg', 'image/png', 'image/webp'].includes(mimeType) ? mimeType : 'image/jpeg';

  try {
    let reponse = null;
    for (const modele of MODELES) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${modele}:generateContent`;
      reponse = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': cle },
        body: JSON.stringify({
          contents: [{ parts: [
            { inline_data: { mime_type: type, data: image } },
            { text: CONSIGNE }
          ] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 4000, responseMimeType: 'application/json' }
        })
      });
      if (reponse.status !== 404) break; // modèle introuvable : on essaie le suivant
    }

    if (!reponse.ok) {
      const detail = await reponse.text();
      console.error('Erreur Gemini', reponse.status, detail.slice(0, 500));
      if (reponse.status === 429) {
        return res.status(429).json({ erreur: "Le service IA est très sollicité. Réessayez dans une minute." });
      }
      if (reponse.status === 401 || reponse.status === 403 || /API key/i.test(detail)) {
        return res.status(502).json({ erreur: "Le service IA refuse la clé du serveur. Contactez l'administrateur." });
      }
      return res.status(502).json({ erreur: "Le service IA est momentanément indisponible." });
    }

    const data = await reponse.json();
    const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const texte = parts.filter(p => p.text && !p.thought).map(p => p.text).join('');
    if (!texte) {
      return res.status(502).json({ erreur: "L'IA n'a pas renvoyé de réponse. Essayez avec une autre photo." });
    }
    const resultat = JSON.parse(texte.replace(/```json|```/g, '').trim());
    res.json(resultat);
  } catch (e) {
    console.error('Erreur diagnostic', e);
    res.status(500).json({ erreur: "Impossible d'analyser l'image. Réessayez avec une photo plus nette." });
  }
});

module.exports = app;
