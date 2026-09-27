require('dotenv').config();
// Forceer IPv4 voor uitgaande verbindingen: sommige hosting-platformen (zoals Railway)
// hebben geen werkende IPv6-uitgang, waardoor mailverzending naar Gmail anders vasthangt of faalt.
require('dns').setDefaultResultOrder('ipv4first');
const express = require('express');
const cors = require('cors');
const path = require('path');
const Database = require('better-sqlite3');
const nodemailer = require('nodemailer');
const twilio = require('twilio');

const app = express();
app.use(cors());
app.use(express.json());

// Serveer de front-end bestanden (index.html, style.css, script.js, admin.html, assets, ...)
// die in de 'public'-map staan
app.use(express.static(path.join(__dirname, 'public')));

// database.sqlite wordt automatisch aangemaakt als het nog niet bestaat
// Lokaal: gewoon een bestand hier in de map. Op Railway: DB_PATH wijst naar de permanente volume.
const dbPath = process.env.DB_PATH || 'database.sqlite';
const db = new Database(dbPath);

// E-mail transporter (gebruikt de gegevens uit .env)
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
  family: 4, // extra zekerheid: verbind altijd via IPv4
});

// SMS-client (Twilio) voor de boekingsmelding naar Enes' telefoon.
// Zolang de Twilio-gegevens nog niet zijn ingevuld in .env, blijft dit
// gewoon uitgeschakeld zonder de server te laten crashen.
const twilioIngesteld = Boolean(
  process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER && process.env.TWILIO_TO_NUMBER
);
const twilioClient = twilioIngesteld
  ? twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)
  : null;

// Beveiliging voor Enes' beheerscherm: check het wachtwoord uit .env
function checkAdminWachtwoord(req, res, next) {
  const wachtwoord = req.header('x-admin-password');
  if (wachtwoord !== process.env.ADMIN_PASSWORD) {
    return res.status(401).json({ fout: 'Ongeldig wachtwoord' });
  }
  next();
}

// Tabellen aanmaken als ze nog niet bestaan
db.exec(`
  CREATE TABLE IF NOT EXISTS services (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    naam TEXT NOT NULL,
    duur_minuten INTEGER NOT NULL,
    prijs REAL NOT NULL
  );

  CREATE TABLE IF NOT EXISTS bookings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    klant_naam TEXT NOT NULL,
    klant_telefoon TEXT NOT NULL,
    dienst_id INTEGER NOT NULL,
    datum TEXT NOT NULL,
    tijdslot TEXT NOT NULL,
    status TEXT DEFAULT 'bevestigd',
    FOREIGN KEY (dienst_id) REFERENCES services(id)
  );
`);

// Diensten invullen, maar enkel als de tabel nog leeg is
const aantalDiensten = db.prepare('SELECT COUNT(*) AS aantal FROM services').get().aantal;

if (aantalDiensten === 0) {
  const insert = db.prepare('INSERT INTO services (naam, duur_minuten, prijs) VALUES (?, ?, ?)');
  insert.run('Knipbeurt', 45, 15);
  insert.run('Baard', 15, 10);
  insert.run('Knipbeurt + Baard', 60, 20);
  console.log('Diensten toegevoegd aan de database.');
}

// ---- Helperfuncties voor tijdrekenen ----

// zet "14:30" om naar 870 (minuten sinds middernacht)
function tijdNaarMinuten(tijd) {
  const [uren, minuten] = tijd.split(':').map(Number);
  return uren * 60 + minuten;
}

// zet 870 om naar "14:30"
function minutenNaarTijd(minuten) {
  const uren = Math.floor(minuten / 60);
  const min = minuten % 60;
  return String(uren).padStart(2, '0') + ':' + String(min).padStart(2, '0');
}

// Nederlandse maandnamen om een ISO-datum ("2026-11-13") voluit te tonen ("13 november 2026")
const MAAND_NAMEN = [
  'januari', 'februari', 'maart', 'april', 'mei', 'juni',
  'juli', 'augustus', 'september', 'oktober', 'november', 'december',
];
function datumVoluit(datum) {
  const [jaar, maand, dag] = datum.split('-').map(Number);
  return `${dag} ${MAAND_NAMEN[maand - 1]} ${jaar}`;
}

// Enes is dinsdag niet bereikbaar: die dag is de zaak volledig gesloten
function isGeslotenOpDatum(datum) {
  const dag = new Date(datum + 'T00:00:00').getDay(); // 0 = zondag, 2 = dinsdag
  return dag === 2;
}

// geeft de openingsuren (in minuten) terug voor een bepaalde datum
function openingsurenVoorDatum(datum) {
  const dag = new Date(datum + 'T00:00:00').getDay(); // 0 = zondag, 6 = zaterdag
  const isWeekend = dag === 0 || dag === 6;
  return isWeekend
    ? { start: tijdNaarMinuten('09:00'), einde: tijdNaarMinuten('22:00') }
    : { start: tijdNaarMinuten('19:00'), einde: tijdNaarMinuten('22:00') };
}

// ---- Routes ----

// Alle diensten opvragen
app.get('/api/diensten', (req, res) => {
  const diensten = db.prepare('SELECT * FROM services').all();
  res.json(diensten);
});

// Beschikbare tijdsloten opvragen voor een datum + dienst
app.get('/api/beschikbaarheid', (req, res) => {
  const { datum, dienst_id } = req.query;

  if (!datum || !dienst_id) {
    return res.status(400).json({ fout: 'datum en dienst_id zijn verplicht' });
  }

  const dienst = db.prepare('SELECT * FROM services WHERE id = ?').get(dienst_id);
  if (!dienst) {
    return res.status(404).json({ fout: 'Dienst niet gevonden' });
  }

  // Dinsdag is Enes niet bereikbaar: geen enkel tijdslot beschikbaar
  if (isGeslotenOpDatum(datum)) {
    return res.json([]);
  }

  const { start, einde } = openingsurenVoorDatum(datum);
  const duur = dienst.duur_minuten;

  // bestaande boekingen die dag ophalen, met hun duur erbij
  const bezetteBoekingen = db
    .prepare(
      `SELECT bookings.tijdslot, services.duur_minuten
       FROM bookings
       JOIN services ON bookings.dienst_id = services.id
       WHERE bookings.datum = ? AND bookings.status != 'geannuleerd'`
    )
    .all(datum)
    .map((b) => {
      const startMin = tijdNaarMinuten(b.tijdslot);
      return { start: startMin, einde: startMin + b.duur_minuten };
    });

  const beschikbareSloten = [];

  for (let t = start; t + duur <= einde; t += 15) {
    const kandidaatEinde = t + duur;
    const overlapt = bezetteBoekingen.some(
      (b) => t < b.einde && b.start < kandidaatEinde
    );
    if (!overlapt) {
      beschikbareSloten.push(minutenNaarTijd(t));
    }
  }

  res.json(beschikbareSloten);
});

// Nieuwe boeking aanmaken
app.post('/api/bookings', (req, res) => {
  const { klant_naam, klant_telefoon, dienst_id, datum, tijdslot } = req.body;

  if (!klant_naam || !klant_telefoon || !dienst_id || !datum || !tijdslot) {
    return res.status(400).json({ fout: 'Alle velden zijn verplicht' });
  }

  const dienst = db.prepare('SELECT * FROM services WHERE id = ?').get(dienst_id);
  if (!dienst) {
    return res.status(404).json({ fout: 'Dienst niet gevonden' });
  }

  // Dinsdag is Enes niet bereikbaar: geen boekingen die dag toelaten
  if (isGeslotenOpDatum(datum)) {
    return res.status(400).json({ fout: 'We zijn dinsdag gesloten. Kies een andere dag.' });
  }

  // Dubbel-check: is dit tijdslot nog wel vrij? (voorkomt dubbele boekingen)
  const { start, einde } = openingsurenVoorDatum(datum);
  const duur = dienst.duur_minuten;
  const gekozenStart = tijdNaarMinuten(tijdslot);
  const gekozenEinde = gekozenStart + duur;

  if (gekozenStart < start || gekozenEinde > einde) {
    return res.status(400).json({ fout: 'Dit tijdslot valt buiten de openingsuren' });
  }

  const bezetteBoekingen = db
    .prepare(
      `SELECT bookings.tijdslot, services.duur_minuten
       FROM bookings
       JOIN services ON bookings.dienst_id = services.id
       WHERE bookings.datum = ? AND bookings.status != 'geannuleerd'`
    )
    .all(datum)
    .map((b) => {
      const s = tijdNaarMinuten(b.tijdslot);
      return { start: s, einde: s + b.duur_minuten };
    });

  const botst = bezetteBoekingen.some(
    (b) => gekozenStart < b.einde && b.start < gekozenEinde
  );

  if (botst) {
    return res.status(409).json({ fout: 'Dit tijdslot is net bezet geraakt, kies een ander moment' });
  }

  const insert = db.prepare(
    "INSERT INTO bookings (klant_naam, klant_telefoon, dienst_id, datum, tijdslot, status) VALUES (?, ?, ?, ?, ?, 'in afwachting')"
  );
  const resultaat = insert.run(klant_naam, klant_telefoon, dienst_id, datum, tijdslot);

  // Mailtje + sms sturen naar Enes, maar de klant niet laten wachten als dit faalt.
  // Dit gebeurt voor élke boeking, ongeacht of Enes op dat moment ingelogd
  // is in het beheerscherm — zo mist hij nooit een nieuwe afspraak.
  function stuurBoekingsmail(pogingenOver = 2) {
    transporter
      .sendMail({
        from: process.env.GMAIL_USER,
        to: process.env.GMAIL_USER,
        subject: `Nieuwe boeking: ${klant_naam} - ${datumVoluit(datum)} om ${tijdslot}`,
        text: `Nieuwe afspraak via de website:

Klant: ${klant_naam}
Telefoon: ${klant_telefoon}
Dienst: ${dienst.naam}
Datum: ${datumVoluit(datum)}
Tijdstip: ${tijdslot}`,
      })
      .catch((err) => {
        console.error('Mail versturen mislukt:', err.message);
        // Nog één nieuwe poging na een korte pauze, voor als het aan een tijdelijk netwerkprobleem ligt
        if (pogingenOver > 1) {
          setTimeout(() => stuurBoekingsmail(pogingenOver - 1), 5000);
        }
      });
  }
  stuurBoekingsmail();

  function stuurBoekingssms(pogingenOver = 2) {
    if (!twilioClient) {
      console.log('SMS-melding overgeslagen: Twilio is nog niet ingesteld in .env');
      return;
    }
    twilioClient.messages
      .create({
        from: process.env.TWILIO_FROM_NUMBER,
        to: process.env.TWILIO_TO_NUMBER,
        body: `${klant_naam} heeft geboekt: ${dienst.naam} op ${datumVoluit(datum)} om ${tijdslot}`,
      })
      .catch((err) => {
        console.error('Sms versturen mislukt:', err.message);
        if (pogingenOver > 1) {
          setTimeout(() => stuurBoekingssms(pogingenOver - 1), 5000);
        }
      });
  }
  stuurBoekingssms();

  res.status(201).json({ id: resultaat.lastInsertRowid, klant_naam, klant_telefoon, dienst_id, datum, tijdslot });
});

// Alle boekingen opvragen (enkel voor Enes, met wachtwoord)
app.get('/api/bookings', checkAdminWachtwoord, (req, res) => {
  const boekingen = db
    .prepare(
      `SELECT bookings.id, bookings.klant_naam, bookings.klant_telefoon, bookings.datum, bookings.tijdslot, bookings.status, services.naam AS dienst_naam
       FROM bookings
       JOIN services ON bookings.dienst_id = services.id
       ORDER BY bookings.datum, bookings.tijdslot`
    )
    .all();
  res.json(boekingen);
});

// Boeking annuleren (enkel voor Enes)
app.patch('/api/bookings/:id/annuleer', checkAdminWachtwoord, (req, res) => {
  const { id } = req.params;
  const resultaat = db.prepare("UPDATE bookings SET status = 'geannuleerd' WHERE id = ?").run(id);
  if (resultaat.changes === 0) {
    return res.status(404).json({ fout: 'Boeking niet gevonden' });
  }
  res.json({ succes: true });
});

// Boeking bevestigen (enkel voor Enes)
app.patch('/api/bookings/:id/bevestig', checkAdminWachtwoord, (req, res) => {
  const { id } = req.params;
  const resultaat = db.prepare("UPDATE bookings SET status = 'bevestigd' WHERE id = ?").run(id);
  if (resultaat.changes === 0) {
    return res.status(404).json({ fout: 'Boeking niet gevonden' });
  }
  res.json({ succes: true });
});

// Tekst veilig maken voor in een .ics-bestand (komma's, puntkomma's, backslashes en regeleinden moeten escaped worden)
function icsVeilig(tekst) {
  return String(tekst)
    .replace(/\\/g, '\\\\')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;')
    .replace(/\n/g, '\\n');
}

// .ics-kalenderbestand voor 1 boeking, om in 1 klik toe te voegen aan Apple Agenda (of een andere kalender-app)
app.get('/api/bookings/:id/ics', checkAdminWachtwoord, (req, res) => {
  const { id } = req.params;
  const boeking = db
    .prepare(
      `SELECT bookings.id, bookings.klant_naam, bookings.klant_telefoon, bookings.datum, bookings.tijdslot,
              services.naam AS dienst_naam, services.duur_minuten
       FROM bookings
       JOIN services ON bookings.dienst_id = services.id
       WHERE bookings.id = ?`
    )
    .get(id);

  if (!boeking) {
    return res.status(404).json({ fout: 'Boeking niet gevonden' });
  }

  const [jaar, maand, dag] = boeking.datum.split('-').map(Number);
  const startMinuten = tijdNaarMinuten(boeking.tijdslot);
  const eindeMinuten = startMinuten + boeking.duur_minuten;

  const pad = (n) => String(n).padStart(2, '0');

  // Belgische lokale tijd (Europe/Brussels) correct omzetten naar UTC, incl. zomer-/wintertijd.
  // Zonder dit interpreteren sommige agenda-apps de tijd verkeerd, waardoor de afspraak
  // op een fout uur (en soms zelfs de verkeerde dag) terechtkomt.
  function tzOffsetMinuten(timeZone, moment) {
    const dtf = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hour12: false,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
    const delen = dtf.formatToParts(moment).reduce((acc, d) => {
      acc[d.type] = d.value;
      return acc;
    }, {});
    const uur = delen.hour === '24' ? 0 : Number(delen.hour);
    const alsUTC = Date.UTC(Number(delen.year), Number(delen.month) - 1, Number(delen.day), uur, Number(delen.minute), Number(delen.second));
    return (alsUTC - moment.getTime()) / 60000;
  }

  function brusselsNaarUTC(minutenVanDag) {
    const u = Math.floor(minutenVanDag / 60);
    const m = minutenVanDag % 60;
    const gok = new Date(Date.UTC(jaar, maand - 1, dag, u, m));
    const offset = tzOffsetMinuten('Europe/Brussels', gok);
    return new Date(gok.getTime() - offset * 60000);
  }

  const naarIcsDatum = (minutenVanDag) => {
    const d = brusselsNaarUTC(minutenVanDag);
    return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  };

  const nu = new Date();
  const dtstamp = `${nu.getUTCFullYear()}${pad(nu.getUTCMonth() + 1)}${pad(nu.getUTCDate())}T${pad(nu.getUTCHours())}${pad(nu.getUTCMinutes())}${pad(nu.getUTCSeconds())}Z`;

  const ics = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//EnesCutz//Boekingen//NL',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:boeking-${boeking.id}@enescutz.be`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART:${naarIcsDatum(startMinuten)}`,
    `DTEND:${naarIcsDatum(eindeMinuten)}`,
    `SUMMARY:${icsVeilig(boeking.dienst_naam + ' - ' + boeking.klant_naam)}`,
    `DESCRIPTION:${icsVeilig('Telefoon: ' + boeking.klant_telefoon)}`,
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  res.setHeader('Content-Type', 'text/calendar; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="afspraak-${boeking.id}.ics"`);
  res.send(ics);
});

// Boeking definitief verwijderen uit de lijst (enkel voor Enes) - zodat de lijst niet blijft aangroeien
app.delete('/api/bookings/:id', checkAdminWachtwoord, (req, res) => {
  const { id } = req.params;
  const resultaat = db.prepare('DELETE FROM bookings WHERE id = ?').run(id);
  if (resultaat.changes === 0) {
    return res.status(404).json({ fout: 'Boeking niet gevonden' });
  }
  res.json({ succes: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server draait op http://localhost:${PORT}`);
});
