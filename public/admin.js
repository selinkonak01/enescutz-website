const API_URL = '';

const loginSection = document.getElementById('admin-login');
const panelSection = document.getElementById('admin-panel');
const loginForm = document.getElementById('login-form');
const passwordInput = document.getElementById('password');
const loginMessage = document.getElementById('login-message');
const bookingsBody = document.getElementById('bookings-body');

const overrideForm = document.getElementById('override-form');
const overrideDatumInput = document.getElementById('override-datum');
const overrideGeslotenCheckbox = document.getElementById('override-gesloten');
const overrideUrenVelden = document.getElementById('override-uren-velden');
const overrideStartInput = document.getElementById('override-start');
const overrideEindeInput = document.getElementById('override-einde');
const overrideMessage = document.getElementById('override-message');
const overridesLijst = document.getElementById('overrides-lijst');

// Was er deze sessie al ingelogd? Dan meteen doorgaan.
const opgeslagenWachtwoord = sessionStorage.getItem('admin-wachtwoord');
if (opgeslagenWachtwoord) {
  toonPaneel(opgeslagenWachtwoord);
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  loginMessage.textContent = '';
  const wachtwoord = passwordInput.value;
  const gelukt = await toonPaneel(wachtwoord);
  if (gelukt) {
    sessionStorage.setItem('admin-wachtwoord', wachtwoord);
  } else {
    loginMessage.textContent = 'Fout wachtwoord';
  }
});

async function toonPaneel(wachtwoord) {
  const response = await fetch(`${API_URL}/api/bookings`, {
    headers: { 'x-admin-password': wachtwoord },
  });

  if (!response.ok) {
    sessionStorage.removeItem('admin-wachtwoord');
    return false;
  }

  const boekingen = await response.json();
  renderBoekingen(boekingen, wachtwoord);
  laadOverrides(wachtwoord);
  loginSection.classList.add('hidden');
  panelSection.classList.remove('hidden');
  return true;
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

// Belgisch nummer (bv. 0485 85 05 00) omzetten naar internationaal formaat voor WhatsApp
function naarWhatsappNummer(telefoon) {
  const cijfers = telefoon.replace(/\D/g, '');
  if (cijfers.startsWith('0')) {
    return '32' + cijfers.slice(1);
  }
  return cijfers;
}

function renderBoekingen(boekingen, wachtwoord) {
  bookingsBody.innerHTML = boekingen
    .map(
      (b) => `
      <tr>
        <td>${datumVoluit(b.datum)}</td>
        <td>${b.tijdslot}</td>
        <td>${b.klant_naam}</td>
        <td>${b.klant_telefoon}</td>
        <td>${b.dienst_naam}</td>
        <td class="${b.status === 'geannuleerd' ? 'status-geannuleerd' : ''}">${b.status}</td>
        <td class="acties">
          ${
            b.status === 'in afwachting'
              ? `<button class="confirm-btn" data-id="${b.id}" data-naam="${b.klant_naam}" data-telefoon="${b.klant_telefoon}" data-datum="${b.datum}" data-tijdslot="${b.tijdslot}">Bevestig</button>`
              : ''
          }
          ${
            b.status !== 'geannuleerd'
              ? `<button class="cancel-btn" data-id="${b.id}" data-naam="${b.klant_naam}" data-telefoon="${b.klant_telefoon}" data-datum="${b.datum}" data-tijdslot="${b.tijdslot}">Annuleer</button>`
              : ''
          }
          ${
            b.status !== 'geannuleerd'
              ? `<button class="agenda-btn" data-id="${b.id}">Agenda</button>`
              : ''
          }
          <button class="delete-btn" data-id="${b.id}" data-naam="${b.klant_naam}" data-datum="${b.datum}" data-tijdslot="${b.tijdslot}">Verwijder</button>
        </td>
      </tr>
    `
    )
    .join('');

  bookingsBody.querySelectorAll('.cancel-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const { id, naam, telefoon, datum, tijdslot } = btn.dataset;

      await fetch(`${API_URL}/api/bookings/${id}/annuleer`, {
        method: 'PATCH',
        headers: { 'x-admin-password': wachtwoord },
      });

      // WhatsApp-bericht klaarzetten voor de klant, Enes moet enkel nog op verzenden klikken
      const nummer = naarWhatsappNummer(telefoon);
      const bericht = `Hoi ${naam}, je afspraak op ${datumVoluit(datum)} om ${tijdslot} bij EnesCutz is helaas geannuleerd. Neem gerust contact op om een nieuwe afspraak te maken!`;
      window.open(`https://wa.me/${nummer}?text=${encodeURIComponent(bericht)}`, '_blank');

      toonPaneel(wachtwoord);
    });
  });

  bookingsBody.querySelectorAll('.confirm-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const { id, naam, telefoon, datum, tijdslot } = btn.dataset;

      await fetch(`${API_URL}/api/bookings/${id}/bevestig`, {
        method: 'PATCH',
        headers: { 'x-admin-password': wachtwoord },
      });

      // WhatsApp-bevestigingsbericht klaarzetten voor de klant, Enes moet enkel nog op verzenden klikken
      const nummer = naarWhatsappNummer(telefoon);
      const bericht = `Hoi ${naam}, je afspraak op ${datumVoluit(datum)} om ${tijdslot} bij EnesCutz is bevestigd! Tot dan.`;
      window.open(`https://wa.me/${nummer}?text=${encodeURIComponent(bericht)}`, '_blank');

      toonPaneel(wachtwoord);
    });
  });

  bookingsBody.querySelectorAll('.agenda-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const { id } = btn.dataset;

      const response = await fetch(`${API_URL}/api/bookings/${id}/ics`, {
        headers: { 'x-admin-password': wachtwoord },
      });
      if (!response.ok) return;

      // .ics-bestand openen: op Mac/iPhone opent dit automatisch de "Voeg toe aan agenda"-melding van Apple Kalender
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    });
  });

  bookingsBody.querySelectorAll('.delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const { id, naam, datum, tijdslot } = btn.dataset;

      const zeker = confirm(`Boeking van ${naam} op ${datumVoluit(datum)} om ${tijdslot} definitief verwijderen uit de lijst?`);
      if (!zeker) return;

      await fetch(`${API_URL}/api/bookings/${id}`, {
        method: 'DELETE',
        headers: { 'x-admin-password': wachtwoord },
      });

      toonPaneel(wachtwoord);
    });
  });
}

// Checkbox "volledig gesloten" toont/verbergt de uur-velden
overrideGeslotenCheckbox.addEventListener('change', () => {
  const gesloten = overrideGeslotenCheckbox.checked;
  overrideUrenVelden.classList.toggle('hidden', gesloten);
  overrideStartInput.required = !gesloten;
  overrideEindeInput.required = !gesloten;
});

// Uur-uitzonderingen ophalen en als lijst tonen, met een knop om ze te verwijderen
async function laadOverrides(wachtwoord) {
  const response = await fetch(`${API_URL}/api/overrides`, {
    headers: { 'x-admin-password': wachtwoord },
  });
  if (!response.ok) return;

  const overrides = await response.json();

  if (overrides.length === 0) {
    overridesLijst.innerHTML = '<p class="overrides-leeg">Geen uitzonderingen ingesteld.</p>';
    return;
  }

  overridesLijst.innerHTML = overrides
    .map(
      (o) => `
      <div class="override-item">
        <span class="override-datum">${datumVoluit(o.datum)}</span>
        <span class="override-uren">${o.gesloten ? 'Volledig gesloten' : `${o.start} - ${o.einde}`}</span>
        <button class="delete-btn override-delete-btn" data-datum="${o.datum}">Verwijder</button>
      </div>
    `
    )
    .join('');

  overridesLijst.querySelectorAll('.override-delete-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const { datum } = btn.dataset;
      const wachtwoord = sessionStorage.getItem('admin-wachtwoord');

      const zeker = confirm(`Uitzondering voor ${datumVoluit(datum)} verwijderen? Die dag valt dan terug op de vaste weekuren.`);
      if (!zeker) return;

      await fetch(`${API_URL}/api/overrides/${datum}`, {
        method: 'DELETE',
        headers: { 'x-admin-password': wachtwoord },
      });

      laadOverrides(wachtwoord);
    });
  });
}

// Nieuwe uur-uitzondering opslaan
overrideForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  overrideMessage.textContent = '';

  const wachtwoord = sessionStorage.getItem('admin-wachtwoord');
  const datum = overrideDatumInput.value;
  const gesloten = overrideGeslotenCheckbox.checked;

  const body = gesloten
    ? { gesloten: true }
    : { gesloten: false, start: overrideStartInput.value, einde: overrideEindeInput.value };

  const response = await fetch(`${API_URL}/api/overrides/${datum}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-admin-password': wachtwoord },
    body: JSON.stringify(body),
  });

  const resultaat = await response.json();

  if (response.ok) {
    overrideMessage.style.color = 'lightgreen';
    overrideMessage.textContent = 'Opgeslagen!';
    overrideForm.reset();
    overrideUrenVelden.classList.remove('hidden');
    overrideStartInput.required = true;
    overrideEindeInput.required = true;
    laadOverrides(wachtwoord);
  } else {
    overrideMessage.style.color = 'salmon';
    overrideMessage.textContent = resultaat.fout || 'Er ging iets mis, probeer opnieuw.';
  }
});
