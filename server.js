const express = require('express');
const cors = require('cors');
const app = express();

app.use(cors());
app.use(express.json());

app.post('/payment/approve', (req, res) => {
  res.json({ approved: true });
});

app.post('/payment/complete', (req, res) => {
  res.json({ completed: true });
});

app.get('/', (req, res) => {
  res.json({ status: 'OK' });
});

module.exports = app;
