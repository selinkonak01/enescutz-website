const API_URL = '';

const modal = document.getElementById('booking-modal');
const openBtn = document.getElementById('open-booking');
const closeBtn = document.getElementById('close-booking');
const form = document.getElementById('booking-form');
const dienstSelect = document.getElementById('dienst');
const datumInput = document.getElementById('datum');
const tijdslotSelect = document.getElementById('tijdslot');
const messageEl = document.getElementById('booking-message');

// Geen data uit het verleden laten kiezen
datumInput.min = new Date().toISOString().split('T')[0];

// Modal openen
openBtn.addEventListener('click', () => {
  modal.classList.remove('hidden');
  laadDiensten();
});

// Modal sluiten (kruisje of klik buiten de kaart)
closeBtn.addEventListener('click', () => modal.classList.add('hidden'));
modal.addEventListener('click', (e) => {
  if (e.target === modal) modal.classList.add('hidden');
});

// Diensten ophalen en in de dropdown zetten
async function laadDiensten() {
  const response = await fetch(`${API_URL}/api/diensten`);
  const diensten = await response.json();

  dienstSelect.innerHTML = diensten
    .map((d) => `<option value="${d.id}">${d.naam} - €${d.prijs} (${d.duur_minuten} min)</option>`)
    .join('');

  if (datumInput.value) laadBeschikbaarheid();
}

// Beschikbare tijdsloten ophalen voor gekozen dienst + datum
async function laadBeschikbaarheid() {
  const dienstId = dienstSelect.value;
  const datum = datumInput.value;
  if (!dienstId || !datum) return;

  tijdslotSelect.innerHTML = '<option value="">Laden...</option>';

  const response = await fetch(`${API_URL}/api/beschikbaarheid?datum=${datum}&dienst_id=${dienstId}`);
  const sloten = await response.json();

  if (sloten.length === 0) {
    tijdslotSelect.innerHTML = '<option value="">Geen vrije momenten deze dag</option>';
    return;
  }

  tijdslotSelect.innerHTML = sloten.map((tijd) => `<option value="${tijd}">${tijd}</option>`).join('');
}

dienstSelect.addEventListener('change', laadBeschikbaarheid);
datumInput.addEventListener('change', laadBeschikbaarheid);

// Formulier versturen
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  messageEl.textContent = '';

  const data = {
    klant_naam: document.getElementById('naam').value,
    klant_telefoon: document.getElementById('telefoon').value,
    dienst_id: dienstSelect.value,
    datum: datumInput.value,
    tijdslot: tijdslotSelect.value,
  };

  const response = await fetch(`${API_URL}/api/bookings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });

  const resultaat = await response.json();

  if (response.ok) {
    messageEl.style.color = 'lightgreen';
    messageEl.textContent = 'Je afspraak is bevestigd!';
    form.reset();
    setTimeout(() => modal.classList.add('hidden'), 1500);
  } else {
    messageEl.style.color = 'salmon';
    messageEl.textContent = resultaat.fout || 'Er ging iets mis, probeer opnieuw.';
    laadBeschikbaarheid();
  }
});
