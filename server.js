const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PI_API_KEY = process.env.PI_API_KEY;
const BASE_URL = 'https://api.minepi.com/v2';

app.post('/payments/approve', async (req, res) => {
  const { paymentId } = req.body;
  try {
    await axios.post(`${BASE_URL}/payments/${paymentId}/approve`,
      {}, { headers: { Authorization: `Key ${PI_API_KEY}` } }
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/payments/complete', async (req, res) => {
  const { paymentId, txid } = req.body;
  try {
    await axios.post(`${BASE_URL}/payments/${paymentId}/complete`,
      { txid }, { headers: { Authorization: `Key ${PI_API_KEY}` } }
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/payments/incomplete', async (req, res) => {
  res.json({ success: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Serveur sur port ${PORT}`));
