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

// ===== Supabase (uniquement côté serveur) =====
const SB_URL = (process.env.SUPABASE_URL || '').replace(/\/+$/, '');
const SB_KEY = process.env.SUPABASE_SECRET_KEY || '';

function sbHeaders(extra) {
  const h = Object.assign({ 'apikey': SB_KEY, 'Content-Type': 'application/json' }, extra || {});
  if (SB_KEY.startsWith('eyJ')) h['Authorization'] = `Bearer ${SB_KEY}`;
  return h;
}

async function sb(path, opts) {
  opts = opts || {};
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
    method: opts.method || 'GET',
    headers: sbHeaders(opts.headers),
    body: opts.body
  });
  const texte = await r.text();
  let json = null;
  try { json = texte ? JSON.parse(texte) : null; } catch (e) {}
  return { ok: r.ok, status: r.status, json, texte };
}

async function enregistrerPaiement(dto, statut, txid) {
  try {
    if (!SB_URL || !SB_KEY || !dto || !dto.identifier) return;
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
    const r = await sb('paiements?on_conflict=payment_id', {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify(ligne)
    });
    if (!r.ok) {
      console.error('Enregistrement paiement refusé', r.status, (r.texte || '').slice(0, 300));
    }
  } catch (e) {
    console.error('Enregistrement paiement impossible', e.message);
  }
}

// ===== Commandes =====
async function lireAnnonce(id) {
  const r = await sb(`annonces?id=eq.${encodeURIComponent(id)}&select=id,titre,prix_pi,unite,stock,vendeur,vendeur_uid,vendeur_pi&limit=1`);
  if (!r.ok) throw new Error('Lecture annonce impossible');
  return (r.json && r.json[0]) || null;
}

async function creerCommande(dto, a) {
  try {
    const r = await sb('commandes?on_conflict=payment_id', {
      method: 'POST',
      headers: { 'Prefer': 'resolution=ignore-duplicates,return=minimal' },
      body: JSON.stringify({
        payment_id: dto.identifier,
        annonce_id: String(a.id),
        titre: a.titre,
        unite: a.unite || null,
        montant: dto.amount,
        acheteur_uid: dto.user_uid || null,
        vendeur_uid: a.vendeur_uid || null,
        vendeur_pi: a.vendeur_pi || null,
        vendeur_nom: a.vendeur || null,
        statut: 'en_attente_paiement'
      })
    });
    if (!r.ok) console.error('Création commande refusée', r.status, (r.texte || '').slice(0, 300));
  } catch (e) {
    console.error('Création commande impossible', e.message);
  }
}

// Passe la commande en « paiement confirmé » et diminue le stock une seule fois
async function confirmerCommande(paymentId) {
  try {
    const r = await sb(`commandes?payment_id=eq.${encodeURIComponent(paymentId)}&statut=eq.en_attente_paiement`, {
      method: 'PATCH',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({ statut: 'paiement_confirme', mis_a_jour: new Date().toISOString() })
    });
    const lignes = (r.ok && Array.isArray(r.json)) ? r.json : [];
    if (lignes.length && lignes[0].annonce_id) {
      const s = await sb('rpc/decrementer_stock', {
        method: 'POST',
        body: JSON.stringify({ p_annonce: String(lignes[0].annonce_id) })
      });
      if (!s.ok) console.error('Stock non mis à jour', s.status, (s.texte || '').slice(0, 300));
    }
  } catch (e) {
    console.error('Confirmation commande impossible', e.message);
  }
}

async function refuser(dto, raison) {
  console.error('Paiement refusé', dto && dto.identifier, raison);
  await enregistrerPaiement(dto, 'refuse');
}

// Contrôle sans paiement : vérifie que les variables sont lues (n'affiche jamais la clé)
app.get('/paiements/etat', (req, res) => {
  res.json({ urlConfiguree: Boolean(SB_URL), cleConfiguree: Boolean(SB_KEY) });
});

app.post('/payment/approve', async (req, res) => {
  try {
    const { paymentId } = req.body || {};
    if (!paymentId) return res.status(400).json({ error: 'paymentId manquant' });

    // 1) Lire le paiement chez Pi (montant et produit réels)
    const pr = await fetch(`${PI_API}/payments/${encodeURIComponent(paymentId)}`, { headers: headers() });
    const dto = await pr.json();
    if (!pr.ok) return res.status(pr.status).json(dto);
    if (dto.status && dto.status.developer_approved) return res.status(200).json(dto);

    // 2) Vérifier le produit, le prix et le stock dans Supabase
    const meta = dto.metadata || {};
    let annonce = null;
    try {
      annonce = meta.productId != null ? await lireAnnonce(meta.productId) : null;
    } catch (e) {
      return res.status(503).json({ error: 'Vérification du produit impossible. Réessayez.' });
    }
    if (!annonce) {
      await refuser(dto, 'produit introuvable');
      return res.status(400).json({ error: 'Produit introuvable.' });
    }
    const prix = Number(annonce.prix_pi);
    if (!(prix > 0) || Math.abs(Number(dto.amount) - prix) > 1e-6) {
      await refuser(dto, 'montant différent du prix');
      return res.status(400).json({ error: 'Le montant ne correspond pas au prix du produit.' });
    }
    if (annonce.stock != null && Number(annonce.stock) < 1) {
      await refuser(dto, 'stock épuisé');
      return res.status(400).json({ error: 'Produit épuisé.' });
    }
    if (annonce.vendeur_uid && annonce.vendeur_uid === dto.user_uid) {
      await refuser(dto, 'achat de sa propre annonce');
      return res.status(400).json({ error: 'Vous ne pouvez pas acheter votre propre annonce.' });
    }

    // 3) Approuver chez Pi, puis enregistrer paiement et commande
    const r = await fetch(`${PI_API}/payments/${encodeURIComponent(paymentId)}/approve`, {
      method: 'POST', headers: headers()
    });
    const data = await r.json();
    if (r.ok) {
      await enregistrerPaiement(data, 'approuve');
      await creerCommande(data, annonce);
    }
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/payment/complete', async (req, res) => {
  try {
    const { paymentId, txid } = req.body || {};
    const r = await fetch(`${PI_API}/payments/${encodeURIComponent(paymentId)}/complete`, {
      method: 'POST', headers: headers(),
      body: JSON.stringify({ txid })
    });
    const data = await r.json();
    if (r.ok) {
      await enregistrerPaiement(data, 'complete', txid || (data.transaction && data.transaction.txid));
      await confirmerCommande(paymentId);
    }
    res.status(r.status).json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Achats et ventes de la personne connectée (identité Pi vérifiée côté serveur)
app.get('/mon-activite', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return res.status(401).json({ erreur: 'Connexion Pi requise.' });
    const me = await fetch(`${PI_API}/me`, { headers: { 'Authorization': auth } });
    if (!me.ok) return res.status(401).json({ erreur: 'Connexion Pi invalide. Reconnectez-vous.' });
    const u = await me.json();
    if (!u || !u.uid) return res.status(401).json({ erreur: 'Connexion Pi invalide.' });

    const uid = encodeURIComponent(u.uid);
    const cols = 'payment_id,annonce_id,titre,unite,montant,statut,vendeur_nom,cree_le';
    const filtre = 'statut=neq.en_attente_paiement&order=cree_le.desc&limit=50';
    const achats = await sb(`commandes?acheteur_uid=eq.${uid}&select=${cols}&${filtre}`);
    const nom = encodeURIComponent(u.username || '');
    const cond = nom ? `or=(vendeur_uid.eq.${uid},vendeur_pi.eq.${nom})` : `vendeur_uid=eq.${uid}`;
    const ventes = await sb(`commandes?${cond}&select=${cols}&${filtre}`);
    if (!achats.ok || !ventes.ok) return res.status(502).json({ erreur: 'Lecture des commandes impossible.' });
    res.json({ achats: achats.json || [], ventes: ventes.json || [] });
  } catch (e) {
    console.error('Erreur mon-activite', e.message);
    res.status(500).json({ erreur: 'Impossible de charger votre activité.' });
  }
});

// ===== Profils publics (photo, nom, présentation) =====
// Contrôle sans effet : vérifie que la route existe
app.get('/profils/etat', (req, res) => {
  res.json({ ok: true, supabase: Boolean(SB_URL && SB_KEY) });
});

// Enregistre le profil de la personne connectée (identité Pi vérifiée côté serveur)
app.post('/mon-profil', async (req, res) => {
  try {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) return res.status(401).json({ erreur: 'Connexion Pi requise.' });
    const me = await fetch(`${PI_API}/me`, { headers: { 'Authorization': auth } });
    if (!me.ok) return res.status(401).json({ erreur: 'Connexion Pi invalide. Reconnectez-vous.' });
    const u = await me.json();
    if (!u || !u.uid || !u.username) return res.status(401).json({ erreur: 'Connexion Pi invalide.' });

    const b = req.body || {};
    const ligne = {
      pi_uid: u.uid,
      pi_username: u.username,
      mis_a_jour: new Date().toISOString()
    };

    if (typeof b.nom === 'string') ligne.nom = b.nom.trim().slice(0, 60) || u.username;
    if (typeof b.bio === 'string') ligne.bio = b.bio.trim().slice(0, 300);
    if (typeof b.localite === 'string') ligne.localite = b.localite.trim().slice(0, 60);
    if (typeof b.photo_url === 'string') {
      const p = b.photo_url.trim();
      // La photo doit venir de notre propre stockage Supabase
      if (p && p.indexOf(SB_URL + '/storage/v1/object/public/photos/') !== 0) {
        return res.status(400).json({ erreur: 'Photo non valide.' });
      }
      ligne.photo_url = p || null;
    }

    const r = await sb('profils?on_conflict=pi_uid', {
      method: 'POST',
      headers: { 'Prefer': 'resolution=merge-duplicates,return=representation' },
      body: JSON.stringify(ligne)
    });
    if (!r.ok) {
      console.error('Enregistrement profil refusé', r.status, (r.texte || '').slice(0, 300));
      return res.status(502).json({ erreur: 'Impossible d\'enregistrer le profil.' });
    }
    res.json({ profil: (Array.isArray(r.json) && r.json[0]) || ligne });
  } catch (e) {
    console.error('Erreur mon-profil', e.message);
    res.status(500).json({ erreur: 'Impossible d\'enregistrer le profil.' });
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
